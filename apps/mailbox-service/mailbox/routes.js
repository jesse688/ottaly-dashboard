/**
 * Mailbox system API routes.
 *
 * Read-only in Phase 1. Nothing here changes a PlusVibe setting — the only
 * write is /refresh, which re-reads PlusVibe into the local store.
 */

const express = require('express');
const q = require('./queries');
const store = require('./db');

const router = express.Router();

// One shared handle. SQLite readers are cheap and this keeps the page fast.
let db = null;
function getDb() {
  if (!db) db = q.open();
  return db;
}

function wrap(fn) {
  return (req, res) => {
    try {
      res.json(fn(getDb(), req));
    } catch (e) {
      console.error('[mailbox]', e.message);
      res.status(500).json({ error: e.message });
    }
  };
}

/**
 * Everything the dashboard's top level needs, in one call.
 * With ?client=, every figure is scoped to that client instead of the estate.
 */
router.get('/overview', wrap((d, req) => {
  const only = req.query.client || null;
  const keep = (r) => !only || r.client === only || r.workspace_name === only;

  const states = store.clientStates(d);
  let clients = q.withRunway(q.clientSummary(d), states);
  let under = q.underperforming(d);
  let domains = q.domainLoad(d);
  const settings = only ? q.settingsAudit(d, only) : q.settingsAudit(d);
  if (only) {
    clients = clients.filter((c) => c.client === only);
    under = under.filter(keep);
    domains = domains.filter(keep);
  }

  // A domain carrying far more than the 3-mailbox norm, or far more volume
  // than its peers, is the estate's strongest measured risk (r = -0.47).
  const heavyDomains = domains.filter((x) => x.mailboxes > 4 || (x.sent_90d || 0) > 3000);

  return {
    generated_at: new Date().toISOString(),
    last_ingest: q.lastRun(d),
    focus: only,
    all_clients: q.withRunway(q.clientSummary(d)).map((c) => c.client).sort(),
    providers: q.providerStats(d),
    thresholds: {
      burn: q.BURN_THRESHOLD,
      min_judge: q.MIN_JUDGE,
      dead_ooo_pct: q.DEAD_OOO_PCT,
    },
    estate: {
      mailboxes: settings.total,
      domains: domains.length,
      clients: clients.length,
      ...settings,
    },
    clients,
    underperforming: under.length,
    heavy_domains: heavyDomains.length,
  };
}));

router.get('/clients', wrap((d, req) => {
  const rows = q.withRunway(q.clientSummary(d), store.clientStates(d));
  return req.query.client ? rows.filter((r) => r.client === req.query.client) : rows;
}));

/**
 * Client states. Dashboard-only — nothing here touches PlusVibe, so a client's
 * workspace, mailboxes and campaigns are left exactly as they are.
 *
 *   active   normal
 *   paused   still ours, not sending. Visible, but raises no actions.
 *   removed  gone. Hidden everywhere; history kept, never deleted.
 */
router.get('/client-states', wrap((d) => {
  const states = store.clientStates(d);
  const all = q.withRunway(q.clientSummary(d), states);
  // Removed clients are absent from clientSummary, so list them from the
  // state table itself or they would be impossible to restore from the UI.
  const removed = store.clientsInState(d, 'removed').map((name) => ({
    client: name, state: 'removed', note: states[name]?.note || null,
    changed_at: states[name]?.changed_at || null,
  }));
  return {
    active: all.filter((c) => c.state === 'active').map((c) => c.client),
    paused: all.filter((c) => c.state === 'paused')
               .map((c) => ({ client: c.client, note: c.state_note, mailboxes: c.mailboxes })),
    removed,
  };
}));

router.post('/client-state', express.json(), wrap((d, req) => {
  const { client, state, note } = req.body || {};
  if (!client) throw new Error('client is required');
  if (!state) throw new Error('state is required');
  const out = store.setClientState(d, client, state, note, new Date().toISOString());
  return { ok: true, ...out };
}));

router.get('/mailboxes', wrap((d, req) => {
  const rows = q.judgeable(d, {
    minContacted: Number(req.query.min_contacted) || q.MIN_JUDGE,
  });
  const client = req.query.client;
  return client ? rows.filter((r) => r.client === client) : rows;
}));

router.get('/underperforming', wrap((d, req) => {
  const rows = q.underperforming(d, {
    threshold: Number(req.query.threshold) || q.DEAD_OOO_PCT,
    minContacted: Number(req.query.min_contacted) || q.MIN_JUDGE,
  });
  return req.query.client ? rows.filter((r) => r.client === req.query.client) : rows;
}));

router.get('/domains', wrap((d, req) => {
  const rows = q.domainLoad(d);
  return req.query.client ? rows.filter((r) => r.client === req.query.client) : rows;
}));

router.get('/actions', wrap((d, req) => {
  const rows = require('./actions').buildActions(d);
  // Estate-wide items (client: null) stay out of a client view — they are not
  // that client's problem and would misrepresent the focused numbers.
  return req.query.client ? rows.filter((r) => r.client === req.query.client) : rows;
}));

router.get('/buy-calendar', wrap((d, req) => {
  const rows = require('./actions').buyCalendar(d);
  return req.query.client ? rows.filter((r) => r.client === req.query.client) : rows;
}));

