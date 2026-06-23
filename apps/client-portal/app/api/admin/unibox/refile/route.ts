import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool, { ready } from '@/lib/db'
import { NEGATIVE_CONFIDENCE_MIN } from '@/lib/classify'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// POST /api/admin/unibox/refile
// One-time migration of EXISTING rows into the simplified 7-folder taxonomy:
//   review · lead · lead_replies · not_interested · warmup · unsubscribe · ooo · (done)
// Pure SQL (no rows pulled into Node). The guiding rule mirrors the live
// classifier: only confident noise leaves Review; everything else (interested,
// question, "other", low-confidence) lands in Review so nothing positive is hidden.
// Already-actioned rows (marked leads, done/rejected) are preserved.
export async function POST(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret')
  const ok = (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) || !!await getAdminSession()
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ready()

  const ACTIVE = `('inbox','review','unmapped')` // folders eligible for re-routing
  const counts: Record<string, number> = {}
  const run = async (label: string, sql: string, params: unknown[] = []) => {
    const r = await pool.query(sql, params)
    counts[label] = r.rowCount ?? 0
  }

  try {
    // 1. Anything marked a lead → Lead.
    await run('lead', `UPDATE unibox_replies SET folder='lead', updated_at=NOW()
                        WHERE marked_as_lead = TRUE AND folder <> 'lead'`)
    // 2. Legacy folders → new names.
    await run('rejected_to_done', `UPDATE unibox_replies SET folder='done', updated_at=NOW() WHERE folder='rejected'`)
    await run('replies_to_lead_replies', `UPDATE unibox_replies SET folder='lead_replies', updated_at=NOW() WHERE folder='replies'`)
    // 3. Active rows whose lead is already a marked lead → Lead Replies.
    await run('lead_replies', `
      UPDATE unibox_replies u SET folder='lead_replies', updated_at=NOW()
       WHERE u.folder IN ${ACTIVE} AND u.marked_as_lead = FALSE
         AND EXISTS (SELECT 1 FROM unibox_replies x
                      WHERE x.workspace_id = u.workspace_id
                        AND lower(x.lead_email) = lower(u.lead_email)
                        AND x.marked_as_lead = TRUE)`)
    // 4. Confident noise leaves Review into its own folder.
    await run('warmup', `UPDATE unibox_replies SET folder='warmup', updated_at=NOW()
                          WHERE folder IN ${ACTIVE} AND marked_as_lead=FALSE AND category='warmup'`)
    await run('ooo', `UPDATE unibox_replies SET folder='ooo', updated_at=NOW()
                       WHERE folder IN ${ACTIVE} AND marked_as_lead=FALSE AND category='ooo_auto_reply'`)
    await run('unsubscribe', `UPDATE unibox_replies SET folder='unsubscribe', updated_at=NOW()
                               WHERE folder IN ${ACTIVE} AND marked_as_lead=FALSE AND category='unsubscribe'`)
    await run('not_interested', `UPDATE unibox_replies SET folder='not_interested', updated_at=NOW()
                                  WHERE folder IN ${ACTIVE} AND marked_as_lead=FALSE
                                    AND category='not_interested' AND COALESCE(confidence,0) >= $1`, [NEGATIVE_CONFIDENCE_MIN])
    // 5. EVERYTHING still in inbox/unmapped → Review (interested, question, other,
    //    low-confidence not_interested, null/unknown). Never hide a possible lead.
    await run('review', `UPDATE unibox_replies SET folder='review', updated_at=NOW()
                          WHERE folder IN ('inbox','unmapped') AND marked_as_lead=FALSE`)

    // Final tally per folder so the result is verifiable at a glance.
    const tally = await pool.query(`SELECT folder, COUNT(*)::int AS n FROM unibox_replies GROUP BY folder ORDER BY n DESC`)
    const byFolder: Record<string, number> = {}
    for (const row of tally.rows) byFolder[row.folder as string] = row.n as number
    return NextResponse.json({ ok: true, moved: counts, folders: byFolder })
  } catch (err) {
    console.error('[unibox/refile]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
