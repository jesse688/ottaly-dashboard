import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'

export const dynamic = 'force-dynamic'

// Unibox duplicate finder / cleaner.
// A "duplicate" = >1 unibox_replies row for the same (workspace_id, lower(lead_email),
// subject). These arise when the same reply is ingested via two paths with
// different dedup keys (e.g. the campaign webhook vs pv-other-reconcile).
//
// GET  /api/admin/unibox/dupes          → report duplicate groups + every row's keys
// POST /api/admin/unibox/dupes?apply=1  → keep ONE row per group, delete the rest
//
// Which row we KEEP (most informative wins): a campaign-linked row over an
// untracked one (campaign_id not null), then a portal-linked one, then the one
// with a real category, then the earliest created_at. Auth: admin session or ?secret.

function authed(req: NextRequest): Promise<boolean> | boolean {
  const secret = new URL(req.url).searchParams.get('secret')
  if (process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true
  return getAdminSession().then(s => !!s)
}

const GROUP_SQL = `
  SELECT workspace_id, lower(lead_email) AS lead, COALESCE(subject,'') AS subj,
         COUNT(*)::int AS n,
         json_agg(json_build_object(
           'id', id, 'team', bison_team_id, 'reply_id', bison_reply_id,
           'source', ingest_source, 'folder', folder, 'category', category,
           'campaign_id', campaign_id, 'portal_email_id', portal_email_id,
           'enriched', (ch_data IS NOT NULL OR enrich_state = 'matched'),
           'confidence', confidence, 'marked_as_lead', marked_as_lead,
           'created_at', created_at
         ) ORDER BY created_at) AS rows
    FROM unibox_replies
   GROUP BY workspace_id, lower(lead_email), COALESCE(subject,'')
  HAVING COUNT(*) > 1
   ORDER BY COUNT(*) DESC
   LIMIT 500
`

export async function GET(req: NextRequest) {
  if (!await authed(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const r = await pool.query(GROUP_SQL)
    const groups = r.rows
    const extraRows = groups.reduce((s, g) => s + (g.n - 1), 0)
    return NextResponse.json({ groups: groups.length, redundant_rows: extraRows, sample: groups.slice(0, 30) })
  } catch (err) {
    console.error('[dupes GET]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!await authed(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const apply = new URL(req.url).searchParams.get('apply') === '1'

  try {
    const r = await pool.query(GROUP_SQL)
    type Row = {
      id: string; source: string | null; folder: string | null; category: string | null
      campaign_id: string | null; portal_email_id: string | null; created_at: string
      enriched?: boolean; confidence?: number | null; marked_as_lead?: boolean
    }
    // Keep the MOST COMPLETE row ("the correct one should have all the data").
    // Priority (high → low):
    //   1. a human-marked lead (never delete a billed/triaged decision)
    //   2. Companies-House enriched (the row that actually has the data)
    //   3. a real, settled classification (not pending/other)
    //   4. confidence, then campaign/portal links
    //   5. PlusVibe API source as a gentle tiebreaker between two PV copies
    //   6. clearly-legacy imports (winnr one-offs, retired Bison, dead pv-other)
    //      are penalised so they always lose to a live PlusVibe row.
    // NOTE: the deeper cause is TWO reconcilers writing this table (pv-api +
    // an external 'pv-reconciler'); this scoring only cleans the symptom.
    const LEGACY = new Set(['winnr', 'bison', 'bison-webhook', 'pv-other'])
    const score = (x: Row) =>
      (x.marked_as_lead ? 1000 : 0) +
      (x.enriched ? 80 : 0) +
      (x.category && x.category !== 'pending' && x.category !== 'other' ? 30 : 0) +
      Math.round((typeof x.confidence === 'number' ? x.confidence : 0) * 8) +
      (x.campaign_id ? 4 : 0) + (x.portal_email_id ? 2 : 0) +
      (x.source === 'pv-api' ? 5 : 0) +
      (x.source && LEGACY.has(x.source) ? -60 : 0)

    const toDelete: string[] = []
    const plan: { lead: string; keep: string; drop: string[] }[] = []
    for (const g of r.rows as { lead: string; rows: Row[] }[]) {
      const sorted = [...g.rows].sort((a, b) =>
        score(b) - score(a) || a.created_at.localeCompare(b.created_at))
      const keep = sorted[0]
      const drop = sorted.slice(1).map(x => x.id)
      toDelete.push(...drop)
      plan.push({ lead: g.lead, keep: keep.id, drop })
    }

    if (!apply) {
      return NextResponse.json({ dryRun: true, groups: plan.length, would_delete: toDelete.length, plan: plan.slice(0, 50) })
    }

    let deleted = 0
    // Delete in chunks to keep the statement small.
    for (let i = 0; i < toDelete.length; i += 200) {
      const chunk = toDelete.slice(i, i + 200)
      const res = await pool.query(`DELETE FROM unibox_replies WHERE id::text = ANY($1::text[])`, [chunk])
      deleted += res.rowCount ?? 0
    }
    return NextResponse.json({ ok: true, groups: plan.length, deleted })
  } catch (err) {
    console.error('[dupes POST]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
