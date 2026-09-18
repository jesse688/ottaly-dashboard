/**
 * Placement test rotation and recovery.
 *
 * TESTING PLAN (Jesse, 2026-09-17): one mailbox per domain per round, 4 seeds
 * each, rotating every two weeks. 427 domains means ~1,708 seeds a round, and
 * roughly four rounds covers every mailbox in the estate.
 *
 * IMPORTANT LIMIT ON WHAT A ROUND PROVES. MAILBOX_MANAGEMENT.md §1.8 measured
 * four same-domain pairs in the same minute and every pair split 75% vs 25%,
 * with the two Butterfly domains disagreeing about which local-part style won.
 * Reputation sits on the MAILBOX, not the domain, so:
 *
 *   - a SPAM result is trustworthy: that mailbox really is landing in spam
 *   - a CLEAN result says nothing about the other mailboxes on that domain
 *
 * Rotation is therefore a sampling schedule, not a domain screen. Untested
 * mailboxes are "unknown", never "clean", and nothing here ever clears a
 * mailbox that was not itself tested.
 *
 * RECOVERY (Jesse's rule, matched to the measured evidence):
 *   under 350 lifetime sends -> rest 14 days, then retest
 *   at or over 350           -> replace, it is already spent
 *
 * The 14-day rest is shorter than anything measured to repair a mailbox (29d
 * and 46d worked; 3-13d did nothing). That is why the retest matters: a short
 * rest is a cheap first try, and if the mailbox is still in spam afterwards it
 * escalates to 30 days rather than going back to sending broken.
 */

const q = require('./queries');
const pl = require('./placement');

const SEEDS_PER_MAILBOX = 4;
const ROUND_DAYS = 14;
const REST_DAYS = 14;          // first attempt for a lightly-used mailbox
const REST_ESCALATED = 30;     // if a retest still shows spam

/**
 * PlusVibe bills placement testing in CREDITS, and one credit is one test run
 * per SENDER ACCOUNT — seeds within a run are free. So the cost of a round is
 * the number of mailboxes tested, not the number of seeds, and testing one
 * mailbox per domain is what makes the estate affordable.
 *
 * Ottaly is on Growth: 1,000 credits a month (Starter 300, Scale 5,000).
 * One mailbox per domain (406) twice a month is 812 credits, which fits with
 * 188 spare for retests. Testing every mailbox fortnightly would cost 3,026
 * and need the Scale plan.
 */
const MONTHLY_CREDITS = 1000;
const ROUNDS_PER_MONTH = 2;

/**
 * Pick one mailbox per domain for the next round.
 *
 * Least-recently-tested first, so rotation covers the estate rather than
 * retesting the same mailbox every time. A mailbox already flagged is skipped:
 * it is in recovery, and retesting it belongs to the recovery cycle.
 */
function nextRound(db, { client = null } = {}) {
  const rows = db.prepare(`
    SELECT m.email, m.workspace_name AS client, m.domain, m.provider,
           m.flagged_reason,
           c.lifetime_sends,
           (SELECT MAX(tested_at) FROM placement_result p WHERE p.email = m.email) AS last_tested
    FROM mailbox m
    LEFT JOIN mailbox_cumulative c ON c.email = m.email
    WHERE m.retired_at IS NULL
      AND m.status <> 'ERROR'
      AND m.workspace_name NOT IN (SELECT workspace_name FROM client_state WHERE state = 'removed')
      AND (? IS NULL OR m.workspace_name = ?)
    ORDER BY m.domain
  `).all(client, client);

  const byDomain = new Map();
  for (const r of rows) {
    if (r.flagged_reason) continue;            // already in recovery
    if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
    byDomain.get(r.domain).push(r);
  }

  const picks = [];
  for (const [domain, list] of byDomain) {
    // Never tested sorts before ever tested, then oldest test first.
    list.sort((a, b) => {
      if (!a.last_tested && !b.last_tested) return 0;
      if (!a.last_tested) return -1;
      if (!b.last_tested) return 1;
      return a.last_tested.localeCompare(b.last_tested);
    });
    const pick = list[0];
    picks.push({
      email: pick.email,
      client: pick.client,
      domain,
      provider: pick.provider,
      lifetime_sends: pick.lifetime_sends,
      last_tested: pick.last_tested,
      never_tested: !pick.last_tested,
      mailboxes_on_domain: list.length,
    });
  }

  picks.sort((a, b) => a.client.localeCompare(b.client) || a.domain.localeCompare(b.domain));
  return picks;
}

