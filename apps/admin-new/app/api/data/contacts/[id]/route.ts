import { type NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { DEFAULT_WORKSPACE } from '@/lib/contacts-filter'

// Engine-browse rows have a synthetic id `engine:<domain>` and are NOT real
// contacts — they must never hit a read/UPDATE against the contacts table.
function isEngineId(id: string) {
  return id.startsWith('engine:')
}

// Single-contact read + update. Port of legacy GET /contacts/:id and
// PATCH /contacts/:id (db.getContactsById + the whitelisted UPDATE).

const ALLOWED_FIELDS = [
  'first_name',
  'last_name',
  'phone',
  'linkedin_url',
  'job_title',
  'job_title_cleaned',
  'seniority',
  'department',
  'company_name',
  'company_domain',
  'status',
  'owns_building',
  'works_remote',
  'do_not_contact',
]

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (isEngineId(id)) {
    return NextResponse.json({ error: 'Engine leads are read-only' }, { status: 400 })
  }
  const workspaceId = req.headers.get('x-workspace-id') || DEFAULT_WORKSPACE
  try {
    // Scope by workspace_id — ids are global, so an unscoped read could leak
    // another client's contact.
    const r = await pool.query(
      `SELECT * FROM contacts WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [id, workspaceId],
    )
    if (!r.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ contact: r.rows[0] })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

async function update(id: string, workspaceId: string, body: Record<string, unknown>) {
  const sets: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vals: any[] = []
  let p = 1
  for (const key of ALLOWED_FIELDS) {
    if (body[key] !== undefined) {
      sets.push(`${key} = $${p++}`)
      vals.push(body[key] === '' ? null : body[key])
    }
  }
  if (!sets.length) return { ok: false, status: 400, error: 'No fields to update' }
  sets.push('updated_at = CURRENT_TIMESTAMP')
  vals.push(id)
  vals.push(workspaceId)
  // Scope by workspace_id so an edit can never mutate another client's row.
  const r = await pool.query(
    `UPDATE contacts SET ${sets.join(', ')} WHERE id = $${p} AND workspace_id = $${p + 1}`,
    vals,
  )
  if (!r.rowCount) return { ok: false, status: 404, error: 'Not found in this workspace' }
  return { ok: true }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (isEngineId(id)) {
    return NextResponse.json({ error: 'Engine leads are read-only — cannot edit' }, { status: 400 })
  }
  const workspaceId = req.headers.get('x-workspace-id') || DEFAULT_WORKSPACE
  try {
    const body = await req.json().catch(() => ({}))
    const res = await update(id, workspaceId, body)
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST alias for the same update (the page saves via POST /api/data/contacts/:id).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return PATCH(req, { params })
}