/** Proposed rest-cycle grouping for one client. Proposal only — writes nothing. */
router.get('/rest-groups', wrap((d, req) => {
  const client = req.query.client;
  if (!client) throw new Error('client query parameter required');
  const rows = q.judgeable(d, { minContacted: 0 }).filter((r) => r.client === client);
  return { client, mailboxes: rows.length, groups: require('./actions').restGroups(rows) };
}));

router.get('/trend', wrap((d, req) =>
  q.estateTrend(d, Number(req.query.weeks) || 12, req.query.client || null)));

router.get('/settings-audit', wrap((d) => q.settingsAudit(d)));

router.get('/providers', wrap((d) => q.providerStats(d)));

/**
 * Bounce webhook receiver. PlusVibe POSTs here the moment a bounce happens,
 * which is both faster and cheaper than polling. Needs a public HTTPS URL, so
 * it only does anything once this is deployed somewhere reachable.
 */
router.post('/bounce-webhook', express.json({ limit: '2mb' }),
  require('./bounce-webhook').handler(getDb));

/**
 * Bounces, classified by cause.
 *
 * A bounce count cannot say what to do — the same number can mean "lower the
 * volume" or "fix the data". The cause comes from the message text; see
 * bounce.js for why nothing else is reliable.
 */
router.get('/bounces', wrap((d, req) => {
  const bq = require('./bounce-queries');
  const client = req.query.client || null;
  const days = Number(req.query.days) || 14;
  const tenantDays = bq.tenantByDay(d, { days: 45 });
  const worst = tenantDays[0];
  return {
    thresholds: { min_sends: bq.MIN_SENDS, tenant_alert: bq.TENANT_ALERT },
    // 3-day window, matching what PlusVibe's own UI reports. Counts only, no
    // rate: the estate averages ~1 send per mailbox per 3 days, so a
    // percentage over that window would be meaningless.
    recent: bq.recentActivity(d, { days: 3, client }),
    causes: bq.causeSummary(d, { days, client }),
    mailboxes: bq.byMailbox(d, { days, client }),
    tenant_by_day: tenantDays,
    tenant_by_client: bq.tenantByClient(d, { days: 7 }),
    burned_domains: bq.burnedDomains(d),
    unclassified: bq.unclassified(d),
    // The estate-wide alert: a tenant limit is shared, so this cannot be
    // judged per client.
    tenant_alert: !!(worst && worst.tenant_bounces >= bq.TENANT_ALERT),
    tenant_worst_day: worst || null,
  };
}));

/**
 * Placement tests — direct evidence of inbox vs spam, as opposed to the OOO
 * proxy everything else uses. Only generic-content tests are stored: a test
 * sent with live campaign copy measures the copy, not the mailbox.
 */
/** The next rotation round: one mailbox per domain, least recently tested. */
router.get('/round', wrap((d, req) =>
  require('./rotation').roundPlan(d, { client: req.query.client || null })));

/** What to do with each flagged mailbox: rest it or replace it. */
router.get('/recovery', wrap((d, req) =>
  require('./rotation').recoveryPlan(d, { client: req.query.client || null })));

/** How much of the estate has been tested, and how recently. */
router.get('/coverage', wrap((d) => require('./rotation').coverage(d)));

/** Mailboxes a pause would target. Read-only — shows what, never does it. */
router.get('/pause-targets', wrap((d, req) =>
  require('./actuator').pauseTargets(d, { client: req.query.client || null })));

/**
 * Pause flagged mailboxes in PlusVibe (daily_limit -> 0, warmup keeps running).
 *
 * The ONLY endpoint in this system that writes to PlusVibe. Defaults to a dry
 * run: a caller must pass {"apply": true} explicitly. A restore file is always
 * written first, so the change can be undone exactly.
 */
router.post('/pause', express.json(), async (req, res) => {
  try {
    const d = getDb();
    const act = require('./actuator');
    const targets = act.pauseTargets(d, { client: req.body?.client || null });
    if (!targets.length) return res.json({ ok: true, paused: 0, note: 'nothing flagged' });
    const out = await act.pause(d, targets, {
      apply: req.body?.apply === true,
      reason: req.body?.reason || 'placement spam',
      log: () => {},
    });
    res.json({ ok: true, ...out, rows: undefined, targets: targets.length });
  } catch (e) {
    console.error('[mailbox pause]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/placement', wrap((d, req) => {
  const pl = require('./placement');
  const rows = pl.placementByMailbox(d);
  const filtered = req.query.client ? rows.filter((r) => r.client === req.query.client) : rows;
  return {
    thresholds: { spam_pause_pct: pl.SPAM_PAUSE_PCT, min_seeds: pl.MIN_SEEDS },
    mailboxes: filtered,
    flagged: filtered.filter((r) => r.flagged_reason).length,
    by_recipient: pl.placementByRecipient(d),
    runs: pl.placementRuns(d),
  };
}));

/** Manual refresh. Re-reads PlusVibe into the store; does not touch PlusVibe settings. */
let refreshing = false;
router.post('/refresh', async (req, res) => {
  if (refreshing) return res.status(409).json({ error: 'refresh already running' });
  refreshing = true;
  try {
    const { run } = require('./ingest');
    const mode = req.query.mode === 'backfill' ? 'backfill' : 'nightly';
    const stats = await run({ mode, only: req.query.client || null, log: () => {} });
    if (db) { db.close(); db = null; }   // reopen so the refreshed data is read
    res.json({ ok: true, mode, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    refreshing = false;
  }
});

module.exports = router;
