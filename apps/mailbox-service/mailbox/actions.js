/**
 * Action queue and buy calendar.
 *
 * Turns stored measurements into a ranked list of what to do. Every action
 * carries the evidence that produced it, so the dashboard never shows a
 * recommendation you cannot check.
 *
 * Nothing here writes to PlusVibe. Phase 1 and 2 are read-only; these are
 * proposals for a human, and the ones that spend money say so.
 */

const q = require('./queries');

// From MAILBOX_MANAGEMENT.md §3: a new mailbox needs 14 days of warmup plus
// ~6 days of ramp before it carries full load.
const LEAD_TIME_DAYS = 20;
const MBX_PER_DOMAIN = 3;
const DOMAIN_COST = 5.30 / 12;   // annual registration, monthly equivalent
const MBX_COST = 2.50;           // per mailbox per month, top of our range

const SEV = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Rest cycle grouping: three staggered groups so the estate never rests at
 * once. Whole domains stay together — half-resting a domain leaves its
 * remaining mailboxes carrying the same volume on a domain with fewer senders,
 * which is the one thing sends-per-domain says not to do.
 */
function restGroups(mailboxes) {
  const byDomain = new Map();
  for (const m of mailboxes) {
    if (!byDomain.has(m.domain)) byDomain.set(m.domain, []);
    byDomain.get(m.domain).push(m);
  }
  // Largest domains placed first, each into whichever group is smallest.
  const domains = [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length);
  const groups = [[], [], []];
  for (const [domain, mbx] of domains) {
    groups.sort((a, b) => a.length - b.length);
    groups[0].push({ domain, mailboxes: mbx.length });
  }
  return groups.map((g, i) => ({
    group: ['A', 'B', 'C'][i],
    starts_in_days: i * 5,          // stagger so counters never align
    domains: g.length,
    mailboxes: g.reduce((s, d) => s + d.mailboxes, 0),
    domain_list: g.map((d) => d.domain),
  }));
}

