import pool from './db'
import { resolveCompany, rundownToRawFields, type CompanyRundown } from './companies-house'
import { extractSignatureFields, ALL_SIGNATURE_FIELDS, type SignatureField } from './signature'

// When a lead becomes INTERESTED we enrich it from our OWN contacts database — the
// full Apollo/PlusVibe record (linkedin, industry, location, address, seniority...).
// We only push a thin field set to Bison, so esp_leads.raw starts sparse; the rich
// data lives in `contacts` (same Postgres DB) under workspace_id='ottaly-global',
// keyed by email. This backfills it into esp_leads (company_name column + raw keys
// the leads panel reads: raw->>'job_title' | 'industry' | 'city' | 'address_line' |
// 'linkedin_person_url' | 'linkedin_company_url' | 'phone_number' | 'company_website').

const GLOBAL_WS = process.env.CONTACTS_WORKSPACE || 'ottaly-global'

interface ContactRow {
  first_name: string | null; last_name: string | null
  job_title: string | null; seniority: string | null; department: string | null
  industry: string | null
  linkedin_url: string | null; company_linkedin_url: string | null
  phone: string | null; company_phone: string | null
  company_name: string | null; company_domain: string | null
  city: string | null; state: string | null; country: string | null
  company_address: string | null; company_city: string | null
  num_employees: string | null
}

// Map a contacts row → the esp_leads.raw key names the dashboard/panel render.
function toRawFields(c: ContactRow): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (k: string, v: string | null | undefined) => { const t = (v ?? '').toString().trim(); if (t) out[k] = t }
  put('job_title', c.job_title)
  put('department', c.department)
  put('industry', c.industry)
  put('phone_number', c.phone || c.company_phone)
  put('linkedin_person_url', c.linkedin_url)
  put('linkedin_company_url', c.company_linkedin_url)
  if (c.company_domain) put('company_website', /^https?:/i.test(c.company_domain) ? c.company_domain : `https://${c.company_domain}`)
  put('city', c.city || c.company_city)
  put('state', c.state)
  put('country', c.country)
  // The leads panel renders raw->>'address_line'.
  put('address_line', c.company_address)
  put('num_employees', c.num_employees)
  put('seniority', c.seniority)
  return out
}

// Enrich one lead (by id+workspace) from contacts. Returns the fields it applied, or
// null if no contact was found. Merges into raw (won't blank existing keys) and sets
// company_name from the contact when esp_leads.company_name is empty. Best-effort.
export async function enrichLeadFromContacts(
  leadId: string, workspaceId: string, email: string
): Promise<Record<string, string> | null> {
  const e = (email ?? '').trim().toLowerCase()
  if (!e || !leadId) return null
  try {
    const r = await pool.query(
      `SELECT first_name, last_name, job_title, seniority, department, industry,
              linkedin_url, company_linkedin_url, phone, company_phone,
              company_name, company_domain, city, state, country,
              company_address, company_city, num_employees
         FROM contacts
        WHERE lower(email) = $1 AND workspace_id = $2
        LIMIT 1`,
      [e, GLOBAL_WS]
    )
    if (!r.rows.length) return null
    const c = r.rows[0] as ContactRow
    const raw = toRawFields(c)

    if (Object.keys(raw).length) {
      // raw || found = found wins for overlapping keys, but only keys we actually have.
      await pool.query(
        `UPDATE esp_leads SET raw = COALESCE(raw, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3`,
        [JSON.stringify(raw), leadId, workspaceId]
      )
    }
    // Fill the company_name column only if it's currently empty (don't clobber a
    // signature-derived value). The contact's company_name is the real prospect company.
    if (c.company_name && c.company_name.trim()) {
      await pool.query(
        `UPDATE esp_leads SET company_name = COALESCE(NULLIF(btrim(company_name), ''), $1), updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3`,
        [c.company_name.trim(), leadId, workspaceId]
      )
    }
    return raw
  } catch (err) {
    console.error('[enrichLeadFromContacts] failed:', err)
    return null
  }
}

