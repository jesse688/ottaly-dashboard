import { NextResponse, type NextRequest } from 'next/server'
import pool, { ready } from '@/lib/db'
import { getPlusVibeReceived, type PVReceivedEmail } from '@/lib/plusvibe'
import { detectWarmupFull } from '@/lib/classify'
import { resolveClientId } from '@/lib/clients'
import { notifyClientOfLeadReply } from '@/lib/email'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ── PlusVibe unibox reconciler — THE reply ingest path ───────────────────────
// Ottaly uses PlusVibe ONLY (Bison/EmailBison is retired and its API returns
// nothing). Replies live in the PlusVibe unibox API. This cron pulls received
// emails per workspace and upserts them into unibox_replies so they flow through
// classify → Review. There is no working webhook — SCHEDULE this every ~15 min.
//
// Auth ?secret=CRON_SECRET. ?days=N window (default 3, max 90). ?ws=<id> one workspace.
const BOUNCE_RE = /(^|[._-])(mailer-daemon|postmaster|no-?reply|bounce|abuse)@/
// Free/consumer email domains — a domain match against these is NOT a reliable
// "same company" signal (anyone can have a gmail), so colleague-matching for the
// Others folder ignores them and requires an exact lead-email match instead.
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'live.co.uk', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'icloud.com',
  'me.com', 'aol.com', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com',
])

// PlusVibe classifies every reply itself (label). We TRUST that label to route at
// ingest — so classification never depends on Gemini (which 429s/503s). Gemini is
// only a fallback refinement for replies PV left unlabelled.
//   done  = trust PV, no AI needed.   pending = let the classify worker refine.
function routeFromPvLabel(label: string): { category: string | null; folder: string; state: 'done' | 'pending' } {
  switch (label) {
    case 'INTERESTED':
    case 'MEETING_BOOKED':      return { category: 'interested',     folder: 'review',         state: 'done' }
    case 'QUESTION':            return { category: 'question',       folder: 'review',         state: 'done' }
    case 'NOT_INTERESTED':      return { category: 'not_interested', folder: 'not_interested', state: 'done' }
    case 'UNSUBSCRIBE':
    case 'UNSUBSCRIBED':
    case 'DO_NOT_CONTACT':      return { category: 'unsubscribe',    folder: 'unsubscribe',    state: 'done' }
    case 'OUT_OF_OFFICE':
    case 'AUTOMATIC_REPLY':
    case 'AUTO_REPLY':          return { category: 'ooo_auto_reply', folder: 'ooo',            state: 'done' }
    // Unknown / no PV label → Review as pending so it's VISIBLE now; the AI refines
    // it later if/when Gemini is available. Never hidden, never Gemini-blocked.
    default:                    return { category: null,            folder: 'review',         state: 'pending' }
  }
}