function buildActions(db) {
  const states = require('./db').clientStates(db);
  // A paused client is not sending, so it cannot be failing. Leaving them in
  // would fill the queue with runway warnings for accounts nobody is running.
  const paused = new Set(Object.entries(states)
    .filter(([, v]) => v.state === 'paused').map(([k]) => k));

  const clients = q.withRunway(q.clientSummary(db), states)
                   .filter((c) => c.state === 'active');
  const under = q.underperforming(db).filter((r) => !paused.has(r.client));
  const domains = q.domainLoad(db).filter((d) => !paused.has(d.client));
  const settings = q.settingsAudit(db);
  const actions = [];

  // ---- Clients approaching the burn threshold -------------------------------
  for (const c of clients) {
    if (c.over_threshold || c.runway_months === null) continue;
    if (c.runway_months <= 3) {
      actions.push({
        severity: c.runway_months <= 1 ? 'critical' : 'high',
        client: c.client,
        title: `${c.client}: ${c.runway_months} ${c.runway_months === 1 ? 'month' : 'months'} of runway`,
        evidence: `Averages ${c.avg_cum} lifetime sends across ${c.mailboxes} mailboxes, `
          + `sending ${c.sends_per_mbx_per_day}/mbx/day. Reaches the ${q.BURN_THRESHOLD} threshold `
          + `in ${c.runway_months} ${c.runway_months === 1 ? 'month' : 'months'}. `
          + `${c.past_threshold} of them are already past it.`,
        action: 'Start rest cycles (3 staggered groups) to extend runway, or plan replacements.',
        spends_money: false,
        reversible: true,
      });
    }
  }

  // ---- Clients past the threshold AND underperforming ------------------------
  // Being past 350 is not itself a problem: Enviro is at 1,821 and returns
  // 9.16%. Past-threshold plus a weak OOO rate is the real signal.
  const estateOoo = clients.reduce((s, c) => s + (c.ooo_90d || 0), 0)
                  / Math.max(1, clients.reduce((s, c) => s + (c.contacted_90d || 0), 0)) * 100;
  for (const c of clients) {
    if (!c.over_threshold) continue;
    if ((c.ooo_pct ?? 0) < estateOoo * 0.85) {
      actions.push({
        severity: (c.ooo_pct ?? 0) < estateOoo * 0.6 ? 'high' : 'medium',
        client: c.client,
        title: `${c.client}: past threshold and underperforming`,
        evidence: `${c.avg_cum} avg lifetime sends (${c.past_threshold}/${c.mailboxes} past `
          + `${q.BURN_THRESHOLD}) with ${c.ooo_pct}% OOO against an estate average of `
          + `${estateOoo.toFixed(2)}%`
          + (c.emails_per_positive ? `, ${c.emails_per_positive} emails per positive.` : '.'),
        action: 'Rest the worst mailboxes, or rotate onto new domains if rest has already failed.',
        spends_money: false,
        reversible: true,
      });
    }
  }

  // ---- Individual underperforming mailboxes, grouped by client ---------------
  const underByClient = {};
  for (const u of under) (underByClient[u.client] ||= []).push(u);
  for (const [client, list] of Object.entries(underByClient)) {
    const zero = list.filter((m) => (m.ooo ?? 0) === 0);
    actions.push({
      severity: list.length >= 10 ? 'high' : 'medium',
      client,
      title: `${client}: ${list.length} mailboxes below ${q.DEAD_OOO_PCT}% OOO`,
      evidence: `${list.length} mailboxes with at least ${q.MIN_JUDGE} contacted are under `
        + `${q.DEAD_OOO_PCT}% OOO, ${zero.length} of them at zero. `
        + `Average ${Math.round(list.reduce((s, m) => s + m.lifetime_sends, 0) / list.length)} lifetime sends.`,
      action: zero.length >= list.length * 0.4
        ? 'Check whether these are burnt (rest) or badly provisioned (new domains) before spending.'
        : 'Throttle and review after 30 days.',
      spends_money: false,
      reversible: true,
      mailboxes: list.slice(0, 50).map((m) => m.email),
    });
  }

  // ---- Placement tests: mailboxes measured landing in spam --------------------
  // This outranks everything else in the queue. Every other signal here infers
  // deliverability from reply behaviour; a placement test measured it directly.
  // A mailbox landing in spam is not underperforming, it is not being seen.
  const pl = require('./placement');
  const spam = pl.placementByMailbox(db)
    .filter((m) => m.flagged_reason && !paused.has(m.client));
  const spamByClient = {};
  for (const m of spam) (spamByClient[m.client] ||= []).push(m);
  for (const [client, list] of Object.entries(spamByClient)) {
    const worst = list.reduce((a, b) => (b.spam_pct > a.spam_pct ? b : a));
    actions.push({
      severity: 'critical',
      client,
      title: `${client}: ${list.length} mailbox${list.length > 1 ? 'es' : ''} landing in spam`,
      evidence: `Measured by placement test, not inferred. Worst is ${worst.email} at `
        + `${worst.spam_pct}% spam (${worst.seeds} seeds, tested `
        + `${(worst.tested_at || '').slice(0, 10)}). `
        + `Threshold is ${pl.SPAM_PAUSE_PCT}% spam on at least ${pl.MIN_SEEDS} seeds.`,
      action: 'Pause these mailboxes until a later test clears them. They are not being seen.',
      spends_money: false,
      reversible: true,
      mailboxes: list.map((m) => m.email),
    });
  }

  // ---- Domain load -----------------------------------------------------------
  // Sends-per-domain correlates with OOO at r = -0.47, far stronger than
  // mailboxes-per-domain at r = -0.10. It is the volume that matters, not the
  // headcount, and the two are easy to confuse.
  //
  // Inboxing.com-style domains deliberately carry 25-99 mailboxes on one
  // domain at a low per-mailbox limit. That is the product working as sold,
  // not a misconfiguration, so mailbox count alone must never raise an action.
  // What still matters is whether such a domain is pushing enough total volume
  // to hurt, which is the thing r = -0.47 actually measures.
  // 800+ per mailbox over 90 days is ~9/day sustained, where the estate's own
  // heaviest domains sit. A lower bar flags almost everything and says nothing.
  const heavy = domains
    .filter((d) => (d.sent_per_mbx || 0) > 800 && (d.sent_90d || 0) > 3000)
    .sort((a, b) => (b.sent_90d || 0) - (a.sent_90d || 0));
  for (const d of heavy.slice(0, 10)) {
    const bulk = d.mailboxes >= 20;
    actions.push({
      severity: (d.ooo_pct ?? 99) < 3 ? 'high' : 'medium',
      client: d.client,
      title: `${d.domain}: ${d.sent_90d.toLocaleString()} sends on one domain in 90 days`,
      evidence: `${d.mailboxes} mailboxes averaging ${d.sent_per_mbx} sends each, `
        + `${d.ooo_pct}% OOO. Sends-per-domain is the estate's strongest measured risk `
        + `factor (r = -0.47)`
        + (bulk ? `. This looks like a bulk-provisioned domain, so the mailbox count is `
          + `by design — the volume per mailbox is the part worth watching.` : '.'),
      action: bulk
        ? 'Lower the per-mailbox daily limit rather than splitting the domain.'
        : `Cap volume or spread across more domains.`,
      spends_money: false,
      reversible: true,
    });
  }

  // ---- Free estate-wide settings wins ---------------------------------------
  if (settings.randomised === 0) {
    actions.push({
      severity: 'low',
      client: null,
      title: `Randomise daily limits (${settings.total} mailboxes)`,
      evidence: `limit_rand_pct is 0 on every mailbox in the estate. PlusVibe recommends 40.`,
      action: 'Set limit_rand_pct: 40 estate-wide. Free, reversible, no capacity change.',
      spends_money: false,
      reversible: true,
    });
  }
  if (settings.auto_pause_on === 0) {
    actions.push({
      severity: 'medium',
      client: null,
      title: `Rest cycles are off estate-wide (${settings.total} mailboxes)`,
      evidence: `is_auto_pause is disabled on every mailbox. Rest is the one intervention `
        + `measured to restore a burnt mailbox, and it costs nothing.`,
      action: 'Enable staggered rest cycles per client, starting with shortest runway.',
      spends_money: false,
      reversible: true,
    });
  }
  if (settings.errored > 0) {
    actions.push({
      severity: settings.errored > 50 ? 'high' : 'medium',
      client: null,
      title: `${settings.errored} mailboxes in ERROR status`,
      evidence: `These are disconnected, not underperforming — they send nothing at all `
        + `and silently reduce capacity.`,
      action: 'Reconnect or retire. Check whether the client is still active first.',
      spends_money: false,
      reversible: true,
    });
  }

  return actions.sort((a, b) => SEV[a.severity] - SEV[b.severity]);
}