// ── Companies House enrichment ────────────────────────────────────────────────
// Runs at reply intake so the verified company rundown is ready in the unibox
// BEFORE the admin decides Lead vs Info. Resolves the company NUMBER-FIRST (a
// number we already hold in contacts), else a confident name match — never a
// guess (resolveCompany returns null when uncertain, and we record that so the
// reply can be flagged for manual matching). Idempotent per unibox row; cheap to
// re-run (skips when already matched). Best-effort: callers never await its
// result for control flow.

// Hints to resolve the company for an email. We pull a CH company number from
// contacts if that column exists (number-first = a certain match), and always
// the company name as the search fallback. Column presence is detected once via
// information_schema so this works whether or not contacts carries ch_company_number.
let contactsHasChNumber: boolean | null = null
async function detectChNumberColumn(): Promise<boolean> {
  if (contactsHasChNumber !== null) return contactsHasChNumber
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'contacts' AND column_name = 'ch_company_number' LIMIT 1`
  ).catch(() => ({ rows: [] as unknown[] }))
  contactsHasChNumber = r.rows.length > 0
  return contactsHasChNumber
}

async function companyHintsForEmail(email: string): Promise<{ chNumber: string | null; companyName: string | null }> {
  const e = email.trim().toLowerCase()
  if (!e) return { chNumber: null, companyName: null }
  const hasCh = await detectChNumberColumn()
  const cols = hasCh ? 'ch_company_number, company_name' : 'NULL AS ch_company_number, company_name'
  const r = await pool.query(
    `SELECT ${cols} FROM contacts WHERE lower(email) = $1 AND workspace_id = $2 LIMIT 1`,
    [e, GLOBAL_WS]
  ).catch(() => ({ rows: [] as { ch_company_number: string | null; company_name: string | null }[] }))
  const row = r.rows[0]
  return {
    chNumber: row?.ch_company_number?.trim() || null,
    companyName: row?.company_name?.trim() || null,
  }
}

// Enrich one unibox reply with Companies House data. Stores the full rundown +
// match state on the row. Returns the rundown (or null when no confident match).
export async function enrichReplyWithCH(
  uniboxReplyId: string,
  opts: { email?: string | null; companyName?: string | null }
): Promise<CompanyRundown | null> {
  try {
    // Skip if we've already resolved a company for this reply (idempotent).
    const cur = await pool.query(
      `SELECT enrich_state FROM unibox_replies WHERE id = $1`, [uniboxReplyId]
    )
    if (cur.rows[0]?.enrich_state === 'matched') return null

    const email = (opts.email ?? '').trim().toLowerCase()
    const hints = email ? await companyHintsForEmail(email) : { chNumber: null, companyName: null }
    const companyName = hints.companyName || (opts.companyName ?? '').trim() || null

    const { rundown, reason } = await resolveCompany({
      knownNumber: hints.chNumber,
      companyName,
    })

    if (!rundown) {
      // 'no_api_key' isn't a real miss — leave enrich_state null so it retries
      // once a key is configured. Everything else = tried, no confident match.
      if (reason !== 'no_api_key') {
        await pool.query(
          `UPDATE unibox_replies SET enrich_state = 'unmatched', updated_at = NOW() WHERE id = $1`,
          [uniboxReplyId]
        )
      }
      return null
    }

    await pool.query(
      `UPDATE unibox_replies
          SET ch_company_number = $2, ch_data = $3::jsonb, enrich_state = 'matched', updated_at = NOW()
        WHERE id = $1`,
      [uniboxReplyId, rundown.company_number, JSON.stringify(rundown)]
    )
    return rundown
  } catch (err) {
    console.error('[enrichReplyWithCH] failed:', err)
    await pool.query(
      `UPDATE unibox_replies SET enrich_state = 'error', updated_at = NOW() WHERE id = $1`,
      [uniboxReplyId]
    ).catch(() => {})
    return null
  }
}

// Merge a reply's stored CH rundown into the esp_leads.raw fields the client
// dashboard renders (fills only CH-provided keys, never blanks existing data).
// Called when a reply is marked as a lead/info so the verified company data
// reaches the client view. Best-effort.
export async function applyCHRundownToLead(
  leadId: string, workspaceId: string, uniboxReplyId: string
): Promise<void> {
  try {
    const r = await pool.query(`SELECT ch_data FROM unibox_replies WHERE id = $1`, [uniboxReplyId])
    const data = r.rows[0]?.ch_data as CompanyRundown | null
    if (!data?.company_number) return
    const fields = rundownToRawFields(data)
    if (!Object.keys(fields).length) return
    await pool.query(
      `UPDATE esp_leads SET raw = COALESCE(raw, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
        WHERE id = $2 AND workspace_id = $3`,
      [JSON.stringify(fields), leadId, workspaceId]
    )
  } catch (err) {
    console.error('[applyCHRundownToLead] failed:', err)
  }
}

// Read the global signature-extract field list (defaults to all when unset; an
// explicit empty string disables the feature). company_name is always included.
async function signatureFields(): Promise<SignatureField[]> {
  const cfg = await pool.query(`SELECT value FROM portal_settings WHERE key = 'signature_extract_fields'`)
  const raw = cfg.rows[0]?.value
  const fields: SignatureField[] = raw === undefined
    ? [...ALL_SIGNATURE_FIELDS]
    : String(raw).split(',').map(s => s.trim()).filter(Boolean) as SignatureField[]
  if (!fields.length) return []
  if (!fields.includes('company_name')) fields.push('company_name')
  return fields
}

// Enrich a Unibox reply's lead from BOTH the reply's email signature AND our
// contacts database, so the admin Unibox panel shows everything we know the
// moment a reply lands. Ensures a lightweight esp_leads row exists (NON-interested,
// so this never bills) for the JOIN to read. Signature wins over contacts for
// company_name (the reply is the freshest source); contacts fill the rest.
//
// leadId precedence matches mark-as-lead/lead-details: lead_bison_id, else
// `manual_<uniboxId>` — so a later mark-as-lead UPSERTs the SAME row.
export async function enrichUniboxReply(input: {
  uniboxId: string
  workspaceId: string
  email: string | null
  leadBisonId: string | null
  body: string | null
}): Promise<void> {
  const email = (input.email ?? '').trim().toLowerCase()
  if (!email || !input.workspaceId) return
  const leadId = input.leadBisonId || `manual_${input.uniboxId}`
  try {
    // 1) Ensure a lead row exists (no label/status → not billable, not on the
    //    client dashboard, but readable by the Unibox JOIN). Idempotent.
    // esp_leads PRIMARY KEY is (id, source) — confirmed against the live DB. The
    // arbiter MUST list both columns; ON CONFLICT (id) throws 42P10 "no unique or
    // exclusion constraint matching the ON CONFLICT specification". source is
    // always 'bison' here, so the conflict target matches the PK exactly.
    await pool.query(
      `INSERT INTO esp_leads (id, workspace_id, campaign_id, source, email, created_at, updated_at)
       VALUES ($1,$2,NULL,'bison',$3,NOW(),NOW())
       ON CONFLICT (id, source) DO NOTHING`,
      [leadId, input.workspaceId, email]
    )

    // 2) Signature extraction from the reply body.
    const fields = await signatureFields()
    if (fields.length && input.body) {
      const found = extractSignatureFields(input.body, fields, email) as Record<string, string>
      const { company_name, ...rawFields } = found
      if (Object.keys(rawFields).length) {
        await pool.query(
          `UPDATE esp_leads SET raw = COALESCE(raw, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
            WHERE id = $2 AND workspace_id = $3`,
          [JSON.stringify(rawFields), leadId, input.workspaceId]
        )
      }
      // company_name from the signature overrides the imported (often agency) name.
      if (company_name) {
        await pool.query(
          `UPDATE esp_leads SET company_name = $1, updated_at = NOW()
            WHERE id = $2 AND workspace_id = $3`,
          [company_name, leadId, input.workspaceId]
        )
      }
    }

    // 3) Fill remaining gaps from our contacts DB (won't blank existing keys; only
    //    sets company_name if still empty, so a signature value is preserved).
    await enrichLeadFromContacts(leadId, input.workspaceId, email)
  } catch (err) {
    console.error('[enrichUniboxReply] failed:', err)
  }
}
