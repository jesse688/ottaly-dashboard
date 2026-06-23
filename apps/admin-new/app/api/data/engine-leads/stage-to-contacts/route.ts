import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { DEFAULT_WORKSPACE } from '@/lib/contacts-filter'

// POST /api/data/engine-leads/stage-to-contacts
// Body: { domains: string[] }  (the engine PK is `domain`)
// Copies the named engine leads into the contacts table as source='engine'
// (clearly tagged + separate from verified Apollo data), so the existing
// verify-and-push pipeline can run on them. Returns the contact ids to push.
// Idempotent: ON CONFLICT (workspace_id, email) reuses the existing row.
export async function POST(req: NextRequest) {
  const workspaceId = req.headers.get('x-workspace-id') || DEFAULT_WORKSPACE
  let body: { domains?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const domains = Array.isArray(body.domains)
    ? body.domains.map((d) => String(d).trim()).filter(Boolean)
    : []
  if (!domains.length) {
    return NextResponse.json({ error: 'domains[] required' }, { status: 400 })
  }

  try {
    // Pull the selected engine leads. "Has an email" = email_primary OR the
    // first of emails[] — the SAME definition the list filter and browse view
    // use, so leads shown with an email are never silently dropped here.
    const { rows } = await pool.query(
      `SELECT domain, company_name, email_primary, emails, phones, director_name,
              industry, region, company_size, linkedin_url, postcode
         FROM ottaly_engine_leads
        WHERE domain = ANY($1)
          AND (COALESCE(NULLIF(email_primary,''), emails[1]) IS NOT NULL
               AND COALESCE(NULLIF(email_primary,''), emails[1]) <> '')`,
      [domains],
    )

    let skipped = 0
    // Build the parameter rows once, in JS, then insert them in ONE bulk query.
    // Per-row sequential INSERTs (the old approach) made staging crawl and
    // "stick" while the DB was busy with a running verify job — one round-trip
    // per lead. A single multi-row INSERT is one round-trip total.
    const params: unknown[] = []
    const valueRows: string[] = []
    // A bulk upsert throws if the SAME email appears twice in one statement
    // ("cannot affect row a second time"). Engine rows are keyed by domain, so
    // two domains can share an email — dedupe within the batch, first wins.
    const seenEmails = new Set<string>()
    for (const r of rows) {
      const rawEmail = r.email_primary || (Array.isArray(r.emails) ? r.emails[0] : '')
      const email = String(rawEmail || '').trim().toLowerCase()
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue }
      if (seenEmails.has(email)) { skipped++; continue }
      seenEmails.add(email)
      const [first, ...rest] = String(r.director_name || '').trim().split(/\s+/)
      // company_size is a text bucket ("11-50", "1-10"); num_employees is INT.
      // Parse the lower bound so the size isn't lost on push (e.g. "11-50" → 11).
      const sizeLow = (() => {
        const m = String(r.company_size || '').match(/\d+/)
        return m ? parseInt(m[0], 10) : null
      })()
      const vals = [
        workspaceId, email, first || null, rest.join(' ') || null,
        Array.isArray(r.phones) ? r.phones[0] ?? null : null,
        r.company_name || null, r.domain || null, r.linkedin_url || null,
        r.industry || null, r.region || null, sizeLow,
        r.director_name ? 'Director' : null,
      ]
      const base = params.length
      // 12 bound params per row; the trailing 'new','engine',NOW() are literals.
      valueRows.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},'new','engine',NOW())`,
      )
      params.push(...vals)
    }

    if (!valueRows.length) {
      return NextResponse.json({ staged: 0, skipped, skipped_existing_contacts: 0, contact_ids: [] })
    }

    // RETURNING source + xmax: xmax=0 means a fresh INSERT (a real engine lead);
    // xmax<>0 means it CONFLICTED with an existing row, whose `source` we get
    // back. We must NOT push an existing VERIFIED (apollo/plusvibe) contact just
    // because a scraped email matched it.
    const res = await pool.query(
      `INSERT INTO contacts
         (workspace_id, email, first_name, last_name, phone, company_name,
          company_domain, linkedin_url, industry, company_region, num_employees,
          job_title, status, source, imported_at)
       VALUES ${valueRows.join(',')}
       ON CONFLICT (workspace_id, email) DO UPDATE SET source = contacts.source
       RETURNING id, source, (xmax = 0) AS inserted`,
      params,
    )

    const ids: string[] = []
    let collidedExisting = 0 // emails that already exist as NON-engine contacts
    for (const row of res.rows as Array<{ id: string; source: string; inserted: boolean }>) {
      if (!row?.id) continue
      // Only stage/push rows that are genuinely engine leads (freshly inserted,
      // or an existing row already tagged 'engine'). Skip emails that collide
      // with a real verified contact — don't re-push someone already in a campaign.
      if (row.inserted || row.source === 'engine') ids.push(row.id)
      else collidedExisting++
    }

    return NextResponse.json({
      staged: ids.length,
      skipped,
      skipped_existing_contacts: collidedExisting,
      contact_ids: ids,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[engine-leads/stage-to-contacts] failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
