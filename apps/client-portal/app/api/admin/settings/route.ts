import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { DEFAULT_TEMPLATES } from '@/lib/email'

// All editable global settings = notification templates + payment details shown
// to clients when they pay an invoice.
const DEFAULT_SETTINGS: Record<string, string> = {
  ...DEFAULT_TEMPLATES,
  payment_instructions: 'Bank transfer:\nAccount name: Ottaly Ltd\nSort code: 00-00-00\nAccount number: 00000000\nReference: your company name',
  payment_link: '',
  // Which contact fields to extract from a lead's email signature and override
  // their stored value with (comma-separated raw keys). Empty = feature off.
  signature_extract_fields: 'phone_number,company_website,linkedin_person_url,linkedin_company_url,job_title',
}

// GET — current settings (defaults merged with any saved overrides).
export async function GET() {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const r = await pool.query(`SELECT key, value FROM portal_settings WHERE key = ANY($1)`, [Object.keys(DEFAULT_SETTINGS)])
  const out: Record<string, string> = { ...DEFAULT_SETTINGS }
  for (const row of r.rows) if (row.value != null) out[row.key] = row.value
  return NextResponse.json(out)
}

// PUT — save one or more settings. Only known keys are accepted.
export async function PUT(req: NextRequest) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json() as Record<string, string>
  const allowed = Object.keys(DEFAULT_SETTINGS)
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
