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
    // Pull the selected engine leads.
    const { rows } = await pool.query(
      `SELECT domain, company_name, email_primary, emails, phones, director_name,
              industry, region, company_size, linkedin_url, postcode
         FROM ottaly_engine_leads
        WHERE domain = ANY($1) AND email_primary IS NOT NULL AND email_primary <> ''`,
      [domains],
    )

    const ids: string[] = []
    let skipped = 0
    for (const r of rows) {
      const email = String(r.email_primary || '').trim().toLowerCase()
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue }
      const [first, ...rest] = String(r.director_name || '').trim().split(/\s+/)
      // company_size is a text bucket ("11-50"), so it does NOT map to the
      // INT num_employees column — store the company region instead and leave
      // size out to avoid a type error.
      const res = await pool.query(
        `INSERT INTO contacts
           (workspace_id, email, first_name, last_name, phone, company_name,
            company_domain, linkedin_url, industry, company_region,
            job_title, status, source, imported_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'new','engine',NOW())
         ON CONFLICT (workspace_id, email) DO UPDATE SET source = contacts.source
         RETURNING id`,
        [
          workspaceId, email, first || null, rest.join(' ') || null,
          Array.isArray(r.phones) ? r.phones[0] ?? null : null,
          r.company_name || null, r.domain || null, r.linkedin_url || null,
          r.industry || null, r.region || null,
          r.director_name ? 'Director' : null,
        ],
      )
      if (res.rows[0]?.id) ids.push(res.rows[0].id)
    }

    return NextResponse.json({ staged: ids.length, skipped, contact_ids: ids })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    console.error('[engine-leads/stage-to-contacts] failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
