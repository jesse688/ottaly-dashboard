/**
 * PlusVibe client for the mailbox system.
 *
 * Every quirk below was verified live on 2026-09-17 and cost time to find, so
 * each is encoded here rather than left for the next caller to rediscover:
 *
 *   - Workspaces are at /workspaces. /workspace/list is a 404.
 *   - /account/list pages with `skip`. Passing `page` is a hard 400:
 *     "page is not allowed".
 *   - Bulk stats is a GET, not a POST, and takes ids as `email_acc_ids`,
 *     comma-joined.
 *   - Bulk stats rejects any range over 90 days with a 400. There is no
 *     lifetime total anywhere in the API, which is why cumulative sends have
 *     to be stitched from windows and stored.
 *   - Rates must divide by total_contacted_count, never by sends: sends
 *     include follow-ups, so dividing by them understates every rate.
 *
 * All requests go through one gate. Two limiters 429 each other — see the
 * ottaly_pv_single_limiter note.
 */

const axios = require('axios');

const BASE = 'https://api.plusvibe.ai/api/v1';
const MAX_WINDOW_DAYS = 90;
const CHUNK = 100;          // ids per bulk stats call
const GAP_MS = 350;         // spacing between calls, one gate

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (d) => d.toISOString().slice(0, 10);

class PV {
  constructor(apiKey, { gapMs = GAP_MS, onCall } = {}) {
    if (!apiKey) throw new Error('PLUSVIBE_API_KEY missing');
    this.key = apiKey;
    this.gapMs = gapMs;
    this.calls = 0;
    this.errors = 0;
    this.onCall = onCall;
    this._chain = Promise.resolve();
  }

  /** Serialise every request through one chain, spaced by gapMs. */
  _gate(fn) {
    const run = this._chain.then(async () => {
      const out = await fn();
      await sleep(this.gapMs);
      return out;
    });
    // Keep the chain alive even when a call rejects.
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  async _get(path, params, { retries = 3 } = {}) {
    return this._gate(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          this.calls++;
          if (this.onCall) this.onCall(path, params);
          const r = await axios.get(BASE + path, {
            params, headers: { 'x-api-key': this.key }, timeout: 90000,
          });
          return r.data;
        } catch (e) {
          const code = e.response?.status;
          // 429 and 5xx are worth retrying; a 400 is a bad request and never will be.
          const retryable = code === 429 || (code >= 500 && code < 600) || !code;
          if (!retryable || attempt >= retries) {
            this.errors++;
            const detail = e.response?.data?.errors || e.response?.data?.message || e.message;
            const err = new Error(`PV ${code || 'ERR'} ${path}: ${JSON.stringify(detail)}`);
            err.status = code;
            throw err;
          }
          await sleep(1000 * Math.pow(2, attempt));
        }
      }
    });
  }

  async workspaces() {
    const d = await this._get('/workspaces', {});
    return d?.workspaces || d?.data || (Array.isArray(d) ? d : []);
  }

  /** All accounts in a workspace. Pages with `skip` — `page` is rejected. */
  async accounts(workspaceId) {
    const out = [];
    for (let skip = 0; skip < 5000; skip += CHUNK) {
      const d = await this._get('/account/list', {
        workspace_id: workspaceId, limit: CHUNK, skip,
      });
      const batch = d?.accounts || [];
      out.push(...batch);
      if (batch.length < CHUNK) break;
    }
    return out;
  }

  /**
   * Per-day stats for up to 100 mailboxes over one window of <= 90 days.
   * Returns [{email_acc_id, email, header, chart}], chart one entry per day.
   */
  async bulkStats(workspaceId, ids, start, end) {
    const days = Math.round((end - start) / 86400000) + 1;
    if (days > MAX_WINDOW_DAYS) {
      throw new Error(`window ${days}d exceeds PlusVibe's ${MAX_WINDOW_DAYS}d limit`);
    }
    const d = await this._get('/account/email-stats/bulk', {
      workspace_id: workspaceId,
      start_date: fmt(start),
      end_date: fmt(end),
      email_acc_ids: ids.join(','),
      limit: CHUNK,
    });
    return d?.accounts || [];
  }
}

/**
 * Split [from, to] into consecutive <=90 day windows, newest first.
 * Newest first matters: a run that dies partway has still banked the recent
 * history, which is what the dashboard reads.
 */
function windows(from, to, maxDays = MAX_WINDOW_DAYS) {
  const out = [];
  let end = new Date(to);
  const floor = new Date(from);
  while (end >= floor) {
    let start = new Date(end.getTime() - (maxDays - 1) * 86400000);
    if (start < floor) start = new Date(floor);
    out.push({ start, end });
    end = new Date(start.getTime() - 86400000);
  }
  return out;
}

/**
 * Normalise one chart entry to a daily row.
 *
 * Verified 2026-09-17: every chart field sums exactly to its header counterpart
 * (sent, ooo, replies, new_lead_contacted, completed all reconcile). The chart
 * is therefore a trustworthy daily breakdown.
 *
 * The one exception is `total_contacted_count`, which exists ONLY on the
 * header and is slightly higher than new_lead_contacted (e.g. 395 vs 394,
 * 494 vs 489) — it counts leads contacted in the window including some not
 * newly created there, so it cannot be derived from any daily field. Since
 * every rate must divide by contacted, `contacted` here is the best daily
 * proxy (new leads contacted that day) and the exact per-window header value
 * is banked separately by the ingest as window_contacted.
 */
function chartRow(email, point) {
  const date = point.date || point.day || point._id || point.timestamp;
  return {
    email,
    date: typeof date === 'string' ? date.slice(0, 10) : fmt(new Date(date)),
    sent: point.total_sent_count ?? 0,
    ooo: point.total_ooo_reply_count ?? 0,
    replies: point.total_reply_count ?? 0,
    positive: point.total_pos_reply_count ?? 0,
    contacted: point.total_new_lead_contacted_count ?? 0,
    bounce: point.total_bounce_count ?? 0,
  };
}

module.exports = { PV, windows, fmt, chartRow, MAX_WINDOW_DAYS, CHUNK };
