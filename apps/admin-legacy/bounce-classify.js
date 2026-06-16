'use strict';

/**
 * bounce-classify.js — single source of truth for the 3-way bounce
 * classification used across the dashboard (gateway-analysis, the bounce
 * analyzer page, Stats, Mailboxes).
 *
 * There is NO stored hard/soft/block flag. `contacts.bounce_type` is always
 * 'soft' (useless). The real signal is the SMTP reason carried in the bounce
 * event's `raw->>'msg'` — we classify by parsing that.
 *
 * Three categories (NOT naive 5xx=hard / 4xx=soft, which is wrong):
 *   - hard  = dead address (invalid recipient, no such user, mailbox disabled)
 *             → suppress; real list-quality damage.
 *   - block = gateway rejecting the SENDER, not the address (spam/policy/
 *             reputation/blacklist, e.g. Mimecast 554 "security policies",
 *             Spamhaus DBL, 5.7.x auth) → infra/sender signal, NOT a bad
 *             address. A 5xx code here must NOT be counted as hard.
 *   - soft  = temporary (mailbox full, greylist, rate, server down) → retries
 *             handle it; not a problem.
 *
 * Classification order is block > hard > soft: a message matching both the
 * block and hard patterns is a block (the gateway is filtering us, the
 * "no such user" is incidental). This mirrors the precedence the
 * /api/gateway-analysis query has used and validated at 98.3% coverage
 * (block ~70%, hard ~24%, soft ~5%).
 *
 * Validated against the live email_events bounce corpus 2026-06-15. See the
 * project_bounce_classification memory for the research behind it.
 */

// Lowercased-msg regexes. Keep these as the ONLY definition — every consumer
// derives its SQL/JS from here so a tuning change updates everywhere at once.
const BLOCK_RE = 'spam|blacklist|black list|spamhaus|dbl|surbl|reputation|polic|open relay|rate|unsolicited|rejected by organization|denylist|rbl|access denied|not allowed to send|barracuda|blocked|block list|5\\.7\\.|not authorized|sender denied|sendernotauth|denied|mail loop|hop count';
const HARD_RE  = '5\\.[01]\\.[0-9]|55[04]|no such user|user unknown|does not exist|recipientnotfound|recipient not found|mailbox unavailable|address rejected|unknown recipient|invalid recipient|mailbox disabled|no mailbox|account.*disabled|unable to verify user|account or domain|no longer|not found';
const SOFT_RE  = '4\\.[0-9]\\.[0-9]|45[0-9]|temporar|try again|greylist|grey list|deferred|quota|mailbox full|out of storage|over quota|too many|server.*busy|timeout|throttl|retry';

// Postgres CASE expression that maps an email_events bounce row to one of
// 'hard' | 'block' | 'soft' | 'unclassified'. `msgExpr` is the SQL expression
// yielding the raw SMTP message (default: this table's raw->>'msg'). The order
// (block first) enforces the precedence above. Returns a bare CASE — callers
// wrap it with an alias, a FILTER, or bool_or as needed.
//
// Mirrors the inline logic that /api/gateway-analysis was validated with:
//   - block: matches BLOCK_RE
//   - hard:  matches HARD_RE and NOT BLOCK_RE
//   - soft:  matches SOFT_RE and NOT BLOCK_RE
function bounceClassCase(msgExpr = "raw->>'msg'") {
  const m = `lower(${msgExpr})`;
  return `CASE
    WHEN ${m} ~ '${BLOCK_RE}' THEN 'block'
    WHEN ${m} ~ '${HARD_RE}'  THEN 'hard'
    WHEN ${m} ~ '${SOFT_RE}'  THEN 'soft'
    ELSE 'unclassified'
  END`;
}

// Boolean SQL expressions for each class, matching the precedence the
// gateway-analysis query uses (block wins, then hard, then soft). Useful when a
// query wants three separate bool_or/FILTER aggregates rather than one label.
function bounceClassExprs(msgExpr = "raw->>'msg'") {
  const m = `lower(${msgExpr})`;
  return {
    isHard:  `(${m} ~ '${HARD_RE}' AND NOT ${m} ~ '${BLOCK_RE}')`,
    isBlock: `(${m} ~ '${BLOCK_RE}')`,
    isSoft:  `(${m} ~ '${SOFT_RE}' AND NOT ${m} ~ '${BLOCK_RE}' AND NOT ${m} ~ '${HARD_RE}')`,
  };
}

// JS classifier for a single message string (parity with the SQL CASE). Used
// off the DB path — e.g. classifying Bison-pulled messages or unit checks.
function classifyBounce(msg) {
  const m = String(msg || '').toLowerCase();
  if (new RegExp(BLOCK_RE).test(m)) return 'block';
  if (new RegExp(HARD_RE).test(m))  return 'hard';
  if (new RegExp(SOFT_RE).test(m))  return 'soft';
  return 'unclassified';
}

module.exports = {
  BLOCK_RE,
  HARD_RE,
  SOFT_RE,
  bounceClassCase,
  bounceClassExprs,
  classifyBounce,
};
