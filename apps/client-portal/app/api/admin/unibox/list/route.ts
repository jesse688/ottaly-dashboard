import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'

const FOLDERS = ['inbox', 'review', 'done', 'unmapped', 'rejected'] as const
type Folder = (typeof FOLDERS)[number]

// Admin-only list of Master Unibox replies, one folder at a time, newest-first,
// with cursor pagination on received_at. Joins client company_name by workspace.
export async function GET(req: NextRequest) {
  if (!await getAdminSession()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()

  const url = new URL(req.url)
  const folderParam = url.searchParams.get('folder') ?? 'inbox'
  const folder: Folder = (FOLDERS as readonly string[]).includes(folderParam) ? (folderParam as Folder) : 'inbox'
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100)
  const before = url.searchParams.get('before') // received_at cursor (ISO)
  const q = (url.searchParams.get('q') ?? '').trim()
  // Filter by EFFECTIVE category (admin override if set, else the AI category).
  const CATEGORIES = ['interested', 'not_interested', 'ooo_auto_reply', 'unsubscribe', 'warmup', 'other'] as const
  const catParam = url.searchParams.get('category') ?? ''
  const category = (CATEGORIES as readonly string[]).includes(catParam) ? catParam : ''

  // When searching OR filtering by category, look ACROSS all folders (you want to
  // find a reply wherever it landed). Otherwise scope to the selected folder.
  const params: unknown[] = []
  let folderFilter: string
  if (q || category) {
    folderFilter = 'TRUE'
  } else {
    params.push(folder)
    folderFilter = `u.folder = $${params.length}`
  }

  let categoryFilter = ''
  if (category) {
    params.push(category)
    categoryFilter = `AND COALESCE(u.admin_label, u.category) = $${params.length}`
  }

  let search = ''
  if (q) {
    params.push(`%${q}%`)
    const p = `$${params.length}`
    // Match subject, the lead/sender/matched emails, the lead's name + company.
    search = `AND (
      u.subject ILIKE ${p} OR u.body_preview ILIKE ${p}
      OR u.lead_email ILIKE ${p} OR u.sender_email ILIKE ${p}
      OR u.matched_lead_email ILIKE ${p}
      OR c.company_name ILIKE ${p}
      OR l.company_name ILIKE ${p}
      OR (COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'')) ILIKE ${p}
    )`
  }

  let cursor = ''
  if (before) {
    params.push(before)
    cursor = `AND u.received_at < $${params.length}`
  }
  params.push(limit + 1) // fetch one extra to compute hasMore

  try {
    const r = await pool.query(
      `SELECT u.id, u.bison_team_id, u.bison_reply_id, u.workspace_id, u.portal_email_id,
              u.lead_email, u.lead_bison_id, u.subject, u.body_preview,
              u.classify_state, u.classify_attempts, u.category, u.confidence,
              u.ai_model, u.ai_reasoning, u.admin_label, u.folder,
              u.marked_as_lead, u.marked_by, u.marked_at, u.bison_tag_state,
              u.is_forwarded, u.sender_email, u.matched_lead_email, u.matched_by,
              u.received_at, u.created_at,
              c.id AS client_id, c.company_name,
              l.first_name, l.last_name, l.company_name AS lead_company,
              l.raw->>'job_title'            AS job_title,
              l.raw->>'industry'             AS industry,
              l.raw->>'city'                 AS city,
              l.raw->>'state'                AS state,
              l.raw->>'country'              AS country,
              l.raw->>'company_website'      AS company_website,
              l.raw->>'linkedin_person_url'  AS linkedin_url,
              l.raw->>'linkedin_company_url' AS linkedin_company_url,
              l.raw->>'phone_number'         AS phone_number,
              pe.body_html, pe.body_text
         FROM unibox_replies u
         LEFT JOIN portal_clients c ON c.workspace_id = u.workspace_id
         LEFT JOIN LATERAL (
           SELECT first_name, last_name, company_name, raw
           FROM esp_leads e
           WHERE e.workspace_id = u.workspace_id
             AND lower(e.email) = lower(u.lead_email)
           ORDER BY (e.source = 'bison') DESC, e.updated_at DESC
           LIMIT 1
         ) l ON TRUE
         LEFT JOIN portal_emails pe ON pe.id = u.portal_email_id
        WHERE ${folderFilter} ${categoryFilter} ${search} ${cursor}
        ORDER BY u.received_at DESC
        LIMIT $${params.length}`,
      params
    )

    const hasMore = r.rows.length > limit
    const rows = hasMore ? r.rows.slice(0, limit) : r.rows
    const nextCursor = hasMore ? rows[rows.length - 1].received_at : null

    // Folder counts for the tab badges.
    const counts = await pool.query(
      `SELECT folder, COUNT(*)::int AS n FROM unibox_replies GROUP BY folder`
    )
    const countsByFolder: Record<string, number> = {}
    for (const row of counts.rows) countsByFolder[row.folder as string] = row.n as number

    // Effective-category counts for the label filter chips.
    const catCounts = await pool.query(
      `SELECT COALESCE(admin_label, category) AS cat, COUNT(*)::int AS n
         FROM unibox_replies
        WHERE COALESCE(admin_label, category) IS NOT NULL
        GROUP BY COALESCE(admin_label, category)`
    )
    const countsByCategory: Record<string, number> = {}
    for (const row of catCounts.rows) countsByCategory[row.cat as string] = row.n as number

    return NextResponse.json({ rows, nextCursor, counts: countsByFolder, categoryCounts: countsByCategory })
  } catch (err) {
    console.error('[admin/unibox/list] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
