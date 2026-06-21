import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Admin-configurable filter defaults, persisted in app_settings so they apply
// for everyone (not per-browser). Controls which provider/gateway exclusions
// are pre-applied when the data page loads. Port of the legacy
// /contacts/filter-defaults GET/POST + db.getSetting/setSetting.

const FILTER_DEFAULTS_KEY = 'contact_filter_defaults'
const FALLBACK = {
  excludeMicrosoft: false,
  excludeGateways: ['Mimecast', 'Barracuda', 'Proofpoint'],
}

export async function GET() {
  try {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [
      FILTER_DEFAULTS_KEY,
    ])
    const v = r.rows.length ? r.rows[0].value : null
    return NextResponse.json(
      v && typeof v === 'object' ? { ...FALLBACK, ...v } : FALLBACK
    )
  } catch {
    return NextResponse.json(FALLBACK)
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const next = {
      excludeMicrosoft: !!body?.excludeMicrosoft,
      excludeGateways: Array.isArray(body?.excludeGateways)
        ? body.excludeGateways.filter(Boolean)
        : [],
    }
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [FILTER_DEFAULTS_KEY, JSON.stringify(next)]
    )
    return NextResponse.json({ ok: true, defaults: next })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Database error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
