import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

// POST — apply a setting to ALL clients at once.
// Body may contain any of:
//   { hiddenFields: string[] }  → overwrite hidden_fields for every client
//   { hiddenLabels: string[] }  → overwrite hidden_labels for every client
//   { settings: { key: value } }→ overwrite global portal_settings keys
// Each is independent; send whichever you want to bulk-apply.
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as {
    hiddenFields?: string[]
    hiddenLabels?: string[]
    settings?: Record<string, string>
  }

  let clientsUpdated = 0

  if (Array.isArray(body.hiddenFields)) {
    const r = await pool.query(`UPDATE portal_clients SET hidden_fields = $1`, [body.hiddenFields])
    clientsUpdated = Math.max(clientsUpdated, r.rowCount ?? 0)
  }

  if (Array.isArray(body.hiddenLabels)) {
    const r = await pool.query(`UPDATE portal_clients SET hidden_labels = $1`, [body.hiddenLabels])
    clientsUpdated = Math.max(clientsUpdated, r.rowCount ?? 0)
  }

  if (body.settings && typeof body.settings === 'object') {
    for (const [key, value] of Object.entries(body.settings)) {
      await pool.query(
        `INSERT INTO portal_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, String(value ?? '')]
      )
    }
  }

  return NextResponse.json({ ok: true, clientsUpdated })
}
