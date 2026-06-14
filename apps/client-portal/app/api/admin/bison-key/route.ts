import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getBisonKey, bisonKeySource, invalidateBisonKeyCache } from '@/lib/bison'

// Manage the portal's Bison super-admin API key from the Settings UI, so it can
// be set/tested/cleared without editing env. Saved in portal_settings
// ('bison_api_key') and overrides the BISON_API_KEY env var. Never returns the
// full key — only a masked hint. The portal needs its OWN key, separate from
// admin-legacy's, so the two don't collide on Bison's stateful session.

// GET — masked status.
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const key = await getBisonKey()
  return NextResponse.json({
    configured: !!key,
    source: bisonKeySource(),
    masked: key ? '••••••••' + key.slice(-4) : null,
  })
}

// POST { key } — save (takes effect immediately, no redeploy).
export async function POST(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { key?: string }
  const key = (body.key ?? '').trim()
  if (!key) return NextResponse.json({ error: 'Key is required' }, { status: 400 })
  await pool.query(
    `INSERT INTO portal_settings (key, value, updated_at) VALUES ('bison_api_key', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key]
  )
  invalidateBisonKeyCache()
  return NextResponse.json({ ok: true, masked: '••••••••' + key.slice(-4) })
}

// DELETE — clear the saved key, fall back to env.
export async function DELETE() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await pool.query(`DELETE FROM portal_settings WHERE key = 'bison_api_key'`)
  invalidateBisonKeyCache()
  return NextResponse.json({ ok: true, source: bisonKeySource() })
}
