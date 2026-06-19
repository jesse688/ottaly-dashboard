import pool from './db'
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