// STABLE per-email identity for dedup. The RFC Message-ID is best (identical no
// matter which feed/run surfaces the email). When it's absent, PV's internal
// `id` DIFFERS between the 'received' and 'untracked' feeds and across runs — so
// keying on it created TWO rows for one email (it then showed in both Review and
// Leads). Fall back to a CONTENT signature (sender + minute + subject) that is
// identical for the same email everywhere, so ON CONFLICT collapses them to one.
function stableEmailKey(e: PVReceivedEmail): string {
  if (e.message_id) return `pv_${e.message_id}`
  const sender = (e.from_address_email || e.lead || '').toLowerCase()
  // Round the timestamp to the minute so tiny per-feed jitter can't split it.
  const minute = (e.timestamp_created || '').slice(0, 16)
  const subj = (e.subject || '').trim().slice(0, 120).toLowerCase()
  return `pvc_${sender}|${minute}|${subj}`
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (!secret || !process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await ready()

  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '3', 10) || 3, 1), 90)
  const sinceMs = Date.now() - days * 86400_000
  const onlyWs = url.searchParams.get('ws')
  // EXPLICIT, CONFIRMED opt-in only. By default we NEVER touch the client side for
  // historical replies — the automatic run only seeds the client thread + notifies
  // for replies that JUST arrived. ?backfill=1 seeds the client thread for ALL
  // fetched replies (historical), and NEVER sends an email even then.
  const backfill = url.searchParams.get('backfill') === '1'

  // Active client workspaces (PlusVibe workspace_id lives on portal_clients).
  const wsRows = await pool.query(
    `SELECT DISTINCT workspace_id FROM portal_clients WHERE workspace_id IS NOT NULL AND workspace_id <> ''`
  )
  const allWorkspaces = (wsRows.rows as { workspace_id: string }[])
    .map(r => r.workspace_id)
    .filter(w => !onlyWs || w === onlyWs)
  // ROTATE the start each minute. The 22s time budget can stop mid-sweep, and with
  // a FIXED order the same trailing workspaces were starved every run — their
  // replies never reached the unibox. Rotating by a per-minute offset guarantees
  // every workspace leads the queue periodically, so all get covered within a few
  // runs instead of some being permanently skipped.
  const rot = allWorkspaces.length ? Math.floor(Date.now() / 60_000) % allWorkspaces.length : 0
  const workspaces = [...allWorkspaces.slice(rot), ...allWorkspaces.slice(0, rot)]

  type Counts = { seen: number; inserted: number; healed: number; ooo: number; skipped_warmup: number; skipped_bounce: number; skipped_old: number; skipped_outbound: number }
  const zero = (): Counts => ({ seen: 0, inserted: 0, healed: 0, ooo: 0, skipped_warmup: 0, skipped_bounce: 0, skipped_old: 0, skipped_outbound: 0 })
  const errors: string[] = []

  // Process ONE workspace: fetch its PlusVibe received emails and upsert them.
  async function processWs(ws: string): Promise<Counts> {
    const c = zero()
    const clientId = await resolveClientId(ws)

    // Known leads for this workspace — used to match "Others" folder replies
    // (which carry NO lead link) to the right lead. exactLeads = the lead's own
    // address; leadByDomain = one lead per CORPORATE domain (so a colleague
    // replying from a different address at the same company is linked to that
    // lead). The Others folder is mostly cold-inbound spam, so anything that
    // matches NEITHER is skipped — we never flood the unibox with it.
    const exactLeads = new Set<string>()
    const leadByDomain = new Map<string, string>()
    try {
      const lr = await pool.query(
        `SELECT DISTINCT lower(email) AS email FROM esp_leads
          WHERE workspace_id = $1 AND email IS NOT NULL AND email <> ''`, [ws])
      for (const row of lr.rows as { email: string }[]) {
        const em = row.email
        exactLeads.add(em)
        const dom = em.split('@')[1] || ''
        if (dom && !GENERIC_DOMAINS.has(dom) && !leadByDomain.has(dom)) leadByDomain.set(dom, em)
      }
    } catch { /* if leads can't load, untracked matching just no-ops (skips Others) */ }

    let emails: PVReceivedEmail[] = []
    try {
      // Pull BOTH the tracked "received" feed AND the "untracked" Others folder.
      // A lead's follow-up whose threading headers don't match lands in Others
      // and is invisible to the received feed — that's the bug where a reply
      // shows in PlusVibe but never reaches the client dashboard. Merge + dedupe
      // by id so an email appearing in both feeds is processed once.
      // The "Others" folder is HUGE (thousands of cold-inbound items) and was
      // blowing the 30s cron timeout. Cap its paging hard — we only need the
      // recent top of it to catch the occasional colleague/forwarded reply; the
      // date window bounds the rest. The tracked feed (real campaign replies) is
      // small, so it keeps a normal page budget.
      const [tracked, untracked] = await Promise.all([
        getPlusVibeReceived(ws, { sinceMs, emailType: 'received', maxPages: 10 }),
        getPlusVibeReceived(ws, { sinceMs, emailType: 'untracked', maxPages: 2 }),
      ])
      // Tag each email with the feed it came from. The direction guard treats the
      // two differently: in 'untracked' (Others), PV's `lead` field is unreliable
      // (that's WHY it's untracked), so we must not use the sender≠lead test there
      // or we'd drop genuine replies like the one this fix recovers.
      // Dedup across BOTH feeds by the stable content identity (not PV's per-feed
      // id) so the same email surfacing in received AND untracked is one row.
      const byId = new Map<string, PVReceivedEmail & { _feed: 'received' | 'untracked' }>()
      for (const e of tracked) {
        const k = stableEmailKey(e)
        if (!byId.has(k)) byId.set(k, { ...e, _feed: 'received' })
      }
      for (const e of untracked) {
        const k = stableEmailKey(e)
        if (!byId.has(k)) byId.set(k, { ...e, _feed: 'untracked' })
      }
      emails = [...byId.values()]
    } catch (err) {
      errors.push(`${ws}: ${String(err).slice(0, 100)}`)
      return c
    }

    for (const e of emails) {
      const received = e.timestamp_created ? Date.parse(e.timestamp_created) : NaN
      if (!Number.isNaN(received) && received < sinceMs) { c.skipped_old++; continue }
      c.seen++

      // DIRECTION GUARD. The PV "received" feed can surface our OWN outbound
      // messages (PlusVibe threads the conversation, so a reply WE sent to a lead
      // comes back tagged with that lead). `e.lead` is the campaign lead's address
      // regardless of who authored this specific message, so keying off it alone
      // misattributes our reply as an inbound "lead replied" — which fired a bogus
      // notification (e.g. Sam→Jonathan re-ingested as "Jonathan replied").
      //
      // The real author is `from_address_email`. A GENUINE inbound reply has the
      // prospect as author (from == e.lead) — the same canonical test
      // getPlusVibeInbound uses (from_address_email === leadEmail). Skip as outbound
      // when EITHER: the author is our receiving mailbox (`eaccount`), OR the author
      // is NOT the campaign lead (it's us or a teammate). Two independent signals,
      // so an empty/garbled `eaccount` can't let an outbound echo slip through.
      const feed = (e as PVReceivedEmail & { _feed?: 'received' | 'untracked' })._feed ?? 'received'
      const sender = (e.from_address_email || '').toLowerCase()
      const ourMailbox = (e.eaccount || '').toLowerCase()
      const campaignLead = (e.lead || '').toLowerCase()
      const authoredByUs = !!sender && !!ourMailbox && sender === ourMailbox

      // COLLEAGUE DETECTION. A reply can come from a DIFFERENT person at the lead's
      // company (e.g. lee@einhell.com replies on the thread to rebecca@einhell.com).
      // That sender ≠ the campaign lead, but it's a GENUINE inbound reply — it must
      // NOT be dropped as "outbound". Our own mailboxes live on OUR sending domains,
      // never the lead's domain, so "sender domain == lead domain AND sender ≠ lead"
      // cleanly identifies a same-company colleague and never our own echo.
      const senderDomain = sender.split('@')[1] || ''
      const leadDomain = campaignLead.split('@')[1] || ''
      const sameCompanyColleague = !!senderDomain && senderDomain === leadDomain && sender !== campaignLead

      // sender≠lead only proves "outbound" when `lead` is trustworthy — i.e. the
      // tracked 'received' feed. In 'untracked' (Others) PV's lead field is
      // unreliable, so rely on the authored-by-our-mailbox signal alone there.
      // EXCEPTION: never treat a same-company colleague as outbound — surface it.
      const authoredByNonLead = feed === 'received' && !!sender && !!campaignLead
        && sender !== campaignLead && !sameCompanyColleague
      if (authoredByUs || authoredByNonLead) { c.skipped_outbound++; continue }

      // OTHERS-FOLDER POLICY: ACCEPT EVERYTHING except the deterministic noise that
      // is filtered elsewhere — warm-up (tag-based, below), bounces (BOUNCE_RE,
      // below) and our own outbound (guard above). We do NOT drop "unmatched"
      // senders: a REFERRAL from a company we never emailed has no lead/domain
      // trace, so skipping unmatched would lose it. Everything that isn't known
      // noise flows in and lands in Review for a human. We still try to MATCH the
      // sender to a known lead (exact, or same corporate domain) so colleague
      // replies get linked — but a miss just means it's keyed under the sender.
      let untrackedMatch: string | null = null
      if (feed === 'untracked' && !exactLeads.has(sender)) {
        const m = (senderDomain && !GENERIC_DOMAINS.has(senderDomain)) ? leadByDomain.get(senderDomain) : undefined
        if (m && m !== sender) untrackedMatch = m              // colleague of a known lead
      }

      // The lead = the actual author (proven to be the prospect by the guard above),
      // falling back to the campaign lead. They're the same for a genuine reply.
      const lead = (sender || campaignLead || '').toLowerCase()
      if (!lead || BOUNCE_RE.test(lead)) { c.skipped_bounce++; continue }

      const warm = await detectWarmupFull(ws, { subject: e.subject ?? '', bodyText: e.content_preview ?? '' })
      if (warm.isWarmup) { c.skipped_warmup++; continue }

      // Route by PV's own label (no Gemini dependency). Unlabelled → Review pending.
      let { category, folder, state } = routeFromPvLabel((e.label ?? '').toUpperCase())
      // A same-company colleague reply is keyed under the COLLEAGUE's email, so it
      // won't thread under the original lead on the client dashboard. Force it into
      // Review and stamp matched_lead_email so the operator sees the hint and can
      // "Assign to lead" (per the chosen workflow: surface, don't auto-attach).
      // A colleague reply (received-feed same-domain, OR an Others-folder
      // domain match) is keyed under the COLLEAGUE's email, so stamp
      // matched_lead_email and force it into Review so the operator can
      // "Assign to lead" and thread it to the real lead's dashboard.
      const matchedLeadEmail = sameCompanyColleague ? campaignLead : untrackedMatch
      if (sameCompanyColleague || untrackedMatch) { folder = 'review'; state = 'done' }
      const isOoo = folder === 'ooo'

      // Content-stable key (Message-ID, else sender+minute+subject) so the same
      // email never creates two rows across feeds/runs. THIS is the dup fix: the
      // old `message_id || id` split into two rows when message_id was absent and
      // the two feeds gave different ids — the email then showed in Review AND Leads.
      const dedupeKey = stableEmailKey(e)

      const ins = await pool.query(
        `INSERT INTO unibox_replies
           (bison_team_id, bison_reply_id, workspace_id, client_id, lead_email, sender_email,
            subject, body_preview, classify_state, folder, category, raw, received_at,
            ingest_source, mailbox_email, campaign_id, is_forwarded, matched_lead_email, matched_by, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,'pv-api',$13,$14,$15,$16,$17,NOW())
         ON CONFLICT (bison_team_id, bison_reply_id) DO UPDATE SET
           last_seen_at  = NOW(),
           workspace_id  = COALESCE(unibox_replies.workspace_id, EXCLUDED.workspace_id),
           client_id     = COALESCE(unibox_replies.client_id, EXCLUDED.client_id),
           mailbox_email = COALESCE(unibox_replies.mailbox_email, EXCLUDED.mailbox_email),
           matched_lead_email = COALESCE(unibox_replies.matched_lead_email, EXCLUDED.matched_lead_email),
           updated_at    = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [
          ws, dedupeKey, ws, clientId, lead,
          e.subject ?? null, e.content_preview?.slice(0, 500) ?? null,
          state, folder, category, JSON.stringify(e),
          e.timestamp_created ?? new Date().toISOString(),
          e.eaccount ?? null, e.campaign_id ?? null,
          !!matchedLeadEmail, matchedLeadEmail, matchedLeadEmail ? 'domain' : null,
        ]
      ).catch(err => { console.error(`[pv-reconcile] upsert failed ws=${ws} id=${e.id}:`, err); return null })

      if (!ins) continue
      const isNew = ins.rows[0]?.inserted === true
      if (isNew) { c.inserted++; if (isOoo) c.ooo++ } else c.healed++

      // How old is this reply? Everything client-facing is gated on this so we NEVER
      // touch the client side for HISTORICAL replies automatically.
      const recvMs = e.timestamp_created ? Date.parse(e.timestamp_created) : NaN
      const ageMs = Number.isNaN(recvMs) ? Infinity : Date.now() - recvMs
      const isFreshSeed = ageMs <= 60 * 60_000     // arrived in last hour (covers cron gaps)
      const isFreshNotify = ageMs <= 15 * 60_000   // arrived in last 15 min (notify only)

      // CLIENT THREAD: seed portal_emails ONLY for genuinely-fresh replies, or when
      // an admin EXPLICITLY runs ?backfill=1. Historical replies are NEVER
      // auto-backfilled into client dashboards — that's opt-in + confirmed only.
      if (isFreshSeed || backfill) {
        const bodyHtml = e.body?.html ?? e.html_body ?? null
        const bodyText = e.body?.text ?? e.text_body ?? e.content_preview ?? null
        await pool.query(
          `INSERT INTO portal_emails
             (id, workspace_id, lead_email, direction, subject, body_html, body_text,
              content_preview, from_email, to_email, is_unread, message_id, timestamp_created, raw)
           VALUES ($1,$2,$3,'IN',$4,$5,$6,$7,$8,$9,1,$10,$11,$12::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [dedupeKey, ws, lead, e.subject ?? null, bodyHtml, bodyText,
           (bodyText ?? '').slice(0, 200) || null, e.from_address_email ?? lead, e.eaccount ?? null,
           e.message_id ?? null, e.timestamp_created ?? new Date().toISOString(), JSON.stringify(e)]
        ).catch(err => console.error('[pv-reconcile] portal_emails insert failed:', err))

        // NOTIFY: a first-ingest, just-arrived (<15 min) human reply where the
        // client is already ENGAGED with this lead. NEVER on backfill / historical.
        //
        // "Engaged" used to require a portal OUT message (sent_via_portal=true).
        // That suppressed the alert whenever the client hadn't yet replied FROM the
        // portal — so a lead replying to the original campaign email (the common
        // case, e.g. the Ottaly test) never notified. Widen "engaged" to ALSO count
        // an established lead: one that's INTERESTED/MEETING_BOOKED, or already has a
        // lead-notification record. The very first cold reply that turns a prospect
        // INTO a lead is still covered by the separate new-lead notification, so this
        // can't double-fire on the initial contact.
        if (isNew && isFreshNotify && !isOoo && !backfill) {
          // "Engaged" = the client has ALREADY been told about this lead, so a NEW
          // inbound reply is a genuine follow-up worth alerting on. Two signals:
          //   (a) the client sent this lead a portal message, OR
          //   (b) the lead is an established INTERESTED/MEETING_BOOKED lead.
          // BUT: the reply that FIRST made them a lead must NOT re-notify here — the
          // separate new-lead notification already covered it. That false re-fire
          // happened when a delayed ingest (DB timeout) inserted the ORIGINAL reply
          // late, still inside the 15-min window, as isNew → "Liam replied" when
          // Liam's only message was the one that made him a lead. So require this
          // reply to be NEWER than when the lead was established.
          const engaged = await pool.query(
            `SELECT
               EXISTS (SELECT 1 FROM portal_emails
                        WHERE workspace_id=$1 AND lower(lead_email)=lower($2)
                          AND direction='OUT' AND sent_via_portal=true) AS client_replied,
               (SELECT MIN(COALESCE(first_replied_at, created_at)) FROM esp_leads
                  WHERE workspace_id=$1 AND lower(email)=lower($2)
                    AND (status IN ('INTERESTED','MEETING_BOOKED') OR label='INTERESTED')) AS lead_since`,
            [ws, lead]
          ).catch(() => ({ rows: [{ client_replied: false, lead_since: null }] }))
          const row = (engaged.rows[0] ?? {}) as { client_replied?: boolean; lead_since?: string | null }
          const leadSinceMs = row.lead_since ? Date.parse(row.lead_since) : NaN
          // This reply post-dates the lead being established (a real follow-up)?
          // Give a 2-min grace so the original reply + its own lead-stamp (which can
          // land seconds apart) aren't treated as a follow-up of themselves.
          const isFollowUp = !Number.isNaN(recvMs) && !Number.isNaN(leadSinceMs)
            && recvMs > leadSinceMs + 2 * 60_000
          const shouldNotify = row.client_replied === true || isFollowUp
          if (shouldNotify) {
            const bodyText = e.body?.text ?? e.text_body ?? e.content_preview ?? ''
            // Notify about the ACTUAL sender of this reply (falls back to the lead
            // key only if the feed gave no from address). The outbound guard above
            // already ensured this isn't our own mailbox.
            const replier = sender || lead
            void notifyClientOfLeadReply(ws, replier, replier, bodyText.slice(0, 300), dedupeKey)
          }
        }
      }
    }
    return c
  }

  // Run workspaces in PARALLEL batches so the whole sweep finishes in seconds
  // (sequential 20-workspace runs were blowing past cron-job.org's 30s timeout).
  const CONC = 6
  // HARD TIME BUDGET. cron-job.org kills the request at 30s and marks the run
  // "failed (timeout)" — which then trips the ingest-down alarm even though the
  // pipeline is fine. Stop launching new batches at 22s and return what we've
  // done as a PARTIAL success; the next minute's run continues. A complete run
  // that just covers fewer workspaces beats a 30s hard-kill that logs nothing.
  const DEADLINE = Date.now() + 22_000
  const totals = zero()
  let processedWs = 0
  for (let i = 0; i < workspaces.length; i += CONC) {
    if (Date.now() > DEADLINE) { errors.push(`time-budget hit after ${processedWs}/${workspaces.length} workspaces`); break }
    const results = await Promise.all(workspaces.slice(i, i + CONC).map(processWs))
    processedWs += results.length
    for (const c of results) {
      totals.seen += c.seen; totals.inserted += c.inserted; totals.healed += c.healed; totals.ooo += c.ooo
      totals.skipped_warmup += c.skipped_warmup; totals.skipped_bounce += c.skipped_bounce; totals.skipped_old += c.skipped_old
      totals.skipped_outbound += c.skipped_outbound
    }
  }
  // ── CONTINUOUS AUTO-DEDUP ──────────────────────────────────────────────────
  // ROOT-CAUSE GUARD. TWO reconcilers write this table — this one (source
  // 'pv-api', key pv_<message-id>) and an EXTERNAL one (source 'pv-reconciler',
  // raw-id key). Their keys can't collide, so the same email lands twice and the
  // scheduled dedup cron only cleaned it hours later. Instead, collapse true
  // duplicates HERE every minute so they never surface.
  //
  // Identity = the RFC Message-ID (in raw for BOTH sources, so it's exact and
  // source-agnostic) — NOT subject, so genuine same-subject follow-ups are safe.
  // CLIENT-SAFE: keeps a marked lead first (never deletes a billed/triaged row),
  // then the most-enriched/classified copy; deletes only the redundant rest.
  // Clients read leads/threads, not raw unibox rows, so collapsing a duplicate
  // here changes nothing they see. Bounded to recent rows so it's cheap.
  // NO-DATA-LOSS RULE: only ever delete a duplicate that is genuinely EMPTY — no
  // Companies-House data, not enriched, not a marked lead, no real classification.
  // If a duplicate carries ANY data we leave it untouched (better a rare visible
  // dup than losing an enriched/marked row). So a bare fresh copy is removed while
  // its enriched twin always survives — never the other way round.
  // MERGE-THEN-DELETE (no data loss, and it actually collapses dupes). The keeper
  // first ABSORBS every non-null field its duplicates have that it lacks (CH data,
  // enrichment, classification, confidence, links, lead/info status). Only THEN are
  // the now-redundant copies deleted. So a lead can never lose its data, and dupes
  // — even when both copies are classified — collapse to one. Marked leads are
  // never deleted. Ordering = merge first, delete second, so a failed delete can't
  // lose data. ORDER defines the keeper consistently in both steps.
  const RANK_ORDER = `
    marked_as_lead DESC,
    (ch_data IS NOT NULL OR enrich_state = 'matched') DESC,
    (category IS NOT NULL AND category NOT IN ('pending','other')) DESC,
    COALESCE(confidence, 0) DESC,
    (ingest_source = 'pv-api') DESC,
    created_at ASC`
  // The SAME email carries ONE RFC Message-ID, but each ingest path stores it
  // under a different JSON key: pv-api → raw.message_id, the Bison webhook →
  // raw.raw_message_id. Coalesce them so a webhook copy and a pv-api copy of the
  // same email share one identity and collapse. (No content fallback — matching
  // the real Message-ID can't merge two genuinely-different emails.)
  const MID = `lower(COALESCE(NULLIF(raw->>'message_id',''), NULLIF(raw->>'raw_message_id','')))`
  const SCOPE = `${MID} IS NOT NULL AND received_at > NOW() - INTERVAL '14 days'`
  let deduped = 0
  const ddClient = await pool.connect()
  try {
    await ddClient.query('BEGIN')
    // 1. Keeper absorbs the best available data from its duplicate group.
    await ddClient.query(`
      WITH ranked AS (
        SELECT id, workspace_id, ${MID} AS mid,
          ROW_NUMBER() OVER (PARTITION BY workspace_id, ${MID} ORDER BY ${RANK_ORDER}) AS rn,
          COUNT(*) OVER (PARTITION BY workspace_id, ${MID}) AS grp_n
          FROM unibox_replies WHERE ${SCOPE}
      ),
      agg AS (
        SELECT r.workspace_id, r.mid,
          (array_agg(u.ch_data)      FILTER (WHERE u.ch_data IS NOT NULL))[1] AS ch_data,
          bool_or(u.enrich_state = 'matched')                                 AS matched,
          max(u.confidence)                                                   AS confidence,
          (array_agg(u.category)     FILTER (WHERE u.category IS NOT NULL AND u.category NOT IN ('pending','other')))[1] AS category,
          (array_agg(u.campaign_id)  FILTER (WHERE u.campaign_id IS NOT NULL))[1]     AS campaign_id,
          (array_agg(u.portal_email_id) FILTER (WHERE u.portal_email_id IS NOT NULL))[1] AS portal_email_id
        FROM ranked r JOIN unibox_replies u ON u.id = r.id
        WHERE r.grp_n > 1
        GROUP BY r.workspace_id, r.mid
      )
      UPDATE unibox_replies k SET
        ch_data         = COALESCE(k.ch_data, a.ch_data),
        enrich_state    = CASE WHEN k.enrich_state = 'matched' OR a.matched THEN 'matched' ELSE k.enrich_state END,
        confidence      = GREATEST(COALESCE(k.confidence, 0), COALESCE(a.confidence, 0)),
        category        = CASE WHEN k.category IS NULL OR k.category IN ('pending','other') THEN COALESCE(a.category, k.category) ELSE k.category END,
        campaign_id     = COALESCE(k.campaign_id, a.campaign_id),
        portal_email_id = COALESCE(k.portal_email_id, a.portal_email_id),
        updated_at      = NOW()
      FROM ranked r JOIN agg a ON a.workspace_id = r.workspace_id AND a.mid = r.mid
      WHERE k.id = r.id AND r.rn = 1`)
    // 2. Delete the redundant copies (keeper now has their data). Never a marked lead.
    // CRITICAL: partition by the SAME ${MID} as the merge above — NOT
    // lower(raw->>'message_id'). Using message_id alone put every reply that has
    // only a raw_message_id (webhook path / no PV message_id) into one shared
    // NULL partition and deleted all but one — destroying genuinely-distinct
    // replies. That made real replies vanish from the unibox. Same identity in
    // both steps = only true same-Message-ID duplicates ever collapse.
    const dd = await ddClient.query(`
      WITH ranked AS (
        SELECT id, marked_as_lead,
          ROW_NUMBER() OVER (PARTITION BY workspace_id, ${MID} ORDER BY ${RANK_ORDER}) AS rn
          FROM unibox_replies WHERE ${SCOPE}
      )
      DELETE FROM unibox_replies u USING ranked r
       WHERE u.id = r.id AND r.rn > 1 AND r.marked_as_lead = FALSE`)
    deduped = dd.rowCount ?? 0
    await ddClient.query('COMMIT')
  } catch (err) {
    await ddClient.query('ROLLBACK').catch(() => {})
    errors.push(`dedup: ${String(err).slice(0, 80)}`)
  } finally {
    ddClient.release()
  }

  const summary = { workspaces: processedWs, totalWorkspaces: workspaces.length, ...totals, deduped, errors }

  await pool.query(
    `INSERT INTO esp_sync_log (source, status, leads_synced, finished_at) VALUES ($1,$2,$3,NOW())`,
    ['pv-reconcile', summary.errors.length === 0 ? 'success' : 'partial', summary.inserted]
  ).catch(() => {})

  return NextResponse.json({ ok: true, days, ...summary })
}