/** Round summary: size, seed cost, and how much of the estate it reaches. */
function roundPlan(db, { client = null } = {}) {
  const picks = nextRound(db, { client });
  const byClient = {};
  for (const p of picks) {
    const c = (byClient[p.client] ||= { client: p.client, domains: 0, seeds: 0, never_tested: 0 });
    c.domains++;
    c.seeds += SEEDS_PER_MAILBOX;
    if (p.never_tested) c.never_tested++;
  }
  const total = db.prepare(`
    SELECT COUNT(*) AS mailboxes, COUNT(DISTINCT domain) AS domains
    FROM mailbox m
    WHERE m.retired_at IS NULL AND m.status <> 'ERROR'
      AND m.workspace_name NOT IN (SELECT workspace_name FROM client_state WHERE state = 'removed')
  `).get();

  // One credit per mailbox tested, per round. Seeds inside a run are free.
  const creditsPerRound = picks.length;
  const creditsPerMonth = creditsPerRound * ROUNDS_PER_MONTH;

  return {
    seeds_per_mailbox: SEEDS_PER_MAILBOX,
    round_days: ROUND_DAYS,
    mailboxes_this_round: picks.length,
    seeds_this_round: picks.length * SEEDS_PER_MAILBOX,
    credits_this_round: creditsPerRound,
    credits_per_month: creditsPerMonth,
    monthly_credit_budget: MONTHLY_CREDITS,
    credits_spare: MONTHLY_CREDITS - creditsPerMonth,
    over_budget: creditsPerMonth > MONTHLY_CREDITS,
    // What testing every mailbox would cost, for comparison.
    credits_if_all_tested: total.mailboxes * ROUNDS_PER_MONTH,
    estate_mailboxes: total.mailboxes,
    estate_domains: total.domains,
    // Rounds to touch every mailbox once, at one per domain per round.
    rounds_for_full_coverage: Math.ceil(total.mailboxes / Math.max(1, total.domains)),
    weeks_for_full_coverage:
      Math.ceil(total.mailboxes / Math.max(1, total.domains)) * (ROUND_DAYS / 7),
    by_client: Object.values(byClient).sort((a, b) => b.domains - a.domains),
    picks,
  };
}

/**
 * What to do with each flagged mailbox.
 *
 * Under the burn threshold the mailbox is not worn out, so spam is likely
 * fixable and a rest is worth trying. At or over it, the mailbox is already
 * spent and replacing beats resting — rebuilding on the same domain is the one
 * thing measured NOT to work (Bubble, twice).
 */
function recoveryPlan(db, { client = null } = {}) {
  const flagged = pl.placementByMailbox(db)
    .filter((m) => m.flagged_reason)
    .filter((m) => !client || m.client === client);

  const rest = [], replace = [];
  for (const m of flagged) {
    const spent = (m.lifetime_sends ?? 0) >= q.BURN_THRESHOLD;
    // A mailbox already rested once and still in spam needs the longer rest
    // that the evidence actually supports, not another 14 days.
    const retried = !!m.paused_at;
    const row = {
      ...m,
      lifetime_sends: m.lifetime_sends ?? null,
      action: spent ? 'replace' : 'rest',
      rest_days: retried ? REST_ESCALATED : REST_DAYS,
      retried,
      why: spent
        ? `${m.lifetime_sends ?? '?'} lifetime sends — past the ${q.BURN_THRESHOLD} threshold, `
          + `already spent. Rebuilding on the same domain has been measured not to work.`
        : `${m.lifetime_sends ?? '?'} lifetime sends — under the ${q.BURN_THRESHOLD} threshold, `
          + `so this is not burn-out. Worth a rest`
          + (retried ? `, extended to ${REST_ESCALATED} days since a short rest did not clear it.`
                     : ` of ${REST_DAYS} days, then retest.`),
    };
    (spent ? replace : rest).push(row);
  }

  const domains = new Set(replace.map((r) => r.domain));
  return {
    thresholds: {
      burn: q.BURN_THRESHOLD,
      rest_days: REST_DAYS,
      rest_escalated: REST_ESCALATED,
      spam_pct: pl.SPAM_PAUSE_PCT,
    },
    flagged: flagged.length,
    rest,
    replace,
    // Replacements need new domains, not rebuilt ones.
    replacement_domains_needed: Math.ceil(replace.length / 3),
    est_cost: Number((Math.ceil(replace.length / 3) * 5.30 + replace.length * 2.50).toFixed(2)),
  };
}

/**
 * Coverage: how much of the estate has a placement result, and how old it is.
 * Untested mailboxes are "unknown", never assumed clean — see §1.8 above.
 */
function coverage(db) {
  return db.prepare(`
    SELECT m.workspace_name AS client,
           COUNT(*) AS mailboxes,
           SUM(CASE WHEN p.email IS NOT NULL THEN 1 ELSE 0 END) AS tested,
           SUM(CASE WHEN m.flagged_reason IS NOT NULL THEN 1 ELSE 0 END) AS flagged,
           MAX(p.last_tested) AS last_tested
    FROM mailbox m
    LEFT JOIN (
      SELECT email, MAX(tested_at) AS last_tested FROM placement_result GROUP BY email
    ) p ON p.email = m.email
    WHERE m.retired_at IS NULL AND m.status <> 'ERROR'
      AND m.workspace_name NOT IN (SELECT workspace_name FROM client_state WHERE state = 'removed')
    GROUP BY m.workspace_name
    ORDER BY tested ASC, mailboxes DESC
  `).all();
}

module.exports = {
  nextRound, roundPlan, recoveryPlan, coverage,
  SEEDS_PER_MAILBOX, ROUND_DAYS, REST_DAYS, REST_ESCALATED,
  MONTHLY_CREDITS, ROUNDS_PER_MONTH,
};
