const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
let SocksClient = null;
try { SocksClient = require('socks').SocksClient; } catch { /* proxy disabled if package missing */ }

const PORT = process.env.PORT || 5050;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SMTP_SENDER = process.env.SMTP_SENDER || '';
const SMTP_TIMEOUT_MS = Math.max(2000, parseInt(process.env.SMTP_TIMEOUT_MS || '10000', 10));
const CHECK_DELAY_MS = Math.max(0, parseInt(process.env.CHECK_DELAY_MS || '0', 10));
const MAX_CANDIDATES = Math.min(250, Math.max(1, parseInt(process.env.MAX_CANDIDATES || '80', 10)));
const MAX_CONTACTS = Math.min(20000, Math.max(1, parseInt(process.env.MAX_CONTACTS || '20000', 10)));
const VERIFY_CANDIDATES = Math.min(MAX_CANDIDATES, Math.max(1, parseInt(process.env.VERIFY_CANDIDATES || '12', 10)));
const DEFAULT_VERIFIER = process.env.DEFAULT_VERIFIER || 'reacher';
const ROW_CONCURRENCY = Math.min(50, Math.max(1, parseInt(process.env.ROW_CONCURRENCY || (DEFAULT_VERIFIER === 'reacher' ? '5' : '3'), 10)));
const CANDIDATE_CONCURRENCY = Math.min(12, Math.max(1, parseInt(process.env.CANDIDATE_CONCURRENCY || (DEFAULT_VERIFIER === 'reacher' ? '1' : '2'), 10)));
const SMTP_RETRIES = Math.min(3, Math.max(0, parseInt(process.env.SMTP_RETRIES || '1', 10)));
const SMTP_STARTTLS = process.env.SMTP_STARTTLS !== 'false';
const SOCKS5_HOST = process.env.SOCKS5_HOST || '';
const SOCKS5_PORT = Math.max(1, parseInt(process.env.SOCKS5_PORT || '1081', 10));
const SOCKS5_USER = process.env.SOCKS5_USER || '';
const SOCKS5_PASS = process.env.SOCKS5_PASS || '';
const CHECK_CATCH_ALL = process.env.CHECK_CATCH_ALL === 'true';
// Minimum ms the candidate must be faster than the garbage baseline to be called valid.
// Set to 0 to disable timing analysis and fall back to plain catch-all labelling.
const CATCH_ALL_TIMING_MS = Math.max(0, parseInt(process.env.CATCH_ALL_TIMING_MS || '150', 10));
// URL of main Ottaly server proxy rotation endpoint (e.g. http://localhost:3000/api/ev2/active-proxy)
// When set, each Reacher call fetches a fresh proxy from the pool instead of using SOCKS5
const EV2_PROXY_URL = process.env.EV2_PROXY_URL || '';
const REACHER_URL = (process.env.REACHER_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
// Auto-discovery: if REACHER_URL is unreachable, we try these in order.
// Covers every EasyPanel / Docker Compose naming pattern we've ever seen.
const REACHER_FALLBACK_BASES = [
  'http://github_reacher',        // EasyPanel internal — port 80 (confirmed working pattern)
  'http://github_reacher:80',
  'http://reacher:8080',
  'http://github_reacher:8080',
  'http://github-reacher:8080',
  'http://ottaly_reacher:8080',
  'http://ottaly-reacher:8080',
  'http://n8n1_reacher:8080',
  'http://127.0.0.1:8080',
  'http://localhost:8080',
];
let _reacherBase = null; // resolved at first use
const REACHER_API_KEY = process.env.REACHER_API_KEY || '';

// ── Secondary verifier: Reacher's hosted SaaS ─────────────────────────────
// The self-hosted instance goes through proxy4smtp, which hard-rejects past 5
// simultaneous SMTP sessions — that cap is the ceiling on how fast a CM's push
// finishes. The hosted API runs on Reacher's own infrastructure and IPs, so it
// does NOT consume a proxy4smtp slot. Overflow sent here is genuinely extra
// capacity rather than the same queue under another name.
//
// Used only as overflow: the primary is preferred (it is already paid for, and
// its behaviour is what our thresholds were tuned against). Requests fall to the
// SaaS when every local slot is busy AND the daily allowance has room.
const REACHER_URL_2 = (process.env.REACHER_URL_2 || '').replace(/\/$/, '');
const REACHER_API_KEY_2 = process.env.REACHER_API_KEY_2 || '';
const REACHER_URL_2_DAILY_LIMIT = Math.max(0, parseInt(process.env.REACHER_URL_2_DAILY_LIMIT || '10000', 10));
const SECONDARY_ENABLED = !!(REACHER_URL_2 && REACHER_API_KEY_2 && REACHER_URL_2_DAILY_LIMIT > 0);

// Our own sending domains — never run Reacher checks on these.
// They are internal mailboxes, not lead emails, so verifying them
// wastes Reacher slots and triggers unnecessary SMTP probes.
const OWN_SENDING_DOMAINS = new Set([
  'redwoodcompliancegroup.com','redwoodcomplianceservices.com',
  'redwoodcomplianceadvisors.com','sokinfinancial.org',
  'redwoodcomplianceadvisor.com','redwoodcomplianceconsultant.com','juriscales.com',
  'getsolarsupportdept.com','realsolarsupportdept.net','findsolarsupportdept.net',
  'azurianstudio.biz','gohoponstage.biz','nelsonrecords.com',
  'saleslytalents.org','saleslytalents.biz','springavenue.org',
  'juriscales.net','juriscales.org','consultantscenter.org',
  'consultantssystems.com','consultantstech.org',
  'springdrivepro.com','springdrives.net',
  'getmktresearch.com','goprovenresearch.com',
  'mktstudy.com','radcliffestudy.com',
  'getprovenreports.com','getsumterreports.com',
  'mktanalyze.com','thereportspro.com',
  'radcliffeinquiry.com','radclifferesearchcenter.com',
  'thehydrationworkplace.co.uk','the-hydration-water.co.uk',
  'marketresearchtech.org',
  'ottaly.co.uk','ottaly.com',
]);

// Proxy4smtp allows max 5 simultaneous SMTP connections. Sending more causes
// "Concurrency limit reached" errors from every connection above 5. This
// semaphore ensures we never have more than PRIMARY_REACHER_CONCURRENCY
// active Reacher requests at once, keeping us inside the proxy's hard cap.
const PRIMARY_REACHER_CONCURRENCY = Math.max(1, parseInt(process.env.PRIMARY_REACHER_CONCURRENCY || '5', 10));
// How long a caller may wait for a slot before giving up. Without this the wait
// is unbounded: on 2026-08-28 every worker parked here forever behind hung calls,
// the job sat at 0 rows with status 'running', and cancel could not reach them
// because the wait sits BETWEEN throwIfCancelled checkpoints. A bounded wait turns
// "hangs silently until someone kills the process" into a real, reported error.
const PRIMARY_WAIT_TIMEOUT_MS = Math.max(1000, parseInt(process.env.PRIMARY_WAIT_TIMEOUT_MS || '45000', 10));
let _primaryActive = 0;
const _primaryQueue = [];   // [{ resolve, reject, job, timer }]

// Waiters are woken in FIFO order. Each carries its own timer and the job it
// belongs to, so a queued waiter can be timed out or cancelled while it waits —
// neither was possible before.
function _acquirePrimary(job = null) {
  return new Promise((resolve, reject) => {
    if (_primaryActive < PRIMARY_REACHER_CONCURRENCY) { _primaryActive++; resolve(); return; }
    const waiter = { resolve, reject, job, timer: null };
    waiter.timer = setTimeout(() => {
      const i = _primaryQueue.indexOf(waiter);
      if (i !== -1) _primaryQueue.splice(i, 1);
      reject(new Error(`Timed out after ${PRIMARY_WAIT_TIMEOUT_MS}ms waiting for a Reacher slot `
        + `(${_primaryActive}/${PRIMARY_REACHER_CONCURRENCY} in use, ${_primaryQueue.length} queued)`));
    }, PRIMARY_WAIT_TIMEOUT_MS);
    _primaryQueue.push(waiter);
  });
}

function _releasePrimary() {
  // Skip waiters whose job was cancelled while they queued, so a cancelled job
  // cannot consume a slot it will only throw away.
  while (_primaryQueue.length) {
    const waiter = _primaryQueue.shift();
    clearTimeout(waiter.timer);
    if (waiter.job?.cancelRequested) { waiter.reject(new JobCancelledError()); continue; }
    waiter.resolve();   // ownership transfers; _primaryActive stays as-is
    return;
  }
  _primaryActive--;
}

// Evict every queued waiter belonging to a cancelled job. Called by cancel so
// workers parked in the queue fail fast instead of waiting out their timeout.
function _dropQueuedWaitersForJob(job) {
  if (!job) return 0;
  let dropped = 0;
  for (let i = _primaryQueue.length - 1; i >= 0; i--) {
    if (_primaryQueue[i].job === job) {
      const [w] = _primaryQueue.splice(i, 1);
      clearTimeout(w.timer);
      w.reject(new JobCancelledError());
      dropped++;
    }
  }
  return dropped;
}

// Live gauge for diagnostics. The old health check inferred trouble from a daily
// cumulative failure ratio; these are the numbers that actually described the
// 2026-08-28 outage and were invisible at the time.
function reacherSlotStats() {
  return { active: _primaryActive, queued: _primaryQueue.length, cap: PRIMARY_REACHER_CONCURRENCY };
}

// Per-minute rate limiter. Even at concurrency=5, fast checks can exceed
// Reacher/proxy4smtp's per-minute threshold. This sliding-window bucket
// holds new requests until there's room, and a 429 response blocks all
// dispatches for 62s so the upstream window fully resets.
const REACHER_PER_MIN = Math.max(1, parseInt(process.env.REACHER_PER_MIN || '50', 10));
const _reacherCallTimes = []; // timestamps of calls dispatched in last 60s
let _reacherBlockedUntil = 0; // ms; set when a 429 is received

async function _acquireReacherSlot(job = null) {
  // Bounded, cancellable wait. Previously this was `while (true)` with no cancel
  // check and no ceiling, so a 429 storm or a saturated window parked callers
  // indefinitely with no way out.
  const deadline = Date.now() + PRIMARY_WAIT_TIMEOUT_MS;
  while (true) {
    throwIfCancelled(job);
    const now = Date.now();
    if (now > deadline) {
      throw new Error(`Timed out after ${PRIMARY_WAIT_TIMEOUT_MS}ms waiting on the Reacher rate limiter `
        + `(${_reacherCallTimes.length}/${REACHER_PER_MIN} this minute`
        + `${_reacherBlockedUntil > now ? ', 429 backoff active' : ''})`);
    }
    if (_reacherBlockedUntil > now) {
      // Wake at most once a second so cancellation is noticed promptly rather
      // than after a full 62s backoff.
      await delay(Math.min(1000, _reacherBlockedUntil - now));
      continue;
    }
    while (_reacherCallTimes.length && now - _reacherCallTimes[0] >= 60000) _reacherCallTimes.shift();
    if (_reacherCallTimes.length < REACHER_PER_MIN) break;
    const waitMs = 60000 - (Date.now() - _reacherCallTimes[0]) + 50;
    await delay(Math.min(1000, Math.max(waitMs, 100)));
  }
  // Acquire the slot BEFORE stamping the rate-limit window. Stamping first meant
  // a call that queued for minutes was counted in the minute it entered the queue
  // rather than the minute it actually hit Reacher, skewing the limiter under load.
  await _acquirePrimary(job);
  _reacherCallTimes.push(Date.now());
}

function _reacher429Backoff() {
  const until = Date.now() + 62000;
  if (until > _reacherBlockedUntil) {
    _reacherBlockedUntil = until;
    _reacherCallTimes.length = 0;
    console.warn('[Reacher] 429 — blocking all requests for 62s to let rate limit reset');
  }
}

const _reacherVersionRe = /\/v([01])\/check_email$/;

// Single Reacher instance (self-hosted, proxy4smtp SOCKS5).
// Tracks daily usage + failures for the /api/reacher-pool diagnostic endpoint.
// usageDate/usageCount are persisted to disk so restarts don't reset the counter.
const REACHER_COUNTER_FILE = path.join(__dirname, 'reacher-counter.json');

function _loadReacherCounter() {
  try {
    const d = JSON.parse(fs.readFileSync(REACHER_COUNTER_FILE, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    return d.usageDate === today ? { usageDate: d.usageDate, usageCount: d.usageCount || 0 } : { usageDate: today, usageCount: 0 };
  } catch { return { usageDate: '', usageCount: 0 }; }
}

let _reacherCounterWriteTimer = null;
function _saveReacherCounter() {
  clearTimeout(_reacherCounterWriteTimer);
  _reacherCounterWriteTimer = setTimeout(() => {
    try { fs.writeFileSync(REACHER_COUNTER_FILE, JSON.stringify({ usageDate: _reacherMember.usageDate, usageCount: _reacherMember.usageCount })); } catch { /* ignore */ }
  }, 500);
}

const _reacherMember = (() => {
  const cleanUrl = (REACHER_URL || '').replace(/\/$/, '');
  const saved = _loadReacherCounter();
  return {
    label: 'primary',
    url: cleanUrl,
    key: REACHER_API_KEY || '',
    // Reacher (reacherhq/backend v0.11.6) only serves /v0/check_email; a /v1
    // path 404s instantly then a v0 call lands. Force v0 so the first call hits.
    version: 'v0',
    base: null,
    usageDate: saved.usageDate,
    usageCount: saved.usageCount,
    failureCount: 0,
    consecutiveFailures: 0,
    lastError: '',
    lastErrorAt: 0,
    // Rolling window of recent outcomes (1 = unknown), newest last.
    // consecutiveFailures only counts HARD failures — HTTP errors, network
    // drops. On 2026-08-19 Reacher answered every call successfully with
    // status 'unknown' for three hours: valid responses, zero hard failures,
    // nothing tripped, and 58% of a morning's verifications were wasted.
    // A timeout looks like a normal result, so the only way to see it is the
    // RATE of unknowns.
    recent: [],
  };
})();

// Secondary member (hosted SaaS). Its daily count persists next to the primary's
// so a restart cannot silently reset the allowance and overrun the plan.
const SECONDARY_COUNTER_FILE = path.join(__dirname, 'reacher-counter-2.json');
function _loadSecondaryCounter() {
  try {
    const d = JSON.parse(fs.readFileSync(SECONDARY_COUNTER_FILE, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    return d.usageDate === today ? { usageDate: d.usageDate, usageCount: d.usageCount || 0 } : { usageDate: today, usageCount: 0 };
  } catch { return { usageDate: '', usageCount: 0 }; }
}
let _secondaryCounterWriteTimer = null;
function _saveSecondaryCounter() {
  clearTimeout(_secondaryCounterWriteTimer);
  _secondaryCounterWriteTimer = setTimeout(() => {
    try { fs.writeFileSync(SECONDARY_COUNTER_FILE, JSON.stringify({ usageDate: _secondaryMember.usageDate, usageCount: _secondaryMember.usageCount })); } catch { /* ignore */ }
  }, 500);
}

const _secondaryMember = (() => {
  const saved = _loadSecondaryCounter();
  return {
    label: 'secondary',
    url: REACHER_URL_2,
    key: REACHER_API_KEY_2,
    dailyLimit: REACHER_URL_2_DAILY_LIMIT,
    usageDate: saved.usageDate,
    usageCount: saved.usageCount,
    failureCount: 0,
    consecutiveFailures: 0,
    lastError: '',
    lastErrorAt: 0,
    // Set when the SaaS returns 402/429 or repeatedly errors, so we stop trying
    // for a while rather than burning latency on every overflow request.
    cooldownUntil: 0,
  };
})();

// Is the secondary usable right now? Checks the kill switch, the daily
// allowance (reset at UTC midnight to match the primary) and any cooldown.
function _secondaryAvailable() {
  if (!SECONDARY_ENABLED) return false;
  const m = _secondaryMember;
  if (m.cooldownUntil > Date.now()) return false;
  const today = _reacherTodayUtc();
  if (m.usageDate !== today) { m.usageDate = today; m.usageCount = 0; }
  return m.usageCount < m.dailyLimit;
}

function _secondaryCooldown(reason, ms = 10 * 60 * 1000) {
  const m = _secondaryMember;
  m.cooldownUntil = Date.now() + ms;
  m.lastError = String(reason || '').slice(0, 240);
  m.lastErrorAt = Date.now();
  console.warn(`[Reacher2] cooling off ${Math.round(ms / 60000)}m — ${m.lastError}`);
}

function secondaryStats() {
  const m = _secondaryMember;
  const today = _reacherTodayUtc();
  return {
    enabled: SECONDARY_ENABLED,
    usageToday: m.usageDate === today ? m.usageCount : 0,
    dailyLimit: m.dailyLimit,
    failureCount: m.failureCount,
    lastError: m.lastError,
    cooldownMsLeft: Math.max(0, m.cooldownUntil - Date.now()),
    available: _secondaryAvailable(),
  };
}

// Matt at proxy4smtp puts the normal unknown rate at 5-10% depending on data
// quality; healthy hours here measured 10-12%. A sustained 40%+ over a
// meaningful sample means the verifier is broken, not that the list is bad.
const REACHER_HEALTH_WINDOW = Number(process.env.REACHER_HEALTH_WINDOW) || 50;
const REACHER_UNKNOWN_ALERT = Number(process.env.REACHER_UNKNOWN_ALERT) || 0.40;
let _reacherUnhealthySince = 0;

function _recordReacherOutcome(status) {
  const m = _reacherMember;
  m.recent.push(status === 'unknown' ? 1 : 0);
  if (m.recent.length > REACHER_HEALTH_WINDOW) m.recent.shift();
  if (m.recent.length < REACHER_HEALTH_WINDOW) return;

  const rate = m.recent.reduce((a, b) => a + b, 0) / m.recent.length;
  if (rate >= REACHER_UNKNOWN_ALERT) {
    if (!_reacherUnhealthySince) {
      _reacherUnhealthySince = Date.now();
      console.error(`[Reacher] UNHEALTHY — ${Math.round(rate * 100)}% unknown over the last `
        + `${m.recent.length} checks (normal is 5-10%). Verification is returning nothing usable. `
        + `Check the Reacher container and the proxy4smtp SOCKS5 exit.`);
    } else if (Date.now() - _reacherUnhealthySince > 300000) {
      // Re-warn every 5 minutes while it stays bad, so it cannot be lost in a
      // busy log the way three hours of silent failure was today.
      _reacherUnhealthySince = Date.now();
      console.error(`[Reacher] STILL UNHEALTHY — ${Math.round(rate * 100)}% unknown. `
        + `Restarting the Reacher container has cleared this before.`);
    }
  } else if (_reacherUnhealthySince) {
    console.log(`[Reacher] Health recovered — unknown rate back to ${Math.round(rate * 100)}%`);
    _reacherUnhealthySince = 0;
  }
}

// Returns the current "Reacher day" key — resets at UTC midnight to match Reacher's own daily limit counter.
function _reacherTodayUtc() { return new Date().toISOString().slice(0, 10); }
const REACHER_FROM_EMAIL = process.env.REACHER_FROM_EMAIL || SMTP_SENDER || '';
const REACHER_HELLO_NAME = process.env.REACHER_HELLO_NAME || '';
// Floor was 10s, which silently ignored any lower setting — REACHER_TIMEOUT_MS=8000
// was clamped back to 10000 with no warning. Measured duration data: median 2.85s,
// p95 7.17s, so 8s keeps 97.5% of checks while releasing the slot sooner on the
// genuinely dead ones. Floor of 3s still guards against a typo starving every check.
const REACHER_TIMEOUT_MS = Math.max(3000, parseInt(process.env.REACHER_TIMEOUT_MS || '12000', 10));
const REACHER_DIAGNOSTIC_TIMEOUT_MS = Math.max(3000, parseInt(process.env.REACHER_DIAGNOSTIC_TIMEOUT_MS || '10000', 10));
const REACHER_STOP_ON_TIMEOUT = process.env.REACHER_STOP_ON_TIMEOUT !== 'false';
const REACHER_RETRIES = Math.min(5, Math.max(0, parseInt(process.env.REACHER_RETRIES || '3', 10)));
const REACHER_RETRY_DELAY_MS = Math.max(0, parseInt(process.env.REACHER_RETRY_DELAY_MS || '450', 10));

const STATS_FILE = process.env.STATS_FILE || path.join(
  process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : __dirname,
  'email-verifier-stats.json'
);

function readStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { return { daily: {}, monthly: {} }; }
}

function incrementStats(safe, catchAll, invalid) {
  const total = safe + catchAll + invalid;
  if (total === 0) return;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  const s = readStats();
  for (const [key, bucket] of [[day, 'daily'], [month, 'monthly']]) {
    s[bucket][key] = s[bucket][key] || { total: 0, safe: 0, catchAll: 0, invalid: 0 };
    s[bucket][key].total += total;
    s[bucket][key].safe += safe;
    s[bucket][key].catchAll += catchAll;
    s[bucket][key].invalid += invalid;
  }
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(s)); } catch {}
}

function handleGetStats(req, res) {
  const s = readStats();
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  sendJson(res, 200, {
    today: s.daily[day] || { total: 0, safe: 0, catchAll: 0, invalid: 0 },
    month: s.monthly[month] || { total: 0, safe: 0, catchAll: 0, invalid: 0 },
    currentDay: day,
    currentMonth: month,
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const jobs = new Map();
const jobQueue = [];
let workerActive = false;
const mxCache = new Map();
const catchAllCache = new Map();

function timeStamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function addJobLog(job, message) {
  if (!job) return;
  job.logs.push(`[${timeStamp()}] ${message}`);
  if (job.logs.length > 180) job.logs = job.logs.slice(-180);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 20 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeDomain(input) {
  let domain = String(input || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0].split('#')[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : '';
}

function normalizeEmail(input) {
  const email = String(input || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function domainFromEmail(email) {
  return normalizeDomain(String(email || '').split('@')[1] || '');
}

function normalizeHeader(input) {
  return String(input || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;
  const source = String(text || '').replace(/^\uFEFF/, '');

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (char !== '\r') {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows.filter(r => r.some(cell => String(cell || '').trim() !== ''));
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function stringifyCsv(rows) {
  return rows.map(row => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

function rowToObject(headers, row) {
  const obj = {};
  headers.forEach((header, index) => {
    obj[header] = row[index] ?? '';
  });
  return obj;
}

function getField(row, headerLookup, names) {
  for (const name of names) {
    const header = headerLookup.get(normalizeHeader(name));
    if (header && row[header] !== undefined) return row[header];
  }
  return '';
}

function contactFromCsvRow(row, headerLookup) {
  return {
    firstName: getField(row, headerLookup, ['FirstName', 'First Name', 'first_name']),
    lastName: getField(row, headerLookup, ['LastName', 'Last Name', 'last_name']),
    domain: getField(row, headerLookup, ['OrganizationWebsiteUrl', 'Organization Website Url', 'Website', 'Company Website', 'Domain']),
  };
}

function cleanNamePart(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z]/g, '')
    .toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function prefixes(value) {
  const clean = cleanNamePart(value);
  if (!clean) return [];
  return unique([clean[0], clean.slice(0, 2), clean.slice(0, 3), clean.slice(0, 4)].filter(part => part.length < clean.length));
}

function buildEmailCandidates(firstName, lastName, domain) {
  const first = cleanNamePart(firstName);
  const last = cleanNamePart(lastName);
  if (!first || !last || !domain) return [];
  const fi = first[0];
  const li = last[0];
  const separators = ['', '.', '_', '-'];
  const locals = [];

  function add(local) {
    if (local) locals.push(local);
  }

  // Most common UK/US B2B patterns FIRST so early-stop fires on the likely match
  // before wasting checks on rare ones (order matters: each verify costs budget):
  //   first.last → first → flast → first.l → f.last → firstlast → last.first
  add(`${first}.${last}`);   // john.smith       (most common)
  add(first);                // john
  add(`${fi}${last}`);       // jsmith
  add(`${first}.${li}`);     // john.s
  add(`${fi}.${last}`);      // j.smith
  add(`${first}${last}`);    // johnsmith
  add(`${last}.${first}`);   // smith.john
  add(`${last}`);            // smith
  add(`${fi}${li}`);         // js
  add(`${li}${fi}`);         // sj

  // Remaining separator combinations (less common) fill out the rest.
  for (const sep of separators) {
    add(`${first}${sep}${last}`);
    add(`${last}${sep}${first}`);
    add(`${fi}${sep}${last}`);
    add(`${last}${sep}${fi}`);
    add(`${first}${sep}${li}`);
    add(`${li}${sep}${first}`);
    add(`${fi}${sep}${li}`);
    add(`${li}${sep}${fi}`);
  }

  for (const firstPrefix of prefixes(first)) {
    for (const sep of separators) {
      add(`${firstPrefix}${sep}${last}`);
      add(`${last}${sep}${firstPrefix}`);
    }
  }

  for (const lastPrefix of prefixes(last)) {
    for (const sep of separators) {
      add(`${first}${sep}${lastPrefix}`);
      add(`${lastPrefix}${sep}${first}`);
    }
  }

  return unique(locals.map(local => `${local}@${domain}`)).slice(0, MAX_CANDIDATES);
}

function normalizeVerifier(input, verifyFallback = false) {
  const value = String(input || '').toLowerCase();
  if (['reacher', 'smtp', 'permutation', 'verify_emails'].includes(value)) return value;
  return verifyFallback ? 'smtp' : 'permutation';
}

async function resolveMx(domain) {
  if (mxCache.has(domain)) {
    const cached = mxCache.get(domain);
    if (cached.error) throw new Error(cached.error);
    return cached.records;
  }
  const records = await dns.resolveMx(domain);
  const sorted = records.sort((a, b) => a.priority - b.priority);
  mxCache.set(domain, { records: sorted, error: '' });
  return sorted;
}

async function resolveMxCached(domain) {
  try {
    return await resolveMx(domain);
  } catch (err) {
    mxCache.set(domain, { records: [], error: err.message || 'No MX records found' });
    throw err;
  }
}

function smtpCommand(socket, command) {
  socket.write(`${command}\r\n`);
}

function classifySmtpCode(line) {
  const code = parseInt(String(line || '').slice(0, 3), 10);
  if (code >= 200 && code < 300) return 'accepted';
  if (code >= 500 && code < 600) return 'rejected';
  if (code >= 400 && code < 500) return 'temporary';
  return 'unknown';
}

// A 5xx at RCPT TO usually means "no such mailbox", but plenty of servers use
// the same code to refuse the *prober*: banned IP, RBL listing, SPF/DMARC
// policy, rate limiting. Those must not become a permanent 'invalid' verdict.
// 5.7.x is the RFC 3463 security/policy class, so it is the strongest signal;
// the word list catches servers that send a bare 550 with a prose reason.
const POLICY_REJECTION_RE = new RegExp([
  'banned', 'blocked', 'blacklist', 'blocklist', 'denylist', 'rbl\\b', 'dnsbl', 'spamhaus', 'barracuda',
  'access denied', 'not allowed', 'refused', 'rejected due to', 'policy', 'reputation', 'spam',
  'unsolicited', 'rate limit', 'too many', 'throttl', 'greylist', 'greylisted', 'try again',
  'authentication required', 'relay(?:ing)? denied', 'not permitted', 'client host',
].join('|'), 'i');

function isPolicyRejection(line) {
  const text = String(line || '');
  // Enhanced status code 5.7.x = policy/security rejection, not a bad mailbox.
  // 5.7.1 is the one exception that is genuinely ambiguous, but it is far more
  // often "you are blocked" than "no such user", so treat it as policy too.
  if (/\b5\.7\.\d+\b/.test(text)) return true;
  // 5.1.1 / 5.1.10 / 5.5.0 are the real "user unknown" codes — never policy.
  if (/\b5\.1\.[01]\b|\b5\.1\.10\b/.test(text)) return false;
  return POLICY_REJECTION_RE.test(text);
}

async function checkMailbox(email, mxHost, job = null) {
  return new Promise(async (resolve) => {
    let settled = false;
    let conversationLog = '';
    let lineBuffer = '';
    let state = 'banner'; // banner → ehlo → (starttls → ehlo2 |) → mailfrom → rcptto
    let ehloCapabilities = new Set();
    let currentSocket = null;
    let rcptToSentAt = 0;

    const senderDomain = (SMTP_SENDER || email).split('@')[1] || 'mail.example.com';
    const sender = SMTP_SENDER || `verify@${senderDomain}`;

    const hardTimer = setTimeout(() => {
      finish({ status: 'unknown', confidence: 'low', reason: `SMTP hard timeout after ${SMTP_TIMEOUT_MS}ms` });
    }, SMTP_TIMEOUT_MS + 500);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (currentSocket) {
        if (job?.activeSockets) job.activeSockets.delete(currentSocket);
        currentSocket.destroy();
      }
      resolve({ ...result, response: conversationLog.trim().slice(0, 240) });
    }

    function send(cmd) {
      if (!settled && currentSocket) {
        conversationLog += `> ${cmd}\n`;
        currentSocket.write(`${cmd}\r\n`);
      }
    }

    function processLine(line) {
      const code = parseInt(line.slice(0, 3), 10);
      const isFinal = line[3] !== '-';

      if (!isFinal) {
        // Continuation line — collect EHLO capabilities
        if (state === 'ehlo' || state === 'ehlo2') {
          const keyword = line.slice(4).trim().split(/\s+/)[0].toUpperCase();
          if (keyword) ehloCapabilities.add(keyword);
        }
        return;
      }

      // EHLO not understood — fall back to HELO (very old servers)
      if (code >= 500 && (state === 'ehlo' || state === 'ehlo2')) {
        state = 'helo_fallback'; // next 2xx → mailfrom
        send(`HELO ${senderDomain}`);
        return;
      }

      // A 5xx only means "this mailbox does not exist" when it is the reply to
      // RCPT TO. A 5xx at banner/MAIL FROM is the server rejecting *us* — a
      // banned sending IP, a policy block, a greylist that answers 5xx — and
      // says nothing about the recipient. Both used to land here as
      // invalid/confidence:high, which is never retried (shouldRetryReacherResult
      // only retries unknown/error) and is then cached on the contact for 14
      // days, so one blocklisted probe IP permanently buried good addresses.
      if (code >= 500) {
        if (state !== 'rcptto' || isPolicyRejection(line)) {
          finish({ status: 'unknown', confidence: 'low', reason: `Blocked, not a mailbox verdict: ${line}` });
          return;
        }
        finish({ status: 'invalid', confidence: 'high', reason: line });
        return;
      }
      if (code >= 400) { finish({ status: 'unknown', confidence: 'low', reason: line }); return; }
      if (code < 200) return;

      // 2xx — advance state machine
      switch (state) {
        case 'banner':
          state = 'ehlo';
          send(`EHLO ${senderDomain}`);
          break;

        case 'ehlo':
          if (SMTP_STARTTLS && ehloCapabilities.has('STARTTLS')) {
            state = 'starttls';
            send('STARTTLS');
          } else {
            state = 'mailfrom';
            send(`MAIL FROM:<${sender}>`);
          }
          break;

        case 'starttls': {
          // Upgrade the existing socket to TLS in-place
          const plain = currentSocket;
          detachListeners(plain);
          const tlsSock = tls.connect({ socket: plain, servername: mxHost, rejectUnauthorized: false });
          if (job?.activeSockets) { job.activeSockets.delete(plain); job.activeSockets.add(tlsSock); }
          currentSocket = tlsSock;
          tlsSock.setTimeout(SMTP_TIMEOUT_MS);
          attachListeners(tlsSock);
          tlsSock.once('secureConnect', () => {
            state = 'ehlo2';
            ehloCapabilities.clear();
            send(`EHLO ${senderDomain}`);
          });
          break;
        }

        case 'ehlo2':
        case 'helo_fallback':
          state = 'mailfrom';
          send(`MAIL FROM:<${sender}>`);
          break;

        case 'mailfrom':
          state = 'rcptto';
          rcptToSentAt = Date.now();
          send(`RCPT TO:<${email}>`);
          break;

        case 'rcptto':
          send('QUIT');
          finish({ status: 'valid', confidence: 'medium', reason: line, rcptToMs: rcptToSentAt ? Date.now() - rcptToSentAt : 0 });
          break;
      }
    }

    function onData(chunk) {
      const text = chunk.toString();
      conversationLog += text;
      lineBuffer += text;
      const lines = lineBuffer.split('\r\n');
      lineBuffer = lines.pop(); // keep any partial line for the next chunk
      for (const line of lines) {
        if (line && !settled) processLine(line);
      }
    }

    function onTimeout() { finish({ status: 'unknown', confidence: 'low', reason: 'SMTP timeout' }); }
    function onError(err) { finish({ status: 'unknown', confidence: 'low', reason: err.message }); }

    function attachListeners(sock) {
      sock.on('data', onData);
      sock.on('timeout', onTimeout);
      sock.on('error', onError);
    }

    function detachListeners(sock) {
      sock.removeListener('data', onData);
      sock.removeListener('timeout', onTimeout);
      sock.removeListener('error', onError);
    }

    // Connect — either directly or tunnelled through the SOCKS5 proxy
    try {
      if (SOCKS5_HOST && SocksClient) {
        const info = await SocksClient.createConnection({
          proxy: { host: SOCKS5_HOST, port: SOCKS5_PORT, type: 5, userId: SOCKS5_USER, password: SOCKS5_PASS },
          command: 'connect',
          destination: { host: mxHost, port: 25 },
          timeout: SMTP_TIMEOUT_MS,
        });
        currentSocket = info.socket;
      } else {
        currentSocket = net.createConnection(25, mxHost);
      }
    } catch (err) {
      finish({ status: 'unknown', confidence: 'low', reason: `${SOCKS5_HOST ? 'Proxy' : 'Connection'} error: ${err.message}` });
      return;
    }

    if (job?.activeSockets) job.activeSockets.add(currentSocket);
    currentSocket.setTimeout(SMTP_TIMEOUT_MS);
    attachListeners(currentSocket);
    // No 'close' handler — hard timer + socket timeout cover all hanging scenarios
    // without racing against the final 'data' event.
  });
}

async function checkMailboxWithRetry(email, mxHost, job = null, log = () => {}) {
  let lastResult = null;
  for (let attempt = 0; attempt <= SMTP_RETRIES; attempt += 1) {
    if (attempt > 0) {
      log(`Retry ${attempt}/${SMTP_RETRIES} for ${email}`);
      await delay(500 * attempt);
    }
    throwIfCancelled(job);
    lastResult = await checkMailbox(email, mxHost, job);
    throwIfCancelled(job);
    if (lastResult.status !== 'unknown') return lastResult;
    const reason = String(lastResult.reason || lastResult.response || '').toLowerCase();
    // 'blocked, not a mailbox verdict' is a 5xx aimed at the prober (banned IP,
    // RBL, rate limit). Worth another attempt — the retry may go out on a
    // different proxy exit IP, and greylisters answer on the second try.
    const retryable = reason.includes('timeout') || reason.includes('closed') || reason.includes('reset')
      || reason.includes('econn') || reason.includes('blocked, not a mailbox verdict');
    if (!retryable) return lastResult;
  }
  return lastResult || { status: 'unknown', confidence: 'low', reason: 'No SMTP response' };
}

// Tries each MX record in priority order, falling through to the next only on
// connection-level failures (timeout, ECONNREFUSED, etc.). If the primary MX
// responds at all — even with a rejection — we trust that verdict.
async function checkMailboxWithMxFallback(email, mxRecords, job = null, log = () => {}) {
  const hosts = mxRecords.slice(0, 3).map(r => r?.exchange).filter(Boolean);
  let lastResult = { status: 'unknown', confidence: 'low', reason: 'No MX hosts' };
  for (const mxHost of hosts) {
    throwIfCancelled(job);
    const result = await checkMailboxWithRetry(email, mxHost, job, log);
    lastResult = result;
    if (result.status === 'valid' || result.status === 'invalid') return result;
    const reason = String(result.reason || result.response || '').toLowerCase();
    const connFailure =
      reason.includes('timeout') || reason.includes('hard timeout') ||
      reason.includes('econnrefused') || reason.includes('enotfound') ||
      reason.includes('enetunreach') || reason.includes('ehostunreach');
    if (!connFailure) return result; // server responded — its verdict stands
    if (hosts.length > 1) log(`MX ${mxHost} unreachable for ${email}, trying next`);
  }
  return lastResult;
}

async function verifyContact(contact, log = () => {}, job = null) {
  throwIfCancelled(job);
  const domain = normalizeDomain(contact.domain);
  const candidates = buildEmailCandidates(contact.firstName, contact.lastName, domain).slice(0, VERIFY_CANDIDATES);
  if (!candidates.length) {
    return { ...contact, domain, error: 'First name, last name and valid domain are required', results: [] };
  }

  let mxRecords = [];
  try {
    log(`Resolving MX for ${domain}`);
    mxRecords = await resolveMxCached(domain);
  } catch {
    log(`No MX records found for ${domain}`);
    return {
      ...contact,
      domain,
      mxRecords: [],
      catchAll: false,
      results: candidates.map(email => ({
        email,
        status: 'unknown',
        confidence: 'low',
        reason: `No MX records found for ${domain}`,
      })),
    };
  }

  log(`Using MX ${mxRecords.slice(0, 3).map(r => r.exchange).join(', ')} for ${domain}`);
  if (CHECK_CATCH_ALL) {
    let catchAll = false;
    let catchAllBaselineMs = 0;
    if (catchAllCache.has(domain)) {
      const cached = await catchAllCache.get(domain);
      catchAll = cached.isCatchAll;
      catchAllBaselineMs = cached.baselineMs;
      log(`Catch-all cache for ${domain}: ${catchAll ? 'yes' : 'no'}${catchAllBaselineMs ? ` (${catchAllBaselineMs}ms baseline)` : ''}`);
    } else {
      const check = (async () => {
        const randomLocal = `local-check-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        log(`Checking catch-all behavior for ${domain}`);
        const probe = await checkMailboxWithMxFallback(`${randomLocal}@${domain}`, mxRecords, job);
        return { isCatchAll: probe.status === 'valid', baselineMs: probe.rcptToMs || 0 };
      })();
      catchAllCache.set(domain, check);
      const probeResult = await check;
      catchAll = probeResult.isCatchAll;
      catchAllBaselineMs = probeResult.baselineMs;
    }

    if (catchAll) {
      log(`${domain} is catch-all — baseline RCPT TO ${catchAllBaselineMs}ms`);

      if (CATCH_ALL_TIMING_MS > 0 && catchAllBaselineMs > 0) {
        log(`Timing analysis: candidate must respond ≥${CATCH_ALL_TIMING_MS}ms faster than ${catchAllBaselineMs}ms baseline`);
        const timingResults = [];
        for (let start = 0; start < candidates.length; start += CANDIDATE_CONCURRENCY) {
          if (start > 0 && CHECK_DELAY_MS) await delay(CHECK_DELAY_MS);
          throwIfCancelled(job);
          const batch = candidates.slice(start, start + CANDIDATE_CONCURRENCY);
          const batchResults = await Promise.all(batch.map(async email => {
            throwIfCancelled(job);
            const result = await checkMailboxWithMxFallback(email, mxRecords, job, log);
            const ms = result.rcptToMs || 0;
            const faster = ms > 0 && (catchAllBaselineMs - ms) >= CATCH_ALL_TIMING_MS;
            log(`${email} RCPT TO ${ms}ms vs ${catchAllBaselineMs}ms baseline → ${faster ? 'likely valid' : 'catch-all'}`);
            return {
              email,
              status: faster ? 'valid' : 'catch_all',
              confidence: 'low',
              reason: ms > 0
                ? `Catch-all domain: RCPT TO ${ms}ms vs ${catchAllBaselineMs}ms baseline${faster ? ' — timing suggests real mailbox' : ''}`
                : 'Catch-all domain: timing unavailable',
            };
          }));
          timingResults.push(...batchResults);
          if (timingResults.some(r => r.status === 'valid')) break;
        }
        return { ...contact, domain, mxRecords, catchAll: true, results: timingResults };
      }

      return {
        ...contact,
        domain,
        mxRecords,
        catchAll: true,
        results: candidates.map(email => ({
          email,
          status: 'catch_all',
          confidence: 'low',
          reason: 'The server accepted a random address for this domain.',
        })),
      };
    }
  }

  const results = [];
  for (let start = 0; start < candidates.length; start += CANDIDATE_CONCURRENCY) {
    if (start > 0 && CHECK_DELAY_MS) await delay(CHECK_DELAY_MS);
    throwIfCancelled(job);
    const batch = candidates.slice(start, start + CANDIDATE_CONCURRENCY);
    log(`Testing candidate batch ${start + 1}-${start + batch.length} of ${candidates.length}`);
    const batchResults = await Promise.all(batch.map(async email => {
      throwIfCancelled(job);
      log(`Testing ${email}`);
      const result = await checkMailboxWithMxFallback(email, mxRecords, job, log);
      throwIfCancelled(job);
      log(`${email} -> ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
      return {
        email,
        status: result.status,
        confidence: result.confidence,
        reason: result.reason || result.response || '',
      };
    }));
    results.push(...batchResults);
    if (results.some(result => result.status === 'valid')) break;
  }

  return { ...contact, domain, mxRecords, catchAll: false, results };
}

async function checkExactWithSmtp(email) {
  const domain = domainFromEmail(email);
  if (!domain) {
    return { email, status: 'unknown', confidence: 'low', reason: 'Invalid email domain' };
  }

  let mxRecords = [];
  try {
    mxRecords = await resolveMxCached(domain);
  } catch {
    return { email, status: 'unknown', confidence: 'low', reason: `No MX records found for ${domain}` };
  }

  if (!mxRecords[0]?.exchange) {
    return { email, status: 'unknown', confidence: 'low', reason: `No MX host found for ${domain}` };
  }

  const result = await checkMailboxWithMxFallback(email, mxRecords);
  return {
    email,
    status: result.status,
    confidence: result.confidence,
    reason: result.reason || result.response || '',
    mxHost: mxRecords[0].exchange,
  };
}

async function resolveReacherBaseFor(member) {
  if (member.base) return member.base;

  const configuredBase = member.url.replace(/\/v[01]\/check_email$/, '').replace(/\/$/, '');
  const candidates = [configuredBase, ...REACHER_FALLBACK_BASES].filter((v, i, a) => a.indexOf(v) === i);

  for (const base of candidates) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const resp = await fetch(`${base}/v0/check_email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_email: 'probe@probe.invalid' }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (resp) {
        member.base = base;
        console.log(`[Reacher] Found at ${base}`);
        return member.base;
      }
    } catch { /* not reachable at this candidate */ }
  }

  console.warn(`[Reacher] Auto-discovery failed; using configured URL: ${configuredBase}`);
  member.base = configuredBase;
  return member.base;
}

async function resolveReacherBase() {
  const resolved = await resolveReacherBaseFor(_reacherMember);
  _reacherBase = resolved;
  return resolved;
}

function reacherEndpoint() {
  // Sync helper used in diagnostics/logging — returns configured URL before first resolution.
  const base = _reacherBase || REACHER_URL.replace(/\/v[01]\/check_email$/, '').replace(/\/$/, '');
  if (/\/v[01]\/check_email$/.test(base)) return base;
  return `${base}/v0/check_email`;
}

function reacherBaseUrl() {
  return reacherEndpoint().replace(/\/v[01]\/check_email$/, '');
}

function isAbortError(err) {
  return err?.name === 'AbortError' || /aborted|abort/i.test(err?.message || '');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REACHER_TIMEOUT_MS, job = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Register with the job so cancel can abort this request mid-flight. Without
  // it a cancelled job kept every in-flight verification running to completion,
  // holding scarce proxy slots for work whose result is discarded.
  if (job?.activeAborters) job.activeAborters.add(controller);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (job?.activeAborters) job.activeAborters.delete(controller);
  }
}

function summarizeReacher(result) {
  const reachable = result?.is_reachable || 'unknown';
  const mx = result?.mx ? `mx=${result.mx.accepts_mail === true ? 'yes' : result.mx.accepts_mail === false ? 'no' : 'unknown'}` : '';
  const smtp = result?.smtp ? [
    result.smtp.can_connect_smtp === false ? 'smtp_connect=no' : '',
    result.smtp.is_deliverable === true ? 'deliverable=yes' : result.smtp.is_deliverable === false ? 'deliverable=no' : '',
    result.smtp.is_catch_all === true ? 'catch_all=yes' : '',
    result.smtp.is_disabled === true ? 'disabled=yes' : '',
    result.smtp.has_full_inbox === true ? 'full_inbox=yes' : '',
  ].filter(Boolean).join(' ') : '';
  // Include the upstream SMTP error text. Without it an 'unknown' verdict read
  // "unknown · mx=yes · smtp_connect=no" — the boolean shadow of an error whose
  // actual message ("Concurrency limit reached for this account") was sitting in
  // smtp.error.message and thrown away. That omission is why 2026-08-28 took
  // hours to diagnose instead of minutes.
  const errText = smtpErrorText(result);
  return [reachable, mx, smtp, errText ? `err=${errText.slice(0, 200)}` : ''].filter(Boolean).join(' · ');
}

function isCatchAllResult(result) {
  return result?.smtp?.is_catch_all === true || /\bcatch_all=yes\b/.test(String(result?.reason || ''));
}

function sendabilityForResult(result) {
  if (!result) return 'not_found';
  if (result.status === 'valid' && !isCatchAllResult(result)) return 'safe';
  if (result.status === 'valid' && isCatchAllResult(result)) return 'risky_catch_all';
  if (result.status === 'risky' || isCatchAllResult(result)) return 'risky_catch_all';
  if (result.status === 'candidate') return 'unverified_candidate';
  if (result.status === 'invalid') return 'do_not_send';
  if (result.status === 'unknown') return 'unknown';
  return result.status || 'not_found';
}

function catchAllFlag(result) {
  return isCatchAllResult(result) ? 'yes' : 'no';
}

// Pull the raw SMTP conversation text out of a Reacher response. Reacher
// serializes its SmtpError enum as { type, message }, and surfaces the server's
// own refusal string in smtp.error / smtp.description / debug.smtp_connection.
function smtpErrorText(result) {
  const smtp = result?.smtp || {};
  const parts = [
    typeof smtp.error === 'string' ? smtp.error : smtp.error?.message,
    smtp.description,
    smtp.error?.type,
    result?.debug?.smtp_connection?.error,
  ];
  return parts.filter(p => typeof p === 'string' && p).join(' ');
}

function mapReacherResult(email, result) {
  const reachable = result?.is_reachable || 'unknown';
  if (reachable === 'safe') {
    return { email, status: 'valid', confidence: 'high', reason: summarizeReacher(result), raw: result };
  }
  if (reachable === 'invalid') {
    // Reacher reports is_reachable=invalid for a refused RCPT TO, but it cannot
    // tell "no such mailbox" from "your sending IP is banned" — both are a 5xx.
    // Our proxy exit IPs have been RBL-listed before, and an 'invalid' here is
    // never retried and is cached on the contact for 14 days, so a blocked
    // probe permanently buries a good address. Demote those to unknown.
    // Reacher calls it Invalid when !is_deliverable OR !can_connect_smtp OR
    // is_disabled. Only the first is a statement about the mailbox — if we
    // could not even open the SMTP session, we learned nothing about it.
    const smtpError = smtpErrorText(result);
    const neverConnected = result?.smtp?.can_connect_smtp === false;
    if (neverConnected || (smtpError && isPolicyRejection(smtpError))) {
      const why = neverConnected && !smtpError ? 'could not connect to SMTP server' : smtpError.slice(0, 160);
      return {
        email, status: 'unknown', confidence: 'low',
        reason: `Blocked, not a mailbox verdict: ${why}`, raw: result,
      };
    }
    return { email, status: 'invalid', confidence: 'high', reason: summarizeReacher(result), raw: result };
  }
  if (reachable === 'risky') {
    return { email, status: 'risky', confidence: 'medium', reason: summarizeReacher(result), raw: result };
  }
  return { email, status: 'unknown', confidence: 'low', reason: summarizeReacher(result), raw: result };
}

function shouldRetryReacherResult(result) {
  if (/HTTP 429/.test(result?.reason || '')) return false; // quota/concurrency hit — don't burn more calls
  return ['unknown', 'error'].includes(String(result?.status || '').toLowerCase());
}

// Fetch next proxy from Ottaly proxy pool (round-robin, tracks usage)
// Returns proxy object or throws if EV2_PROXY_URL is set but pool is empty
async function fetchEv2Proxy() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  const r = await fetch(EV2_PROXY_URL, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
  const d = await r.json();
  return d.proxy || null;
}

async function callReacherOnce(email, job = null) {
  const m = _reacherMember;

  // Resolve the endpoint BEFORE taking a slot. Discovery does up to N sequential
  // 3s probes; doing it while holding one of only 5 SMTP slots wasted scarce
  // capacity on work that needs none.
  const base = await resolveReacherBaseFor(m);

  // Slot acquisition can now fail (timeout or cancellation) instead of hanging
  // forever. It sits outside the try because no slot is held when it throws —
  // releasing here would corrupt the count.
  try {
    await _acquireReacherSlot(job);
  } catch (err) {
    if (err instanceof JobCancelledError) throw err;
    const reason = `Reacher slot unavailable: ${err.message}`;
    _recordReacherFailure(reason);
    return [{ email, status: 'unknown', confidence: 'low', reason }, m];
  }
  try {
    const body = { to_email: email };
    if (REACHER_FROM_EMAIL) body.from_email = REACHER_FROM_EMAIL;
    if (REACHER_HELLO_NAME) body.hello_name = REACHER_HELLO_NAME;

    if (EV2_PROXY_URL) {
      let proxy = null;
      try { proxy = await fetchEv2Proxy(); } catch { /* pool fetch failed */ }
      if (!proxy) {
        return { email, status: 'unknown', confidence: 'low', reason: 'EV2: no Webshare proxies in pool — add proxies in Email Verify 2.0' };
      }
      body.proxy = { host: proxy.host, port: proxy.port, username: proxy.username || undefined, password: proxy.password || undefined };
      console.log(`[EV2] Using proxy ${proxy.host}:${proxy.port} for ${email}`);
    }

    const headers = { 'Content-Type': 'application/json' };
    if (m.key) headers.authorization = m.key.startsWith('Bearer ') ? m.key : `Bearer ${m.key}`;

    // The configured base may have its /vN suffix stripped by discovery, so we
    // rebuild the endpoint from m.version. If Reacher 404s that route (wrong
    // API version for this build — e.g. v1 SaaS route vs v0 self-hosted), flip
    // the version once and retry. This self-heals a misconfigured REACHER_URL
    // instead of burning every retry on a route that can never answer.
    const buildEndpoint = () => (/\/v[01]\/check_email$/.test(base) ? base : `${base}/${m.version}/check_email`);
    let versionFlipped = false;
    try {
      let response = await fetchWithTimeout(buildEndpoint(), { method: 'POST', headers, body: JSON.stringify(body) }, REACHER_TIMEOUT_MS, job);

      // 404 on a bare base (no suffix on the configured URL) means the version
      // we built is wrong for this Reacher build. Flip v0<->v1, pin it so later
      // emails skip the dead route, and retry this one before giving up.
      if (response.status === 404 && !/\/v[01]\/check_email$/.test(base)) {
        const flipped = m.version === 'v1' ? 'v0' : 'v1';
        console.warn(`[Reacher] 404 on ${m.version}/check_email — flipping to ${flipped} and retrying`);
        m.version = flipped;
        versionFlipped = true;
        response = await fetchWithTimeout(buildEndpoint(), { method: 'POST', headers, body: JSON.stringify(body) }, REACHER_TIMEOUT_MS, job);
      }

      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch {
        const reason = `Reacher returned non-JSON: ${text.slice(0, 120)}`;
        _recordReacherFailure(reason);
        return [{ email, status: 'unknown', confidence: 'low', reason }, m];
      }
      if (!response.ok) {
        if (response.status === 429) _reacher429Backoff();
        const reason = `Reacher HTTP ${response.status}: ${JSON.stringify(data).slice(0, 160)}`;
        _recordReacherFailure(reason);
        return [{ email, status: 'unknown', confidence: 'low', reason }, m];
      }
      if (versionFlipped) console.log(`[Reacher] Pinned to ${m.version}/check_email after version flip`);
      const today = _reacherTodayUtc();
      if (m.usageDate !== today) { m.usageDate = today; m.usageCount = 0; }
      m.usageCount++;
      _saveReacherCounter();
      if (m.consecutiveFailures) {
        console.log(`[Reacher] Recovered after ${m.consecutiveFailures} consecutive fails`);
        m.consecutiveFailures = 0;
      }
      const mapped = mapReacherResult(email, data);
      // Track the outcome even on the success path: a timeout comes back as a
      // perfectly valid response with status 'unknown', which is exactly how
      // three hours of dead verification went unnoticed.
      _recordReacherOutcome(mapped && mapped.status);
      return [mapped, m];
    } catch (err) {
      const isNetworkErr = !isAbortError(err) && /fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(err.message || '');
      if (isNetworkErr) {
        console.warn(`[Reacher] Network error at ${buildEndpoint()}, will re-discover: ${err.message}`);
        m.base = null;
        _reacherBase = null;
      }
      const reason = isAbortError(err) ? `Reacher timed out after ${REACHER_TIMEOUT_MS}ms` : `Reacher error: ${err.message}`;
      _recordReacherFailure(reason);
      return [{ email, status: 'unknown', confidence: 'low', reason }, m];
    }
  } finally {
    _releasePrimary();
  }
}

// Call the hosted SaaS. Deliberately does NOT touch the primary semaphore: the
// whole point is that this path does not consume a proxy4smtp slot. Responses
// go through the same mapReacherResult, so a verdict from here is indistinguishable
// downstream from a local one.
async function callSecondaryOnce(email, job = null) {
  const m = _secondaryMember;
  throwIfCancelled(job);
  const t0 = Date.now();
  try {
    const headers = { 'Content-Type': 'application/json', Authorization: m.key };
    const response = await fetchWithTimeout(
      m.url, { method: 'POST', headers, body: JSON.stringify({ to_email: email }) },
      REACHER_TIMEOUT_MS, job
    );
    const text = await response.text();

    if (!response.ok) {
      // 402/429 mean the plan is exhausted or throttled — back off for a while
      // rather than retrying every overflow request and adding latency.
      if (response.status === 402 || response.status === 429) {
        _secondaryCooldown(`HTTP ${response.status} — quota/rate limited`, 30 * 60 * 1000);
      } else if (response.status === 401 || response.status === 403) {
        _secondaryCooldown(`HTTP ${response.status} — key rejected`, 60 * 60 * 1000);
      } else {
        m.failureCount++;
      }
      return null;   // null = caller falls back to the primary
    }

    let data;
    try { data = JSON.parse(text); } catch { m.failureCount++; return null; }

    const today = _reacherTodayUtc();
    if (m.usageDate !== today) { m.usageDate = today; m.usageCount = 0; }
    m.usageCount++;
    m.consecutiveFailures = 0;
    _saveSecondaryCounter();

    const mapped = mapReacherResult(email, data);
    console.log(`[Reacher2] ${email} -> ${mapped.status} in ${Date.now() - t0}ms (${m.usageCount}/${m.dailyLimit} today)`);
    return mapped;
  } catch (err) {
    if (err instanceof JobCancelledError) throw err;
    m.failureCount++;
    m.consecutiveFailures++;
    m.lastError = String(err.message || '').slice(0, 240);
    m.lastErrorAt = Date.now();
    // Repeated hard failures usually mean the endpoint is unreachable; stop
    // paying the timeout on every request.
    if (m.consecutiveFailures >= 3) _secondaryCooldown(`${m.consecutiveFailures} consecutive errors: ${m.lastError}`);
    return null;   // fall back to the primary
  }
}

function _recordReacherFailure(reason) {
  const m = _reacherMember;
  m.failureCount = (m.failureCount || 0) + 1;
  m.consecutiveFailures = (m.consecutiveFailures || 0) + 1;
  m.lastError = String(reason || '').slice(0, 240);
  m.lastErrorAt = Date.now();
  console.warn(`[Reacher] FAIL #${m.failureCount} (consecutive ${m.consecutiveFailures}): ${m.lastError}`);
}

// Send to the hosted SaaS only when the local path is genuinely saturated:
// every proxy4smtp slot busy AND requests already waiting. Below that the
// primary is faster and free, so overflow would just add latency and burn the
// daily allowance. This is what turns the SaaS into extra capacity during a CM's
// push rather than a second queue for the same work.
function _shouldUseSecondary() {
  if (!_secondaryAvailable()) return false;
  const s = reacherSlotStats();
  return s.active >= s.cap && s.queued > 0;
}

async function checkWithReacher(email, job = null) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (OWN_SENDING_DOMAINS.has(domain)) {
    return { email, status: 'safe', confidence: 'high', reason: 'own sending domain — skipped' };
  }

  // Overflow to the SaaS while the local slots are full. A null return means it
  // could not answer (quota, cooldown, error), in which case we simply queue for
  // the primary as before — the secondary can never make things worse.
  if (_shouldUseSecondary()) {
    const viaSaas = await callSecondaryOnce(email, job);
    if (viaSaas) return viaSaas;
  }

  let lastResult = null;
  for (let attempt = 0; attempt <= REACHER_RETRIES; attempt += 1) {
    throwIfCancelled(job);
    if (attempt > 0) await delay(REACHER_RETRY_DELAY_MS * Math.pow(2, attempt - 1));
    [lastResult] = await callReacherOnce(email, job);
    if (!shouldRetryReacherResult(lastResult)) return lastResult;
  }
  return lastResult || { email, status: 'unknown', confidence: 'low', reason: 'No Reacher response' };
}

async function verifyContactWithReacher(contact, log = () => {}, job = null) {
  const domain = normalizeDomain(contact.domain);
  const candidates = buildEmailCandidates(contact.firstName, contact.lastName, domain).slice(0, VERIFY_CANDIDATES);
  if (!candidates.length) {
    return { ...contact, domain, error: 'First name, last name and valid domain are required', results: [] };
  }

  log(`Using Reacher at ${reacherEndpoint()}`);
  const results = [];
  for (let start = 0; start < candidates.length; start += CANDIDATE_CONCURRENCY) {
    if (start > 0 && CHECK_DELAY_MS) await delay(CHECK_DELAY_MS);
    throwIfCancelled(job);
    const batch = candidates.slice(start, start + CANDIDATE_CONCURRENCY);
    log(`Reacher batch ${start + 1}-${start + batch.length} of ${candidates.length}`);
    const batchResults = await Promise.all(batch.map(async email => {
      log(`Reacher checking ${email}`);
      const result = await checkWithReacher(email, job);
      log(`${email} -> ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
      return result;
    }));
    results.push(...batchResults);
    if (results.some(result => result.status === 'valid')) break;
    // Catch-all domain: every further permutation will also come back catch-all/
    // risky and can NEVER be proven, so testing the rest is pure waste — and it's
    // what burns the daily verification budget on care-home lists. Stop as soon as
    // we know, keeping the first generated pattern as the best guess.
    if (batchResults.some(result => isCatchAllResult(result))) {
      log(`${domain} is catch-all — no permutation can be proven; stopping to save verifications`);
      break;
    }
    if (REACHER_STOP_ON_TIMEOUT && batchResults.some(result => /^Reacher timed out/.test(result.reason || ''))) {
      log('Reacher timed out; stopping this contact so the queue does not overload the verifier');
      break;
    }
  }
  return { ...contact, domain, results };
}

function generateContact(contact) {
  const domain = normalizeDomain(contact.domain);
  const candidates = buildEmailCandidates(contact.firstName, contact.lastName, domain);
  return {
    ...contact,
    domain,
    mxRecords: [],
    catchAll: false,
    results: candidates.map(email => ({
      email,
      status: 'candidate',
      confidence: 'unverified',
      reason: 'Generated from a common company email pattern.',
    })),
  };
}

async function generatePermutationCsvText(csvText, onProgress = () => {}, log = () => {}, job = null) {
  throwIfCancelled(job);
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one contact row');

  const headers = rows[0].map(header => String(header || '').trim());
  const headerLookup = new Map(headers.map(header => [normalizeHeader(header), header]));
  const sourceRows = rows.slice(1, MAX_CONTACTS + 1);
  const outputRows = [['Email']];
  let processedRows = 0;
  let generatedCount = 0;

  log(`CSV parsed: ${sourceRows.length} contact rows`);
  log(`Mode: permutations only`);
  log(`Creating up to ${MAX_CANDIDATES} permutations per contact`);

  for (let index = 0; index < sourceRows.length; index += 1) {
    throwIfCancelled(job);
    const row = rowToObject(headers, sourceRows[index]);
    const contact = contactFromCsvRow(row, headerLookup);
    const domain = normalizeDomain(contact.domain);
    const candidates = buildEmailCandidates(contact.firstName, contact.lastName, domain);
    for (const email of candidates) outputRows.push([email]);
    generatedCount += candidates.length;
    processedRows += 1;
    log(`Row ${index + 1}: generated ${candidates.length} permutations`);
    onProgress({
      processedRows,
      rowCount: sourceRows.length,
      foundCount: generatedCount,
      catchAllCount: 0,
      reviewCount: 0,
      preview: [],
    });
  }

  return {
    rowCount: sourceRows.length,
    foundCount: generatedCount,
    catchAllCount: 0,
    reviewCount: 0,
    preview: [],
    csvText: stringifyCsv(outputRows),
    safeCsvText: stringifyCsv(outputRows),
    catchAllCsvText: stringifyCsv([['Email']]),
    reviewCsvText: stringifyCsv([['Email']]),
  };
}

class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled');
    this.name = 'JobCancelledError';
  }
}

function throwIfCancelled(job) {
  if (job?.cancelRequested) throw new JobCancelledError();
}

function pickFoundEmail(contactResult, verified) {
  const results = contactResult.results || [];
  const valid = results.find(result => result.status === 'valid');
  const bestGuess = results[0]?.email || '';
  if (valid && !isCatchAllResult(valid)) {
    return {
      email: valid.email,
      bestGuess,
      status: 'valid',
      confidence: valid.confidence || 'medium',
      reason: valid.reason || '',
      sendability: 'safe',
      catchAll: 'no',
    };
  }
  if (valid) {
    return {
      email: '',
      bestGuess: valid.email,
      status: 'catch_all',
      confidence: 'medium',
      reason: `${valid.reason || ''} Exact mailbox is not proven because the domain is catch-all.`.trim(),
      sendability: 'risky_catch_all',
      catchAll: 'yes',
    };
  }

  if (!verified) {
    const candidate = results[0];
    if (candidate) return { email: candidate.email, bestGuess, status: 'candidate', confidence: 'unverified', reason: candidate.reason || '', sendability: 'unverified_candidate', catchAll: 'unknown' };
  }

  const catchAll = results.find(result => result.status === 'catch_all');
  if (catchAll) return { email: '', bestGuess: catchAll.email, status: 'catch_all', confidence: 'low', reason: catchAll.reason || '', sendability: 'risky_catch_all', catchAll: 'yes' };

  const risky = results.find(result => result.status === 'risky');
  if (risky) return { email: '', bestGuess: risky.email, status: isCatchAllResult(risky) ? 'catch_all' : 'risky', confidence: risky.confidence || 'medium', reason: risky.reason || '', sendability: sendabilityForResult(risky), catchAll: catchAllFlag(risky) };

  const unknown = results.find(result => result.status === 'unknown');
  if (unknown) return { email: '', bestGuess, status: 'unknown', confidence: unknown.confidence || 'low', reason: unknown.reason || '', sendability: 'unknown', catchAll: catchAllFlag(unknown) };

  return { email: '', bestGuess, status: contactResult.error ? 'error' : 'not_found', confidence: '', reason: contactResult.error || '', sendability: contactResult.error ? 'error' : 'not_found', catchAll: 'unknown' };
}

// ── Data cleaning (ported from n8n workflow) ─────────────────────────────────

const COMPANY_SUFFIX_RE = /\s*,?\s*\b(ltd\.?|limited|llp|plc|inc\.?|incorporated|corp\.?|corporation|co\.?|company|gmbh|sarl|bv|ag|sa|pty\.?\s*ltd\.?|pty|llc|l\.l\.c\.|l\.l\.p\.|l\.p\.|lp|holdings?|group\s+ltd\.?|group\s+limited)\b\.?\s*$/i;

const TRAILING_LOCATION_RE = /\s*,?\s*\b(uk|u\.k\.|united kingdom|great britain|gb|england|scotland|wales|northern ireland|ireland|italy|europe|european|usa|u\.s\.a\.|us|u\.s\.|united states|america|canada|australia|new zealand|south africa|sa|uae|dubai|qatar|singapore|india|france|germany|spain|netherlands|global|international|worldwide|london|manchester|birmingham|leeds|liverpool|bristol|sheffield|nottingham|leicester|coventry|edinburgh|glasgow|cardiff|belfast|oxford|cambridge|york|reading|milton keynes|brighton|hove|portsmouth|southampton|plymouth|exeter|bath|norwich|newcastle|sunderland|durham|preston|blackpool|chester|worcester|gloucester|cheltenham|derby|stoke|wolverhampton|walsall|solihull|warwick|northampton|bedford|luton|watford|slough|croydon|guildford|maidstone|canterbury|dover|aberdeen|dundee|inverness|swansea|newport)\b\.?\s*$/i;

const EXTRA_INFO_AFTER_SEPARATOR_RE = /\s*(?:\||–|—|-|\/|,|:)\s*(b\s*corp(?:oration)?|certified\s+b\s*corp|official|registered|award[-\s]?winning|member|members?|certified|accredited|approved|authorised|authorized)\b.*$/i;

function cleanToSmartTitleCase(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const keepUpper = new Set(['UK','US','USA','UAE','EU','AI','API','TV','HR','IT','CEO','CFO','COO','CTO','CIO','CMO','CRO','CPO','VP','MD','B2B','B2C','SaaS','SEO','PPC','CRM','ERP']);
  const smallWords = new Set(['and','or','of','the','for','in','on','at','to','by','with','a','an']);
  return t.toLowerCase()
    .split(/(\s+|[-/&|,.()])/)
    .map((part, index, parts) => {
      if (!part || /^\s+$/.test(part) || /^[-/&|,.()]$/.test(part)) return part;
      const upper = part.toUpperCase();
      if (keepUpper.has(upper)) return upper;
      if (/^\d+$/.test(part)) return part;
      if (smallWords.has(part) && index !== 0 && index !== parts.length - 1) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('')
    .replace(/\bCo-Founder\b/gi, 'Co-Founder')
    .trim();
}

function cleanRemoveLegalSuffixes(name) {
  let prev;
  do { prev = name; name = name.replace(COMPANY_SUFFIX_RE, '').replace(/[,.\s]+$/g, '').trim(); } while (name !== prev);
  return name;
}

function cleanRemoveTrailingLocations(name) {
  let prev;
  do { prev = name; name = name.replace(TRAILING_LOCATION_RE, '').replace(/[,.\s]+$/g, '').trim(); } while (name !== prev);
  return name;
}

function cleanCompanyBase(value) {
  let name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) return '';
  name = name.replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
  name = name.replace(EXTRA_INFO_AFTER_SEPARATOR_RE, '').replace(/\s+/g, ' ').trim();
  name = name.replace(/\s+\bcertified\s+b\s*corp(?:oration)?\b\.?$/i, '').trim();
  name = name.replace(/\s+\bb\s*corp(?:oration)?\b\.?$/i, '').trim();
  name = cleanRemoveLegalSuffixes(name);
  name = name.replace(/[,.\s]+$/g, '').trim();
  const letters = name.replace(/[^A-Za-z]/g, '');
  if (letters.length > 0 && !/[a-z]/.test(name)) name = cleanToSmartTitleCase(name);
  return name;
}

function cleanCompanyForEmails(value) {
  let name = cleanCompanyBase(value);
  if (!name) return '';
  name = cleanRemoveTrailingLocations(name);
  name = cleanRemoveLegalSuffixes(name);
  return name.replace(/[,.\s]+$/g, '').trim();
}

const ROLE_PATTERNS = [
  { rank: 100, label: 'Co-Founder',      re: /\bco[-\s]?founder\b/i },
  { rank: 99,  label: 'Founder',         re: /\bfounder\b/i },
  { rank: 97,  label: 'Owner',           re: /\b(business owner|owner|proprietor)\b/i },
  { rank: 95,  label: 'CEO',             re: /\b(chief executive officer|ceo)\b/i },
  { rank: 93,  label: 'Managing Director', re: /\b(managing director|\bmd\b)\b/i },
  { rank: 90,  label: 'CFO',             re: /\b(chief financial officer|cfo)\b/i },
  { rank: 90,  label: 'COO',             re: /\b(chief operating officer|coo)\b/i },
  { rank: 90,  label: 'CTO',             re: /\b(chief technology officer|cto)\b/i },
  { rank: 90,  label: 'CIO',             re: /\b(chief information officer|cio)\b/i },
  { rank: 90,  label: 'CMO',             re: /\b(chief marketing officer|cmo)\b/i },
  { rank: 90,  label: 'CRO',             re: /\b(chief revenue officer|cro)\b/i },
  { rank: 90,  label: 'CPO',             re: /\b(chief product officer|cpo|chief people officer)\b/i },
  { rank: 88,  label: 'Chief Officer',   re: /\bchief\s+[a-z&\s]+\s+officer\b/i },
  { rank: 84,  label: 'Partner',         re: /\b(partner)\b/i },
  { rank: 82,  label: 'President',       re: /\b(president)\b/i },
  { rank: 80,  label: 'Vice President',  re: /\b(vice president|vp)\b/i },
  { rank: 76,  label: 'Director',        re: /\b([a-z]+\s+){0,2}director\b/i },
  { rank: 72,  label: 'Head',            re: /\bhead\s+of\s+[a-z&\s]+|\bhead\b/i },
  { rank: 68,  label: 'Principal',       re: /\bprincipal\b/i },
  { rank: 64,  label: 'Lead',            re: /\blead\b/i },
  { rank: 60,  label: 'Manager',         re: /\b([a-z]+\s+){0,1}manager\b/i },
  { rank: 50,  label: 'Consultant',      re: /\bconsultant\b/i },
  { rank: 48,  label: 'Engineer',        re: /\bengineer\b/i },
  { rank: 48,  label: 'Developer',       re: /\bdeveloper\b/i },
  { rank: 46,  label: 'Designer',        re: /\bdesigner\b/i },
  { rank: 44,  label: 'Specialist',      re: /\bspecialist\b/i },
  { rank: 40,  label: 'Coordinator',     re: /\bcoordinator\b/i },
  { rank: 35,  label: 'Assistant',       re: /\bassistant\b/i },
];

const PRESERVE_FULL_TITLE = new Set(['Director','Head','Manager','Lead','Principal','Partner','Consultant','Engineer','Developer','Designer','Specialist','Coordinator','Assistant']);

function cleanStripCompanyFromTitle(title, companyName) {
  let t = String(title || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const variants = [...new Set([cleanCompanyBase(companyName), cleanCompanyForEmails(companyName)].filter(Boolean))];
  for (const c of variants) {
    if (!c) continue;
    const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp('^\\s*' + esc + '\\s*[-–—|:/]+\\s*', 'i'), '').trim();
    t = t.replace(new RegExp('\\s+(at|@)\\s+' + esc + '(\\s|$).*', 'i'), '').trim();
  }
  t = t.replace(/\s+(at|@)\s+.+$/i, '').trim();
  return t;
}

function cleanChooseHighestTitle(value, companyName) {
  const original = cleanStripCompanyFromTitle(value, companyName);
  if (!original) return '';
  let best = null;
  for (const role of ROLE_PATTERNS) {
    const match = original.match(role.re);
    if (!match) continue;
    const candidate = PRESERVE_FULL_TITLE.has(role.label)
      ? cleanToSmartTitleCase(String(match[0] || '').trim())
      : role.label;
    if (!best || role.rank > best.rank) best = { rank: role.rank, title: candidate };
  }
  return best ? best.title : cleanToSmartTitleCase(original);
}

function cleanDataRow(row) {
  const out = { ...row };

  // Apollo exports use either "Company" or "Company Name" — handle both
  const companyKey = 'Company Name' in row ? 'Company Name' : ('Company' in row ? 'Company' : null);
  // Title column may also appear as "Job Title"
  const titleKey = 'Title' in row ? 'Title' : ('Job Title' in row ? 'Job Title' : null);

  const origCompany = companyKey ? (row[companyKey] || '') : '';
  const origForEmails = row['Company Name for Emails'] || origCompany;

  const cleanedCompany = cleanCompanyBase(origCompany);
  const cleanedForEmails = cleanCompanyForEmails(origForEmails || cleanedCompany);

  // Clean company columns in place
  if (companyKey) out[companyKey] = cleanedCompany || origCompany;
  if ('Company Name for Emails' in row) out['Company Name for Emails'] = cleanedForEmails || cleanedCompany || origCompany;

  // Add Clean Job Title as a NEW column — original title preserved unchanged
  if (titleKey) out['Clean Job Title'] = cleanChooseHighestTitle(row[titleKey] || '', cleanedCompany || origCompany);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

async function verifyEmailsCsvText(csvText, onProgress = () => {}, log = () => {}, job = null) {
  throwIfCancelled(job);
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one email row');

  const headers = rows[0].map(h => String(h || '').trim());
  const headerLookup = new Map(headers.map(h => [normalizeHeader(h), h]));

  const emailHeader = (() => {
    for (const name of ['Email', 'EmailAddress', 'Email Address', 'email']) {
      const key = normalizeHeader(name);
      if (headerLookup.has(key)) return headerLookup.get(key);
    }
    return null;
  })();

  if (!emailHeader) throw new Error('No "Email" column found in CSV.');

  // Build output headers — insert "Clean Job Title" right after the title column
  const titleKeyInHeaders = headers.find(h => h === 'Title' || h === 'Job Title');
  const outputHeaders = [...headers];
  if (titleKeyInHeaders) {
    outputHeaders.splice(outputHeaders.indexOf(titleKeyInHeaders) + 1, 0, 'Clean Job Title');
  }

  const sourceRows = rows.slice(1, MAX_CONTACTS + 1);
  // Each slot stores { rowValues, bucket } where bucket is 'safe' | 'catchall' | 'invalid'
  const results = new Array(sourceRows.length);
  const preview = [];
  let validCount = 0;
  let catchAllCount = 0;
  let invalidCount = 0;
  let skippedCount = 0;
  let processedRows = 0;

  log(`CSV parsed: ${sourceRows.length} rows · email column: "${emailHeader}"`);
  log(`Verifying with Reacher · concurrency: ${ROW_CONCURRENCY}`);

  async function processRow(index) {
    throwIfCancelled(job);
    const rawRowValues = sourceRows[index];
    const rawRow = {};
    headers.forEach((h, i) => { rawRow[h] = rawRowValues[i] ?? ''; });
    const cleanedRow = cleanDataRow(rawRow);
    const rowValues = outputHeaders.map(h => cleanedRow[h] ?? '');
    const row = cleanedRow;
    const email = normalizeEmail(String(row[emailHeader] || '').trim());

    if (!email) {
      results[index] = { rowValues, bucket: 'invalid' };
      skippedCount += 1;
      invalidCount += 1;
      processedRows += 1;
      onProgress({ processedRows, rowCount: sourceRows.length, foundCount: validCount, catchAllCount, reviewCount: invalidCount, preview });
      return;
    }

    log(`[${index + 1}/${sourceRows.length}] ${email}`);
    const result = await checkWithReacher(email, job);
    throwIfCancelled(job);

    const isCA = isCatchAllResult(result);
    const sendability = sendabilityForResult(result);
    let bucket;
    if (result.status === 'valid' && !isCA) { bucket = 'safe'; validCount += 1; }
    else if (isCA || sendability === 'risky_catch_all') { bucket = 'catchall'; catchAllCount += 1; }
    else { bucket = 'invalid'; invalidCount += 1; }

    log(`  → ${result.status} · ${sendability}`);
    results[index] = { rowValues, bucket };

    if (preview.length < 10) {
      preview.push({ email, status: result.status || 'unknown', sendability });
    }

    processedRows += 1;
    onProgress({ processedRows, rowCount: sourceRows.length, foundCount: validCount, catchAllCount, reviewCount: invalidCount, preview });
  }

  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(ROW_CONCURRENCY, sourceRows.length) }, async () => {
    while (nextIndex < sourceRows.length) {
      throwIfCancelled(job);
      const i = nextIndex++;
      await processRow(i);
    }
  });
  await Promise.all(workers);

  const safeRows   = results.filter(r => r.bucket === 'safe').map(r => r.rowValues);
  const catchAllRows = results.filter(r => r.bucket === 'catchall').map(r => r.rowValues);
  const invalidRows  = results.filter(r => r.bucket === 'invalid').map(r => r.rowValues);

  return {
    rowCount: sourceRows.length,
    foundCount: validCount,
    catchAllCount,
    reviewCount: invalidCount,
    preview,
    csvText: stringifyCsv([outputHeaders, ...results.map(r => r.rowValues)]),
    safeCsvText: stringifyCsv([outputHeaders, ...safeRows]),
    catchAllCsvText: stringifyCsv([outputHeaders, ...catchAllRows]),
    reviewCsvText: stringifyCsv([outputHeaders, ...invalidRows]),
  };
}

async function enrichCsvText(csvText, verifier, onProgress = () => {}, log = () => {}, job = null) {
  throwIfCancelled(job);
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one contact row');

  const headers = rows[0].map(header => String(header || '').trim());
  const headerLookup = new Map(headers.map(header => [normalizeHeader(header), header]));
  const outputHeaders = [
    ...headers,
    'FoundEmail',
    'BestGuessEmail',
    'EmailFinderPermutations',
    'EmailFinderStatus',
    'EmailFinderConfidence',
    'EmailFinderSendability',
    'EmailFinderCatchAll',
    'EmailFinderReason',
  ];
  const sourceRows = rows.slice(1, MAX_CONTACTS + 1);
  const outputRows = [outputHeaders];
  const preview = [];
  let foundCount = 0;
  let catchAllCount = 0;
  let reviewCount = 0;
  let processedRows = 0;
  const enrichedRows = new Array(sourceRows.length);

  log(`CSV parsed: ${sourceRows.length} contact rows`);
  log(`Mode: ${verifier}`);
  log(`Worker concurrency: ${verifier !== 'permutation' ? ROW_CONCURRENCY : 'fast local generation'}`);
  if (verifier !== 'permutation') log(`Testing up to ${VERIFY_CANDIDATES} permutations per contact, ${CANDIDATE_CONCURRENCY} at a time`);

  async function processRow(index) {
    throwIfCancelled(job);
    const rowValues = sourceRows[index];
    const row = rowToObject(headers, rowValues);
    const contact = contactFromCsvRow(row, headerLookup);
    const domain = normalizeDomain(contact.domain);
    const displayName = `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || `row ${index + 1}`;
    log(`Row ${index + 1}/${sourceRows.length}: ${displayName} @ ${domain || 'missing-domain'}`);
    const result = verifier === 'reacher'
      ? await verifyContactWithReacher(contact, message => log(`Row ${index + 1}: ${message}`), job)
      : verifier === 'smtp'
        ? await verifyContact(contact, message => log(`Row ${index + 1}: ${message}`), job)
        : generateContact(contact);
    throwIfCancelled(job);
    const found = pickFoundEmail(result, verifier !== 'permutation');
    const permutations = (result.results || []).map(candidate => candidate.email).filter(Boolean).join('; ');
    if (found.email) foundCount += 1;
    if (found.sendability === 'risky_catch_all' || found.catchAll === 'yes' || found.status === 'catch_all') {
      catchAllCount += 1;
    } else if (found.sendability !== 'safe') {
      reviewCount += 1;
    }
    log(`Row ${index + 1}: ${found.email ? `selected ${found.email}` : `no email selected`} (${found.status})`);

    const enrichedRow = [
      ...headers.map((_, columnIndex) => rowValues[columnIndex] ?? ''),
      found.email,
      found.bestGuess,
      permutations,
      found.status,
      found.confidence,
      found.sendability,
      found.catchAll,
      found.reason,
    ];

    if (preview.length < 8) {
      preview.push({
        name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
          domain: normalizeDomain(contact.domain),
          foundEmail: found.email,
          bestGuessEmail: found.bestGuess,
          status: found.status,
          sendability: found.sendability,
      });
    }

    enrichedRows[index] = enrichedRow;
    processedRows += 1;
    onProgress({
      processedRows,
      rowCount: sourceRows.length,
      foundCount,
      catchAllCount,
      reviewCount,
      preview,
    });
  }

  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(ROW_CONCURRENCY, sourceRows.length) }, async () => {
    while (nextIndex < sourceRows.length) {
      throwIfCancelled(job);
      const index = nextIndex;
      nextIndex += 1;
      await processRow(index);
    }
  });
  await Promise.all(workers);

  outputRows.push(...enrichedRows);
  const statusIndex = outputHeaders.indexOf('EmailFinderStatus');
  const sendabilityIndex = outputHeaders.indexOf('EmailFinderSendability');
  const catchAllIndex = outputHeaders.indexOf('EmailFinderCatchAll');
  const safeRows = enrichedRows.filter(row => row[sendabilityIndex] === 'safe');
  const catchAllRows = enrichedRows.filter(row => row[catchAllIndex] === 'yes' || row[sendabilityIndex] === 'risky_catch_all' || row[statusIndex] === 'catch_all');
  const reviewRows = enrichedRows.filter(row => row[sendabilityIndex] !== 'safe' && row[catchAllIndex] !== 'yes' && row[sendabilityIndex] !== 'risky_catch_all' && row[statusIndex] !== 'catch_all');

  return {
    rowCount: sourceRows.length,
    foundCount,
    catchAllCount: catchAllRows.length,
    reviewCount: reviewRows.length,
    preview,
    csvText: stringifyCsv(outputRows),
    safeCsvText: stringifyCsv([outputHeaders, ...safeRows]),
    catchAllCsvText: stringifyCsv([outputHeaders, ...catchAllRows]),
    reviewCsvText: stringifyCsv([outputHeaders, ...reviewRows]),
  };
}

function publicJob(job) {
  return {
    id: job.id,
    fileName: job.fileName,
    outputFileName: job.outputFileName,
    status: job.status,
    verify: job.verify,
    verifier: job.verifier,
    rowCount: job.rowCount,
    processedRows: job.processedRows,
    foundCount: job.foundCount,
    catchAllCount: job.catchAllCount,
    reviewCount: job.reviewCount,
    preview: job.preview,
    logs: job.logs,
    cancelRequested: job.cancelRequested,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    // Staleness, so a caller can tell "0% for 2 seconds" from "0% for 6 minutes".
    // Nothing exposed this before, which is why a stalled job looked identical
    // to a starting one in both the UI and the API.
    lastProgressAt: job.lastProgressAt || null,
    stalledMs: job.status === 'running' && job.lastProgressAt ? Date.now() - job.lastProgressAt : 0,
    slots: reacherSlotStats(),
    downloadUrl: job.status === 'completed' ? `/api/jobs/${job.id}/download` : null,
    safeDownloadUrl: job.status === 'completed' ? `/api/jobs/${job.id}/download/safe` : null,
    catchAllDownloadUrl: job.status === 'completed' ? `/api/jobs/${job.id}/download/catch-all` : null,
    reviewDownloadUrl: job.status === 'completed' ? `/api/jobs/${job.id}/download/review` : null,
  };
}

function nextOutputName(fileName) {
  const cleanName = String(fileName || 'contacts.csv').replace(/[^\w .()-]/g, '').trim() || 'contacts.csv';
  const parsed = path.parse(cleanName);
  return `${parsed.name || 'contacts'}-enriched.csv`;
}

function outputNameFor(fileName, suffix) {
  const cleanName = String(fileName || 'contacts.csv').replace(/[^\w .()-]/g, '').trim() || 'contacts.csv';
  const parsed = path.parse(cleanName);
  return `${parsed.name || 'contacts'}-${suffix}.csv`;
}

function startQueueWorker() {
  if (workerActive) return;
  workerActive = true;
  setTimeout(processQueue, 0);
}

// ── Stall watchdog ────────────────────────────────────────────────────────
// A job that stops making progress used to sit at status 'running' forever, with
// no alarm and no way to tell it apart from one that had just started. On
// 2026-08-28 that state lasted 6+ minutes, held every proxy slot, and locked out
// all other verification until the process was killed by hand.
//
// This cancels a job that has made no progress for JOB_STALL_TIMEOUT_MS, which
// releases its slots and unblocks the queue. Set to 0 to disable.
const JOB_STALL_TIMEOUT_MS = Math.max(0, parseInt(process.env.JOB_STALL_TIMEOUT_MS || '180000', 10));
const JOB_STALL_CHECK_MS = 30000;

function checkStalledJobs() {
  if (!JOB_STALL_TIMEOUT_MS) return;
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.status !== 'running' || job.cancelRequested) continue;
    const idleMs = now - (job.lastProgressAt || now);
    if (idleMs < JOB_STALL_TIMEOUT_MS) continue;

    const slots = reacherSlotStats();
    const msg = `Stalled — no progress for ${Math.round(idleMs / 1000)}s at row `
      + `${job.processedRows}/${job.rowCount || '?'} (slots ${slots.active}/${slots.cap}, `
      + `${slots.queued} queued). Stopping so it cannot hold verifier capacity.`;
    console.error(`[watchdog] job ${job.id}: ${msg}`);
    addJobLog(job, msg);

    // Same three-way stop as a manual cancel.
    job.cancelRequested = true;
    job.error = job.error || 'Stalled — no progress, stopped automatically';
    if (job.activeSockets) {
      for (const s of job.activeSockets) { try { s.destroy(new Error('Job stalled')); } catch {} }
      job.activeSockets.clear();
    }
    if (job.activeAborters) {
      for (const c of job.activeAborters) { try { c.abort(); } catch {} }
      job.activeAborters.clear();
    }
    _dropQueuedWaitersForJob(job);
  }
}
setInterval(checkStalledJobs, JOB_STALL_CHECK_MS).unref();

async function processQueue() {
  // The whole loop is wrapped so workerActive ALWAYS clears. If anything threw
  // outside the per-job try below, the flag stayed true and startQueueWorker()
  // returned early forever — every future job would queue and never run, with
  // no error anywhere.
  try {
    await runQueueLoop();
  } finally {
    workerActive = false;
  }
}

async function runQueueLoop() {
  while (jobQueue.length) {
    const jobId = jobQueue.shift();
    const job = jobs.get(jobId);
    if (!job || job.status !== 'queued') continue;

    job.status = 'running';
    job.startedAt = new Date().toISOString();
    addJobLog(job, 'Job started');
    try {
      const onProgress = progress => {
        job.processedRows = progress.processedRows;
        job.rowCount = progress.rowCount;
        job.foundCount = progress.foundCount;
        job.catchAllCount = progress.catchAllCount;
        job.reviewCount = progress.reviewCount;
        job.preview = progress.preview;
        job.lastProgressAt = Date.now();   // heartbeat for the stall watchdog
      };
      job.lastProgressAt = Date.now();     // reset at start, not job creation
      const result = job.verifier === 'permutation'
        ? await generatePermutationCsvText(job.csvText, onProgress, message => addJobLog(job, message), job)
        : job.verifier === 'verify_emails'
          ? await verifyEmailsCsvText(job.csvText, onProgress, message => addJobLog(job, message), job)
          : await enrichCsvText(job.csvText, job.verifier, onProgress, message => addJobLog(job, message), job);
      job.csvText = '';
      job.outputCsvText = result.csvText;
      job.safeCsvText = result.safeCsvText;
      job.catchAllCsvText = result.catchAllCsvText;
      job.reviewCsvText = result.reviewCsvText;
      job.rowCount = result.rowCount;
      job.processedRows = result.rowCount;
      job.foundCount = result.foundCount;
      job.catchAllCount = result.catchAllCount;
      job.reviewCount = result.reviewCount;
      job.preview = result.preview;
      if (job.verifier === 'verify_emails') {
        incrementStats(job.foundCount || 0, job.catchAllCount || 0, job.reviewCount || 0);
      }
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      addJobLog(job, job.verifier === 'permutation'
        ? `Completed: ${job.foundCount} permutations generated`
        : job.verifier === 'verify_emails'
          ? `Completed: ${job.foundCount} verified, ${job.catchAllCount || 0} catch-all, ${job.reviewCount || 0} invalid/unknown`
          : `Completed: ${job.foundCount} valid rows, ${job.catchAllCount || 0} catch-all rows, ${job.reviewCount || 0} needs-review rows`);
    } catch (err) {
      job.csvText = '';
      job.status = err instanceof JobCancelledError ? 'cancelled' : 'failed';
      job.error = err instanceof JobCancelledError ? '' : (err.message || 'Job failed');
      job.completedAt = new Date().toISOString();
      addJobLog(job, job.status === 'cancelled' ? 'Cancelled by user' : `Failed: ${job.error}`);
    }
  }
}

async function handleFind(req, res) {
  try {
    const body = await readBody(req);
    const contacts = Array.isArray(body.contacts) ? body.contacts.slice(0, MAX_CONTACTS) : [];
    const verifier = normalizeVerifier(body.verifier, body.verify === true);
    if (!contacts.length) return sendJson(res, 400, { error: 'Add at least one contact' });

    const cleaned = contacts.map(contact => ({
      firstName: String(contact.firstName || '').trim(),
      lastName: String(contact.lastName || '').trim(),
      domain: normalizeDomain(contact.domain),
    }));

    const results = [];
    for (const contact of cleaned) {
      results.push(verifier === 'reacher'
        ? await verifyContactWithReacher(contact)
        : verifier === 'smtp'
          ? await verifyContact(contact)
          : generateContact(contact));
    }
    sendJson(res, 200, { verifier, sender: SMTP_SENDER, reacher_url: REACHER_URL, results });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Email finder failed' });
  }
}

async function handleVerifyEmail(req, res) {
  try {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const verifier = normalizeVerifier(body.verifier, true);
    if (!email) return sendJson(res, 400, { error: 'Enter a valid email address' });
    if (verifier === 'permutation') {
      return sendJson(res, 400, { error: 'Choose Reacher or Built-in SMTP for a single-email verification' });
    }

    const started = Date.now();
    const result = verifier === 'reacher'
      ? await checkWithReacher(email)
      : await checkExactWithSmtp(email);

    sendJson(res, 200, {
      verifier,
      email,
      ms: Date.now() - started,
      reacher_url: verifier === 'reacher' ? reacherEndpoint() : '',
      result,
    });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Email verification failed' });
  }
}

async function handleEnrichCsv(req, res) {
  try {
    const body = await readBody(req);
    const csvText = String(body.csvText || '');
    const verifier = normalizeVerifier(body.verifier, body.verify === true);
    const result = await enrichCsvText(csvText, verifier);
    sendJson(res, 200, { fileName: 'contacts-enriched.csv', ...result });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'CSV enrichment failed' });
  }
}

async function handleCreateJob(req, res) {
  try {
    const body = await readBody(req);
    const csvText = String(body.csvText || '');
    const fileName = String(body.fileName || 'contacts.csv');
    if (!csvText.trim()) return sendJson(res, 400, { error: 'Upload a CSV file first' });

    const id = crypto.randomUUID();
    const job = {
      id,
      fileName,
      outputFileName: nextOutputName(fileName),
      safeOutputFileName: outputNameFor(fileName, 'valid'),
      catchAllOutputFileName: outputNameFor(fileName, 'catch-all'),
      reviewOutputFileName: outputNameFor(fileName, 'needs-review'),
      verifier: normalizeVerifier(body.verifier || DEFAULT_VERIFIER, body.verify === true),
      verify: normalizeVerifier(body.verifier || DEFAULT_VERIFIER, body.verify === true) !== 'permutation',
      status: 'queued',
      csvText,
      outputCsvText: '',
      safeCsvText: '',
      catchAllCsvText: '',
      reviewCsvText: '',
      rowCount: 0,
      processedRows: 0,
      foundCount: 0,
      catchAllCount: 0,
      reviewCount: 0,
      preview: [],
      logs: [],
      cancelRequested: false,
      activeSockets: new Set(),
      // In-flight fetch aborters for Reacher calls. activeSockets only ever held
      // the built-in SMTP verifier's sockets, so for Reacher jobs — i.e. all
      // production traffic — cancel had nothing to destroy and could not stop a
      // running job. These give cancel a real handle on the work.
      activeAborters: new Set(),
      error: '',
      createdAt: new Date().toISOString(),
      startedAt: '',
      completedAt: '',
      // Heartbeat for stall detection. On 2026-08-28 a job sat at 0 rows for
      // 6+ minutes and nothing noticed, because nothing recorded when progress
      // last moved.
      lastProgressAt: Date.now(),
    };
    addJobLog(job, 'Job queued');
    jobs.set(id, job);
    jobQueue.push(id);
    startQueueWorker();
    sendJson(res, 202, publicJob(job));
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Could not create job' });
  }
}

function handleListJobs(req, res) {
  const list = [...jobs.values()]
    .map(publicJob)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 100);
  sendJson(res, 200, list);
}

function handleCancelJob(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) return sendJson(res, 404, { error: 'Job not found' });
  if (!['queued', 'running'].includes(job.status)) return sendJson(res, 400, { error: `Job is already ${job.status}` });

  job.cancelRequested = true;
  addJobLog(job, 'Stop requested');

  // Stop the work three ways. Previously only the first applied, and it is inert
  // for Reacher jobs (activeSockets is populated solely by the built-in SMTP
  // verifier), so cancelling a running Reacher job did nothing at all.
  if (job.activeSockets) {
    for (const socket of job.activeSockets) socket.destroy(new Error('Job cancelled'));
    job.activeSockets.clear();
  }
  // 2: abort in-flight Reacher HTTP calls.
  let aborted = 0;
  if (job.activeAborters) {
    for (const ctrl of job.activeAborters) { try { ctrl.abort(); aborted++; } catch {} }
    job.activeAborters.clear();
  }
  // 3: evict workers parked in the concurrency queue, which is where they were
  // stuck on 2026-08-28 — below the last cancellation checkpoint, waiting on a
  // slot that never came.
  const dropped = _dropQueuedWaitersForJob(job);
  if (aborted || dropped) addJobLog(job, `Stopped ${aborted} in-flight check(s), dropped ${dropped} queued`);

  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.csvText = '';
    job.completedAt = new Date().toISOString();
    addJobLog(job, 'Cancelled before starting');
  }

  sendJson(res, 200, publicJob(job));
}

function handleJobStatus(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) return sendJson(res, 404, { error: 'Job not found' });
  sendJson(res, 200, publicJob(job));
}

function handleJobDownload(_req, res, jobId, kind = 'all') {
  const job = jobs.get(jobId);
  if (!job) {
    res.writeHead(404);
    res.end('Job not found');
    return;
  }
  const downloads = {
    all: { csvText: job.outputCsvText, fileName: job.outputFileName },
    safe: { csvText: job.safeCsvText, fileName: job.safeOutputFileName },
    'catch-all': { csvText: job.catchAllCsvText, fileName: job.catchAllOutputFileName },
    review: { csvText: job.reviewCsvText, fileName: job.reviewOutputFileName },
  };
  const download = downloads[kind] || downloads.all;
  if (job.status !== 'completed' || !download.csvText) {
    res.writeHead(409);
    res.end('Job is not complete');
    return;
  }
  const payload = download.csvText;
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${download.fileName.replace(/"/g, '')}"`,
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleIp(_req, res) {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    if (!response.ok) throw new Error(`IP check failed: ${response.status}`);
    sendJson(res, 200, await response.json());
  } catch (err) {
    sendJson(res, 200, { ip: 'Unavailable', error: err.message });
  }
}

function testTcp(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = net.createConnection(port, host);
    socket.setTimeout(timeoutMs);
    function finish(ok, detail) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ host, port, ok, ms: Date.now() - started, detail });
    }
    socket.on('connect', () => finish(true, 'connected'));
    socket.on('timeout', () => finish(false, 'timeout'));
    socket.on('error', err => finish(false, err.message));
  });
}

async function handleSmtpDiagnostic(_req, res) {
  const checks = [];
  let ip = 'Unavailable';
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    ip = data.ip || ip;
  } catch {}

  checks.push(await testTcp('gmail-smtp-in.l.google.com', 25));
  checks.push(await testTcp('aspmx.l.google.com', 25));
  checks.push(await testTcp('example.com', 80, 5000));

  const smtpReachable = checks.some(check => check.port === 25 && check.ok);
  sendJson(res, 200, {
    ip,
    smtpReachable,
    checks,
    message: smtpReachable
      ? 'Port 25 is reachable from this network. SMTP verification can at least connect.'
      : 'Port 25 timed out or failed. SMTP verification will mostly return unknown until your network route allows outbound SMTP.',
  });
}

async function handleReacherDiagnostic(_req, res) {
  const sample = process.env.REACHER_TEST_EMAIL || 'jesse@ottaly.co.uk';
  const started = Date.now();
  const baseUrl = reacherBaseUrl();
  const connectivity = {
    base_url: baseUrl,
    ok: false,
    status: null,
    ms: 0,
    reason: '',
  };

  const connectivityStarted = Date.now();
  try {
    const response = await fetchWithTimeout(baseUrl, { method: 'GET' }, REACHER_DIAGNOSTIC_TIMEOUT_MS);
    connectivity.ok = true;
    connectivity.status = response.status;
    connectivity.reason = `HTTP ${response.status}`;
  } catch (err) {
    connectivity.reason = isAbortError(err)
      ? `Timed out after ${REACHER_DIAGNOSTIC_TIMEOUT_MS}ms`
      : err.message;
  }
  connectivity.ms = Date.now() - connectivityStarted;

  const result = await checkWithReacher(sample);
  const resultFailed = String(result.reason || '').startsWith('Reacher error')
    || String(result.reason || '').startsWith('Reacher HTTP')
    || String(result.reason || '').startsWith('Reacher timed out');
  const today = _reacherTodayUtc();
  sendJson(res, 200, {
    reacher_base_url: baseUrl,
    reacher_url: reacherEndpoint(),
    reacher_pool: [{ label: _reacherMember.label, url: _reacherMember.url, usageToday: _reacherMember.usageDate === today ? _reacherMember.usageCount : 0 }],
    connectivity,
    test_email: sample,
    ms: Date.now() - started,
    result,
    ok: connectivity.ok && !resultFailed,
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
  const safePath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (req.method === 'POST' && req.url === '/api/find') return handleFind(req, res);
  if (req.method === 'POST' && req.url === '/api/verify-email') return handleVerifyEmail(req, res);
  if (req.method === 'POST' && req.url === '/api/enrich-csv') return handleEnrichCsv(req, res);
  if (req.method === 'GET' && pathname === '/api/jobs') return handleListJobs(req, res);
  if (req.method === 'POST' && pathname === '/api/jobs') return handleCreateJob(req, res);
  const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) return handleCancelJob(req, res, cancelMatch[1]);
  const statusMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && statusMatch) return handleJobStatus(req, res, statusMatch[1]);
  const downloadMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/download$/);
  if (req.method === 'GET' && downloadMatch) return handleJobDownload(req, res, downloadMatch[1]);
  const typedDownloadMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/download\/(safe|catch-all|review)$/);
  if (req.method === 'GET' && typedDownloadMatch) return handleJobDownload(req, res, typedDownloadMatch[1], typedDownloadMatch[2]);
  if (req.method === 'GET' && pathname === '/api/stats/verification') return handleGetStats(req, res);
  if (req.method === 'GET' && req.url === '/api/diagnostics/smtp') return handleSmtpDiagnostic(req, res);
  if (req.method === 'GET' && req.url === '/api/diagnostics/reacher') return handleReacherDiagnostic(req, res);
  if (req.method === 'GET' && req.url === '/api/ip') return handleIp(req, res);
  if (req.method === 'GET' && req.url === '/api/reacher-pool') {
    const today = _reacherTodayUtc();
    const m = _reacherMember;
    return sendJson(res, 200, {
      pool: [{
        label: m.label,
        url: m.url,
        usageToday: m.usageDate === today ? m.usageCount : 0,
        dailyLimit: null,
        failureCount: m.failureCount || 0,
        lastError: m.lastError || '',
        lastErrorAt: m.lastErrorAt || 0,
        cooldownUntil: 0,
        cooldownMsLeft: 0,
      }],
      // Live capacity, alongside the daily cumulative counters above. The
      // cumulative failure ratio could not represent "right now" — during the
      // 2026-08-28 outage it stayed under the alert threshold because Reacher
      // was returning HTTP 200 with an 'unknown' verdict, which is not counted
      // as a failure at all. These three numbers described the outage exactly.
      slots: reacherSlotStats(),
      secondary: secondaryStats(),
      runningJobs: [...jobs.values()].filter(j => j.status === 'running').map(j => ({
        id: j.id,
        processedRows: j.processedRows,
        rowCount: j.rowCount,
        stalledMs: j.lastProgressAt ? Date.now() - j.lastProgressAt : 0,
      })),
    });
  }
  const poolTestMatch = pathname.match(/^\/api\/reacher-pool-test\/([^/]+)$/);
  if (req.method === 'GET' && poolTestMatch) {
    (async () => {
      try {
        const base = await resolveReacherBaseFor(_reacherMember);
        const endpoint = /\/v[01]\/check_email$/.test(base) ? base : `${base}/${_reacherMember.version}/check_email`;
        const headers = { 'Content-Type': 'application/json' };
        if (_reacherMember.key) headers.authorization = _reacherMember.key.startsWith('Bearer ') ? _reacherMember.key : `Bearer ${_reacherMember.key}`;
        const resp = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ to_email: 'info@ottaly.co.uk' }),
        }, 60000);
        const ok = resp.ok || resp.status === 200;
        const body = await resp.text().catch(() => '');
        sendJson(res, 200, { ok, status: resp.status, endpoint, body: body.slice(0, 200) });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: err.message, endpoint: _reacherMember.url });
      }
    })();
    return;
  }
  // A single-email probe against a mailbox Reacher already knows the answer
  // for cannot show what a real push looks like: it skips the semaphore's
  // queueing/backpressure entirely and only ever exercises one connection.
  // This burst probe sends real concurrent traffic through the exact same
  // checkWithReacher() path production pushes use — same semaphore, same
  // per-minute limiter, same retry logic — against a spread of known-live
  // mailboxes at major providers, so "Concurrency limit reached" and other
  // proxy-side rejections show up here instead of only being visible mid-push.
  // ?n= controls how many are fired at once (default = the live concurrency
  // cap, so the default run reproduces exactly what one full batch of slots
  // looks like); pass a different n to test above/below the current cap.
  if (req.method === 'GET' && pathname === '/api/reacher-burst-test') {
    (async () => {
      const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
      const n = Math.max(1, Math.min(50, parseInt(reqUrl.searchParams.get('n'), 10) || PRIMARY_REACHER_CONCURRENCY));
      const domains = ['gmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'hotmail.com', 'bbc.co.uk', 'microsoft.com', 'amazon.co.uk', 'apple.com', 'nhs.uk'];
      const probeEmails = Array.from({ length: n }, (_, i) => `test.probe.${i}.${Date.now()}@${domains[i % domains.length]}`);
      const startedAt = Date.now();
      const results = await Promise.all(probeEmails.map(async (email) => {
        const t0 = Date.now();
        try {
          const result = await checkWithReacher(email);
          return { email, ms: Date.now() - t0, status: result.status, reason: result.reason || '' };
        } catch (err) {
          return { email, ms: Date.now() - t0, status: 'error', reason: err.message };
        }
      }));
      const counts = {};
      let concurrencyLimitHits = 0;
      for (const r of results) {
        counts[r.status] = (counts[r.status] || 0) + 1;
        if (/concurrency limit/i.test(r.reason)) concurrencyLimitHits += 1;
      }
      const unknownRate = results.length ? (counts.unknown || 0) / results.length : 0;
      sendJson(res, 200, {
        ok: concurrencyLimitHits === 0 && unknownRate < 0.4,
        ms: Date.now() - startedAt,
        sent: results.length,
        counts,
        concurrencyLimitHits,
        unknownRate,
        primaryConcurrencyCap: PRIMARY_REACHER_CONCURRENCY,
        results,
      });
    })();
    return;
  }
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Email Finder Local running on http://localhost:${PORT}`);
  console.log(`SMTP profile: rows=${ROW_CONCURRENCY}, candidates=${CANDIDATE_CONCURRENCY}, verify=${VERIFY_CANDIDATES}/${MAX_CANDIDATES}, timeout=${SMTP_TIMEOUT_MS}ms, delay=${CHECK_DELAY_MS}ms, maxContacts=${MAX_CONTACTS}`);
  console.log(`SMTP flags: starttls=${SMTP_STARTTLS}, catchAll=${CHECK_CATCH_ALL}, catchAllTiming=${CATCH_ALL_TIMING_MS}ms`);
  if (SOCKS5_HOST) console.log(`SOCKS5 proxy: ${SOCKS5_USER}@${SOCKS5_HOST}:${SOCKS5_PORT}`);
  console.log(`Reacher: ${_reacherMember.url || '(unset)'} [${_reacherMember.version}${_reacherMember.key ? ', key=bearer' : ', no-key'}] · concurrency cap=${PRIMARY_REACHER_CONCURRENCY} · today=${_reacherMember.usageCount} verified`);
  // Probe Reacher in the background so the first email check doesn't pay discovery latency.
  resolveReacherBase().catch(() => {});
});
