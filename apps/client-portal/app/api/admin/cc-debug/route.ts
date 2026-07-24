import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool, { ready } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/admin/cc-debug?lead=email  (admin session OR ?secret=CRON_SECRET)
// Read-only. Dumps every stored portal_emails row for the lead with the cc-related
// raw keys + the cc value our thread query computes, so we can see exactly why cc
// does/doesn't surface. No writes, no external calls.
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const secretOk = !!process.env.CRON_SECRET && secret === process.env.CRON_SECRET
  if (!secretOk && !await getAdminSession()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()

  const lead = url.searchParams.get('lead')
  if (!lead) return NextResponse.json({ error: 'pass ?lead=email' }, { status: 400 })

  const r = await pool.query(
    `SELECT id, direction, timestamp_created,
            jsonb_typeof(raw->'cc')                    AS cc_type,
            raw->>'cc'                                 AS raw_cc,
            raw->>'cc_address_email_list'              AS raw_cc_list,
            jsonb_typeof(raw->'cc_address_json')       AS cc_json_type,
            raw->'cc_address_json'                     AS raw_cc_json,
            -- the EXACT expression the thread route uses:
            COALESCE(
              NULLIF((SELECT string_agg(
                        CASE WHEN COALESCE(x->>'name','') <> ''
                             THEN (x->>'name') || ' <' || (x->>'address') || '>'
                             ELSE x->>'address' END, ', ')
                      FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(raw->'cc_address_json') = 'array'
                             THEN raw->'cc_address_json' ELSE '[]'::jsonb END) AS x), ''),
              NULLIF(raw->>'cc_address_email_list',''),
              NULLIF((SELECT string_agg(v, ', ') FROM jsonb_array_elements_text(
                        CASE WHEN jsonb_typeof(raw->'cc') = 'array' THEN raw->'cc' ELSE '[]'::jsonb END) AS v), ''),
              CASE WHEN jsonb_typeof(raw->'cc') = 'array' THEN NULL ELSE NULLIF(raw->>'cc','') END
            ) AS computed_cc,
            (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(raw) AS k WHERE k ILIKE '%cc%') AS cc_keys
       FROM portal_emails
      WHERE lower(lead_email) = lower($1)
      ORDER BY timestamp_created ASC NULLS FIRST`,
    [lead]
  )
  return NextResponse.json({ lead, count: r.rows.length, rows: r.rows })
}
