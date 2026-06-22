import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getAdminSession } from '@/lib/auth'
import { CATEGORIES } from '@/lib/classify'
import { sanitizeEmailHtml } from '@/lib/sanitize-html'

const FOLDERS = ['inbox', 'review', 'replies', 'done', 'unmapped', 'rejected', 'warmup'] as const
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
  const catParam = url.searchParams.get('category') ?? ''
  const category = (CATEGORIES as readonly string[]).includes(catParam) ? catParam : ''

  // Firehose: folder=all (or free-text searching) looks ACROSS all folders, but
  // EXCLUDES warm-up — warm-up is auto-generated noise quarantined in its own tab
  // (tens of thousands of rows) and would otherwise swamp every real reply, making
  // "All replies" look like it does nothing. Searching still skips warm-up too.
  // Category filtering stays scoped to the current folder so chips act as
  // sub-filters within the tab, not cross-folder searches.
  const params: unknown[] = []
  let folderFilter: string
  if (q || folderParam === 'all') {
    folderFilter = `u.folder <> 'warmup'`
  } else {
    params.push(folder)
    folderFilter = `u.folder = $${params.length}`
  }

  let categoryFilter = ''
  if (category) {
    params.push(category)
    categoryFilter = `AND COALESCE(u.admin_label, u.category) = $${params.length}`
  }

  // Per-client zoom (the firehose). Prefer the row's resolved client_id, but FALL
  // BACK to the workspace→client mapping for rows whose client_id wasn't backfilled
  // (most pre-Phase-1 rows are still NULL). Without this fallback, zooming to a
  // client showed nothing because almost every row had a NULL client_id.
  let clientFilter = ''
  const clientParam = (url.searchParams.get('client') ?? '').trim()
  if (clientParam) {
    params.push(clientParam)
    const cp = `$${params.length}`
    clientFilter = `AND (
      u.client_id = ${cp}::uuid
      OR (u.client_id IS NULL AND u.workspace_id IN (
            SELECT workspace_id FROM portal_clients WHERE id = ${cp}::uuid
      ))
    )`
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
              u.label_type, u.enrich_state, u.ch_data,
              u.received_at, u.created_at,
              c.id AS client_id, c.company_name,
              l.first_name, l.last_name, l.company_name AS lead_company,
              l.raw->>'job_title'            AS job_title,
              l.raw->>'industry'             AS industry,
              l.raw->>'address'              AS address,
              l.raw->>'city'                 AS city,
              l.raw->>'state'                AS state,
              l.raw->>'country'              AS country,
              l.raw->>'company_website'      AS company_website,
              l.raw->>'linkedin_person_url'  AS linkedin_url,
              l.raw->>'linkedin_company_url' AS linkedin_company_url,
              l.raw->>'phone_number'         AS phone_number,
              l.raw->>'mobile_phone'         AS mobile_phone,
              l.raw->>'office_phone'         AS office_phone,
              l.raw->'custom_fields'         AS custom_fields,
              -- Full HTML body (with the lead's signature/image). Sources, in order:
              --   1. PlusVibe-reconciler rows nest the full message at
              --      raw.body.html / raw.body.text (the rich HTML incl. embedded
              --      signature image). body_preview is only the truncated 500-char
              --      text, which is why signatures showed as "[signatureImage]".
              --   2. Bison webhook rows put it at raw.html_body / raw.text_body.
              --   3. Else the cached portal_emails row (matched by id OR workspace+
              --      email in the LATERAL join below).
              COALESCE(NULLIF(u.raw->'body'->>'html',''), NULLIF(u.raw->>'html_body',''), pe.body_html) AS body_html,
              COALESCE(NULLIF(u.raw->'body'->>'text',''), NULLIF(u.raw->>'text_body',''), pe.body_text) AS body_text
         FROM unibox_replies u
         -- Resolve the owning client WITHOUT fan-out: prefer the row's resolved
         -- client_id (unique), else fall back to the same active-most precedence
         -- for legacy rows whose client_id wasn't backfilled. A plain join on
         -- workspace_id would duplicate every reply when >1 client shares a ws.
         LEFT JOIN LATERAL (
           SELECT pc.id, pc.company_name
           FROM portal_clients pc
           WHERE pc.id = u.client_id
              OR (u.client_id IS NULL AND pc.workspace_id = u.workspace_id)
           ORDER BY (pc.id = u.client_id) DESC, pc.active DESC, pc.created_at ASC
           LIMIT 1
         ) c ON TRUE
         LEFT JOIN LATERAL (
           SELECT first_name, last_name, company_name, raw
           FROM esp_leads e
           WHERE e.workspace_id = u.workspace_id
             AND lower(e.email) = lower(u.lead_email)
           ORDER BY (e.source = 'bison') DESC, e.updated_at DESC
           LIMIT 1
         ) l ON TRUE
         -- Match the cached full body: by the linked id when present, else (PV-
         -- reconciler rows, where portal_email_id is NULL) by the newest INBOUND
         -- portal_emails row for the same workspace + lead email.
         LEFT JOIN LATERAL (
           SELECT body_html, body_text
           FROM portal_emails pem
           WHERE pem.id = u.portal_email_id
              OR (u.portal_email_id IS NULL
                  AND pem.workspace_id = u.workspace_id
                  AND lower(pem.lead_email) = lower(u.lead_email)
                  AND pem.direction = 'IN')
           ORDER BY (pem.id = u.portal_email_id) DESC, pem.timestamp_created DESC
           LIMIT 1
         ) pe ON TRUE
        WHERE ${folderFilter} ${clientFilter} ${categoryFilter} ${search} ${cursor}
        ORDER BY u.received_at DESC
        LIMIT $${params.length}`,
      params
    )

    const hasMore = r.rows.length > limit
    const rows = (hasMore ? r.rows.slice(0, limit) : r.rows).map(row => ({
      ...row,
      // Sanitize the inbound HTML body so the admin Unibox can render the lead's full
      // signature (logos/photos/contact table) safely. Admin view loads remote images.
      body_html_safe: row.body_html ? sanitizeEmailHtml(String(row.body_html), { blockRemoteImages: false }) : null,
    }))
    const nextCursor = hasMore ? rows[rows.length - 1].received_at : null

    // Counts respect the active client zoom (same resilient client match as the
    // list) so badges match the scoped list even when client_id isn't backfilled.
    const clientScopeSql = `(
      client_id = $1::uuid
      OR (client_id IS NULL AND workspace_id IN (
            SELECT workspace_id FROM portal_clients WHERE id = $1::uuid
      ))
    )`
    const countParams = clientParam ? [clientParam] : []

    // Folder counts for the tab badges.
    const counts = await pool.query(
      `SELECT folder, COUNT(*)::int AS n FROM unibox_replies
        ${clientParam ? `WHERE ${clientScopeSql}` : ''} GROUP BY folder`,
      countParams
    )
    const countsByFolder: Record<string, number> = {}
    for (const row of counts.rows) countsByFolder[row.folder as string] = row.n as number
    // "All replies" badge = every folder except warm-up (mirrors the firehose filter).
    countsByFolder.all = Object.entries(countsByFolder)
      .filter(([f]) => f !== 'warmup')
      .reduce((sum, [, n]) => sum + n, 0)

    // Effective-category counts for the label filter chips.
    const catCounts = await pool.query(
      `SELECT COALESCE(admin_label, category) AS cat, COUNT(*)::int AS n
         FROM unibox_replies
        WHERE ${clientParam ? `${clientScopeSql} AND ` : ''}COALESCE(admin_label, category) IS NOT NULL
        GROUP BY COALESCE(admin_label, category)`,
      countParams
    )
    const countsByCategory: Record<string, number> = {}
    for (const row of catCounts.rows) countsByCategory[row.cat as string] = row.n as number

    return NextResponse.json({ rows, nextCursor, counts: countsByFolder, categoryCounts: countsByCategory })
  } catch (err) {
    console.error('[admin/unibox/list] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
