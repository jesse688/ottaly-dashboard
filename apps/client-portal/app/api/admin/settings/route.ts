import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { DEFAULT_TEMPLATES } from '@/lib/email'

// GET — current notification templates (defaults merged with any saved overrides).
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const r = await pool.query(`SELECT key, value FROM portal_settings WHERE key = ANY($1)`, [Object.keys(DEFAULT_TEMPLATES)])
  const out: Record<string, string> = { ...DEFAULT_TEMPLATES }
  for (const row of r.rows) if (row.value != null) out[row.key] = row.value
  return NextResponse.json(out)
}

// PUT — save one or more templates. Only known keys are accepted.
export async function PUT(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json() as Record<string, string>
  const allowed = Object.keys(DEFAULT_TEMPLATES)
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.includes(key)) continue
    await pool.query(
      `INSERT INTO portal_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, String(value ?? '')]
    )
  }
  return NextResponse.json({ ok: true })
}
