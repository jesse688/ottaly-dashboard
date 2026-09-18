import { type NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { q } from '@/lib/query'

export const dynamic = 'force-dynamic'

/**
 * Placement test results.
 *
 * The only DIRECT evidence of inbox placement. Everything else in this system
 * infers deliverability from OOO reply rate, which is a proxy — a low rate
 * might mean spam, or might just mean a quiet list.
 *
 * The proxy holds up: YVF ran two tests within the same hour on 2026-09-16,
 * one on its high-OOO mailboxes (97% inbox) and one on its low-OOO mailboxes
 * (56% inbox, 44% spam). Same client, same day, opposite results. But this
 * measures placement rather than inferring it.
 *
 * ONLY GENERIC-CONTENT TESTS COUNT. A test sent with live campaign copy
 * measures the COPY, not the mailbox — spam there could mean bad copy on a
 * perfectly healthy mailbox, and pausing it would be wrong.
 */

/** Spam share at which a mailbox is flagged. */
const SPAM_FLAG_PCT = 25
/** Seeds before a result means anything. */
const MIN_SEEDS = 4
/**
 * Days of runs pooled when judging a mailbox.
 *
 * One run gives very few seeds per mailbox — Butterfly's weekly test sends 90
 * seeds across 45 senders, about 2 each. Judging on the latest run alone would
 * leave every mailbox permanently under MIN_SEEDS and nothing would ever flag.
 */
const POOL_DAYS = 42

export async function GET(req: NextRequest) {
  const client = req.nextUrl.searchParams.get('client') || null
  try {
    const mailboxes = await q<Record<string, string | null>>(
      `SELECT p.email,
              COALESCE(m.workspace_name, m.workspace_id) AS client,
              m.provider, m.domain, m.flagged_reason,
              COUNT(DISTINCT p.test_id) AS runs,
              SUM(p.sent)  AS seeds,
              SUM(p.inbox) AS inbox,
              SUM(p.spam)  AS spam,
              ROUND(SUM(p.inbox) * 100.0 / NULLIF(SUM(p.sent), 0), 1) AS inbox_pct,
              ROUND(SUM(p.spam)  * 100.0 / NULLIF(SUM(p.sent), 0), 1) AS spam_pct,
              MAX(p.tested_at) AS tested_at
         FROM mbx_placement p
         JOIN mailbox_full m ON m.email = p.email
        WHERE p.tested_at >= now() - ($1::int || ' days')::interval
          AND ($2::text IS NULL OR m.workspace_name = $2)
        GROUP BY p.email, client, m.provider, m.domain, m.flagged_reason
        ORDER BY spam_pct DESC NULLS LAST`,
      [POOL_DAYS, client], { tag: 'mailbox-health:placement' },
    )

    const byRecipient = await q<Record<string, string | null>>(
      `SELECT p.rec_type, m.provider AS sender_provider,
              SUM(p.sent)  AS seeds,
              SUM(p.inbox) AS inbox,
              SUM(p.spam)  AS spam,
              ROUND(SUM(p.inbox) * 100.0 / NULLIF(SUM(p.sent), 0), 1) AS inbox_pct
         FROM mbx_placement p
         JOIN mailbox_full m ON m.email = p.email
        WHERE p.tested_at >= now() - ($1::int || ' days')::interval
        GROUP BY p.rec_type, m.provider
       HAVING SUM(p.sent) > 0
        ORDER BY inbox_pct ASC`,
      [POOL_DAYS], { tag: 'mailbox-health:placement:recipients' },
    )

    const runs = await q<Record<string, string | null>>(
      `SELECT test_id, name, status, sent, inbox, inbox_pct, spam_pct, created_at
         FROM mbx_placement_run ORDER BY created_at DESC LIMIT 30`,
      [], { tag: 'mailbox-health:placement:runs' },
    )

    const rows = mailboxes.map(r => ({
      email: String(r.email),
      client: String(r.client),
      provider: r.provider,
      domain: r.domain,
      runs: Number(r.runs),
      seeds: Number(r.seeds),
      inbox: Number(r.inbox),
      spam: Number(r.spam),
      inbox_pct: r.inbox_pct === null ? null : Number(r.inbox_pct),
      spam_pct: r.spam_pct === null ? null : Number(r.spam_pct),
      tested_at: r.tested_at,
      flagged_reason: r.flagged_reason,
      // Judgeable only above the seed floor; below it a spam share is noise.
      judgeable: Number(r.seeds) >= MIN_SEEDS,
    }))

    const flagged = rows.filter(r => r.judgeable && (r.spam_pct ?? 0) >= SPAM_FLAG_PCT)

    return NextResponse.json({
      thresholds: { spam_flag_pct: SPAM_FLAG_PCT, min_seeds: MIN_SEEDS, pool_days: POOL_DAYS },
      mailboxes: rows,
      flagged: flagged.length,
      // What to do with the ones that failed, split by whether the mailbox is
      // worn out. Under the burn threshold it is not burnt, so rest is worth
      // trying; over it, rebuilding on the same domain has been measured not to
      // work and a new domain is the answer.
      flagged_mailboxes: flagged.map(f => ({ email: f.email, client: f.client, spam_pct: f.spam_pct, seeds: f.seeds })),
      by_recipient: byRecipient.map(r => ({
        rec_type: String(r.rec_type),
        sender_provider: String(r.sender_provider),
        seeds: Number(r.seeds),
        inbox_pct: r.inbox_pct === null ? null : Number(r.inbox_pct),
      })),
      runs: runs.map(r => ({
        test_id: String(r.test_id), name: r.name, status: r.status,
        sent: r.sent === null ? null : Number(r.sent),
        inbox_pct: r.inbox_pct === null ? null : Number(r.inbox_pct),
        spam_pct: r.spam_pct === null ? null : Number(r.spam_pct),
        created_at: r.created_at,
      })),
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'mailbox-health:placement' }, extra: { client } })
    const msg = err instanceof Error ? err.message : 'Failed to load placement results'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