/**
 * Buy calendar: when to order, working back from when capacity is needed.
 *
 * A mailbox ordered today cannot carry load for 20 days (14 warmup + ~6 ramp),
 * so the order date is always the needed date minus 20.
 */
function buyCalendar(db) {
  // Never propose buying capacity for a client who is not sending.
  const states = require('./db').clientStates(db);
  const clients = q.withRunway(q.clientSummary(db), states)
                   .filter((c) => c.state === 'active');

  // Estate-wide OOO is the yardstick for "is the burn actually hurting?".
  const estateOoo = clients.reduce((s, c) => s + (c.ooo_90d || 0), 0)
                  / Math.max(1, clients.reduce((s, c) => s + (c.contacted_90d || 0), 0)) * 100;

  const out = [];
  for (const c of clients) {
    if (c.runway_months === null) continue;            // idle, nothing to plan
    const ooo = c.ooo_pct ?? 0;

    // Past the threshold is NOT by itself a reason to buy. Enviro sits at
    // 1,821 lifetime sends and returns 9.16% OOO; replacing it would burn
    // money to fix nothing. Only buy when the burn is visibly costing
    // performance, or when a client is about to run out of runway.
    const hurting = c.over_threshold && ooo < estateOoo * 0.85;
    const approaching = !c.over_threshold && c.runway_months <= 2;
    if (!hurting && !approaching) continue;

    // Replace only what is actually spent, not a flat quarter of the estate.
    const needed = hurting
      ? Math.max(1, c.past_threshold)
      : Math.max(1, Math.ceil(c.mailboxes * 0.25));
    const domainsNeeded = Math.ceil(needed / MBX_PER_DOMAIN);
    const neededInDays = Math.round((c.runway_months || 0) * 30);
    const orderInDays = Math.max(0, neededInDays - LEAD_TIME_DAYS);
    const orderDate = new Date(Date.now() + orderInDays * 86400000);

    out.push({
      client: c.client,
      mailboxes_needed: needed,
      domains_needed: domainsNeeded,
      needed_in_days: neededInDays,
      order_in_days: orderInDays,
      order_by: orderDate.toISOString().slice(0, 10),
      overdue: orderInDays === 0 && neededInDays < LEAD_TIME_DAYS,
      est_cost: Number((domainsNeeded * DOMAIN_COST * 12 + needed * MBX_COST).toFixed(2)),
      reason: hurting ? 'burn is costing performance' : 'running out of runway',
      note: hurting
        ? `${c.past_threshold} of ${c.mailboxes} past ${q.BURN_THRESHOLD}, `
          + `${ooo}% OOO vs estate ${estateOoo.toFixed(2)}%`
        : `${c.runway_months} ${c.runway_months === 1 ? 'month' : 'months'} of runway, `
          + `${ooo}% OOO`,
    });
  }
  return out.sort((a, b) => a.order_in_days - b.order_in_days);
}

module.exports = { buildActions, buyCalendar, restGroups, LEAD_TIME_DAYS, MBX_PER_DOMAIN };
