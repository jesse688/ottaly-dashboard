import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

// Admin fills in / corrects a lead's contact details from the Unibox. Useful for
// sparse leads — e.g. a "question" reply or one forwarded in from outside Bison —
// where the webhook never captured name/company/title. Writes to esp_leads so the
// data shows on the client dashboard (which reads top-level first_name/last_name/
// company_name + raw->>'job_title' | 'company_website' | 'phone_number' |
// 'linkedin_person_url' | 'linkedin_company_url').
//
// The esp_leads row is UPSERTED with the SAME id precedence as mark-as-lead
// (lead_bison_id, else synthetic manual_<unibox_id>) so details can be saved even
// before the reply is marked as a lead. Admin-only; saves overwrite existing values
// (blank inputs are ignored so you never accidentally wipe an auto-extracted field).

// Top-level esp_leads columns vs fields merged into esp_leads.raw.
const RAW_FIELDS = [
  'job_title', 'company_website', 'phone_number', 'linkedin_person_url', 'linkedin_company_url',
  'address', 'city', 'state', 'country', 'industry',
] as const
type RawField = typeof RAW_FIELDS[number]

interface CustomField { label?: unknown; value?: unknown }
interface Body {
  first_name?: string
  last_name?: string
  company_name?: string
  job_title?: string
  company_website?: string
  phone_number?: string
  linkedin_person_url?: string
  linkedin_company_url?: string
  address?: string
  city?: string
  state?: string
  country?: string
  industry?: string
  custom_fields?: CustomField[]
}

// Trim and treat empty string as "leave unchanged".
function clean(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()
  const { id } = await params

  const body = await req.json().catch(() => ({})) as Body

  const first_name = clean(body.first_name)
  const last_name = clean(body.last_name)
  const company_name = clean(body.company_name)
  const raw: Record<string, string> = {}
  for (const f of RAW_FIELDS) {
    const v = clean(body[f])
    if (v !== undefined) raw[f] = v
  }

  // Custom named fields → merged into esp_leads.raw under their own keys (only
  // non-empty label+value pairs). Stored as a `custom_fields` array AND flattened
  // so the dashboard's raw->>'<label>' lookups can find them too.
  const customFields: { label: string; value: string }[] = []
  if (Array.isArray(body.custom_fields)) {
    for (const cf of body.custom_fields) {
      const label = clean(cf?.label)
      const value = clean(cf?.value)
      if (label && value) customFields.push({ label, value })
    }
  }

  if (first_name === undefined && last_name === undefined && company_name === undefined
      && Object.keys(raw).length === 0 && customFields.length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  // Persist the custom fields as a structured array in raw so the admin can edit
  // them back later, exactly as entered.
  const rawToMerge: Record<string, unknown> = { ...raw }
  if (customFields.length) rawToMerge.custom_fields = customFields

  // Resolve the unibox row → the lead id + workspace to write.
  const sel = await pool.query(
    `SELECT id, bison_reply_id, workspace_id, lead_bison_id, lead_email FROM unibox_replies WHERE id = $1`,
    [id]
  )
  if (!sel.rows.length) return NextResponse.json({ error: 'Reply not found' }, { status: 404 })
  const reply = sel.rows[0] as {
    id: string; bison_reply_id: string | null; workspace_id: string | null
    lead_bison_id: string | null; lead_email: string | null
  }
  if (!reply.workspace_id) {
    return NextResponse.json({ error: 'Reply is unmapped — no client workspace' }, { status: 409 })
  }
  const leadId = reply.lead_bison_id || `manual_${reply.id}`
  const email = (reply.lead_email ?? '').toLowerCase() || null

  // UPSERT esp_leads. On insert, seed top-level fields + raw. On conflict, COALESCE
  // top-level fields (a blank stays as-is) and MERGE the raw object so untouched
  // keys survive. source='bison' so it passes the dashboard source filter.
  await pool.query(
    `INSERT INTO esp_leads
       (id, workspace_id, campaign_id, source, email, first_name, last_name, company_name,
        status, label, raw, created_at, updated_at)
     VALUES ($1,$2,NULL,'bison',$3,$4,$5,$6,NULL,NULL,$7::jsonb,NOW(),NOW())
     ON CONFLICT (id, source) DO UPDATE SET
       first_name   = COALESCE($4, esp_leads.first_name),
       last_name    = COALESCE($5, esp_leads.last_name),
       company_name = COALESCE($6, esp_leads.company_name),
       raw          = COALESCE(esp_leads.raw, '{}'::jsonb) || $7::jsonb,
       updated_at   = NOW()`,
    [leadId, reply.workspace_id, email,
     first_name ?? null, last_name ?? null, company_name ?? null,
     JSON.stringify(rawToMerge)]
  )

  // A lead can exist as MORE THAN ONE esp_leads row for the same email in a
  // workspace with different ids (e.g. the original bison-id row vs a later
  // `manual_<replyid>` row). The client Leads page dedups by email and may read a
  // DIFFERENT row than the one we just upserted — so an edit here could otherwise
  // never reach the client (the "Ja onglynn"/blank split-brain bug). Propagate the
  // edited top-level fields to EVERY row for this email+workspace so the correction
  // lands on whichever row the client actually sees. Only overwrites fields the
  // admin actually entered (blank inputs are left untouched).
  if (email && (first_name !== undefined || last_name !== undefined || company_name !== undefined)) {
    await pool.query(
      `UPDATE esp_leads
          SET first_name   = COALESCE($3, first_name),
              last_name    = COALESCE($4, last_name),
              company_name = COALESCE($5, company_name),
              updated_at   = NOW()
        WHERE workspace_id = $1 AND lower(email) = $2 AND id <> $6`,
      [reply.workspace_id, email, first_name ?? null, last_name ?? null, company_name ?? null, leadId]
    )
  }

  return NextResponse.json({ ok: true, leadId })
}
