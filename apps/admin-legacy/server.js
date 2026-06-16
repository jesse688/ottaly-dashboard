const express   = require('express');
let Database;
try {
  Database = require('better-sqlite3');
} catch (err) {
  console.warn('[SQLite] better-sqlite3 not available, using PostgreSQL only');
  Database = null;
}
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const path      = require('path');
const fs        = require('fs');
const http      = require('http');
const net       = require('net');
const Stripe    = require('stripe');
const crypto    = require('crypto');
const { spawn } = require('child_process');

let PostgresDatabase;
try {
  PostgresDatabase = require('./db-postgres');
} catch (err) {
  console.warn('[PostgreSQL] pg module not available:', err.message);
  PostgresDatabase = null;
}

let SqliteDatabase;
try {
  SqliteDatabase = require('./db-sqlite');
} catch (err) {
  console.warn('[SQLite] db-sqlite.js not available:', err.message);
  SqliteDatabase = null;
}

const contactsAPI = require('./api-contacts');
const { cleanCompanyName, normalizeJobTitle } = require('./csv-importer');
const { locationCustomVars } = require('./location-normalizer');
const { google } = require('googleapis');
const Sentry = require('@sentry/node');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app  = express();
// Behind Easypanel's reverse proxy — trust the first proxy hop so
// express-rate-limit reads the real client IP from X-Forwarded-For.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const JWT_SECRET             = process.env.JWT_SECRET             || 'ottaly-dev-secret-change-in-prod';
const ADMIN_KEY              = process.env.ADMIN_KEY              || 'ottaly-admin';
// Sessions are signed with JWT_SECRET + ADMIN_KEY so changing ADMIN_KEY in
// env (password rotation) automatically invalidates every existing session.
// No need to also rotate JWT_SECRET — the password change is sufficient.
const SESSION_SECRET         = JWT_SECRET + ':' + ADMIN_KEY;
const PLUSVIBE_KEY           = process.env.PLUSVIBE_KEY           || '6425e882-f33fb46a-2837ff5a-eb535a60';
// Bison API key resolution: a key saved via the admin dashboard (stored in
// app_settings, hydrated into _bisonKeyOverride on boot) takes precedence over
// the BISON_API_KEY env var, which now acts as a fallback/seed. getBisonKey()
// is the single source of truth — every Bison request reads it live so a key
// changed in the UI takes effect without a server restart.
const BISON_ENV_KEY = process.env.BISON_API_KEY || process.env.PLUSVIBE_KEY || '';
let _bisonKeyOverride = null; // set from app_settings on boot + on save
function getBisonKey() { return _bisonKeyOverride || BISON_ENV_KEY; }

// ── Per-workspace Bison tokens (the logout fix) ──────────────────────────────
// Bison's API is STATEFUL: the super-admin token has ONE active workspace, and
// switch-workspace mutates it for the whole token — which Bison treats as one
// logged-in session. Our crons loop every workspace switching this shared token,
// so a human logged into the Bison WEB UI on the same account keeps getting
// kicked ("only one login at a time"). The fix: give each workspace its OWN
// scoped API token (minted via POST /api/workspaces/v1.1/{team_id}/api-tokens
// with the super-admin key). When a per-workspace token exists, _bisonRaw uses
// it as the bearer and SKIPS switch-workspace entirely — so nothing the cron
// does can ever touch a human's session. The super-admin key is retained only
// to mint these tokens and as a fallback for any workspace without one.
// Stored in app_settings `bison_ws_tokens` as { [team_id]: plain_text_token },
// hydrated into this map on boot + on mint, so it works without a restart.
let _bisonWsTokens = {}; // { [team_id:string]: token } — empty until minted/hydrated
function getBisonWsToken(teamId) {
  const t = _bisonWsTokens[String(teamId)];
  return (t && typeof t === 'string' && t.trim()) ? t.trim() : null;
}

// Mint a per-workspace API token for one team using the SUPER-ADMIN key (the ONLY
// thing super-admin is used for, per policy). Persists into _bisonWsTokens +
// app_settings so it works without a restart and every later request to that
// workspace uses the per-workspace token (no super-admin, no switch-workspace).
// In-flight mints are de-duped so concurrent requests don't double-mint. Returns
// the token, or throws (e.g. no super-admin key configured).
let _bisonMintInFlight = {}; // team_id -> Promise<token>
async function mintBisonWsToken(teamId) {
  const tid = String(teamId);
  const existing = getBisonWsToken(tid);
  if (existing) return existing;
  if (_bisonMintInFlight[tid]) return _bisonMintInFlight[tid];
  _bisonMintInFlight[tid] = (async () => {
    if (!getBisonKey()) throw new Error('Cannot mint Bison token: super-admin key not configured');
    const team = BISON_TEAMS.find((t) => t.team_id === tid);
    const label = `ottaly-admin-${team ? team.name : tid}`.slice(0, 60);
    // NO wsId -> _bisonRaw does not switch; the api-tokens endpoint is team-scoped
    // in the path and authorized by the super-admin bearer.
    const data = await _bisonRaw(`/api/workspaces/v1.1/${tid}/api-tokens`, { method: 'POST', body: { name: label } });
    const token = data?.data?.plain_text_token;
    if (!token) throw new Error('mint: no plain_text_token in response for team ' + tid);
    _bisonWsTokens[tid] = token;
    try { const pg = app && app.locals && app.locals.pgDb; if (pg) await pg.setSetting('bison_ws_tokens', _bisonWsTokens); }
    catch (e) { console.warn('[bison] minted token but persist failed for team ' + tid + ':', e.message); }
    console.log('[bison] minted per-workspace token for team ' + tid + (team ? ' (' + team.name + ')' : ''));
    return token;
  })();
  try { return await _bisonMintInFlight[tid]; }
  finally { delete _bisonMintInFlight[tid]; }
}

// ── "Fresh start" (Bison-era) date floor ─────────────────────────────────
// When the dashboard is switched to a fresh start, we record the cutover date
// and, by default, clamp every stats date range so nothing before it shows —
// giving a clean Bison-era view without deleting any PlusVibe-era data. A global
// "Show historical" toggle removes the clamp. Both live in app_settings, cached
// here and refreshed on change. MUST be module-scope (not inside the if(db)
// block) — hydrateFreshStart() is called from the startup path in a different
// scope, and a function declared inside a block isn't visible there.
let _freshStartDate = null;   // 'YYYY-MM-DD' cutover, or null = never enabled
let _showHistorical = false;  // true = ignore the clamp, show everything
async function hydrateFreshStart(pgdb) {
  try {
    _freshStartDate = (await pgdb.getSetting('fresh_start_date', null)) || null;
    _showHistorical = (await pgdb.getSetting('show_historical', false)) === true;
  } catch (e) { console.warn('[fresh-start] hydrate failed:', e.message); }
}
// Clamp a requested start date up to the fresh-start floor (unless historical
// is on or no floor is set). Always returns a 'YYYY-MM-DD' string.
//
// SCOPE — IMPORTANT: this is ONLY for sequencer stats/performance views (sent,
// replies, bounces, warmup, campaigns). It MUST NOT be applied to finance,
// revenue, or commission endpoints — revenue is reported across ALL time
// regardless of the cutover. If you add a stats route, clamp its start param;
// if you add a finance/revenue route, do NOT.
function clampStartDate(startStr) {
  if (_showHistorical || !_freshStartDate || !startStr) return startStr;
  return startStr < _freshStartDate ? _freshStartDate : startStr;
}
const BISON_BASE = (process.env.BISON_API_URL || 'https://send.ottaly.co.uk').replace(/\/$/, '');
let _bisonWsId = null;

// Bison's API is STATEFUL: switch-workspace changes the active workspace for the
// whole token, and Bison treats that as one logged-in session ("only one login
// at a time"). Our background crons loop over every workspace, so without
// serialization two switch+fetch sequences can interleave on the same token —
// one fetch lands on the wrong workspace, and the rapid switching trips Bison's
// session guard. _bisonGate chains every token operation so each switch+fetch
// pair runs atomically, start to finish, against the shared key.
let _bisonGate = Promise.resolve();
function withBisonLock(fn) {
  const run = _bisonGate.then(fn, fn); // run regardless of prior outcome
  // Keep the chain alive even if this op throws — swallow here, caller still sees the real result/error.
  _bisonGate = run.then(() => {}, () => {});
  return run;
}

// Module-scope Bison helper. The existing bisonSwitch/bisonFetch are scoped to
// the if(db) block and aren't reachable from the /api/bison/* routes, so these
// routes use this self-contained version. Always switches workspace when wsId
// is given (POST /api/workspaces/v1.1/switch-workspace { workspace_id }).
// Low-level switch+request WITHOUT taking _bisonGate. Callers that need several
// requests to run atomically against ONE active workspace (e.g. a GET-then-POST
// sequence that must not have another workspace switch interleave) wrap multiple
// _bisonRaw calls in a single withBisonLock. Most callers should use bisonReq.
async function _bisonRaw(path, opts = {}) {
  // The bearer for THIS request. Defaults to the super-admin key; if the target
  // workspace has its own per-workspace token, we use that instead and skip the
  // stateful switch-workspace call entirely (see _bisonWsTokens above) — that is
  // what stops cron traffic from kicking a human's Bison web-UI session.
  let bearer = getBisonKey();
  if (opts.wsId) {
    // Resolve PV workspace_id -> Bison team_id, and REFUSE to switch on anything
    // that isn't a clean integer team_id. Passing a raw PV Mongo-string here did
    // team_id: Number(...) = NaN, which Bison ignores — so the request ran against
    // whatever workspace was last active. That is how a "Lending Team" push landed
    // in Bruud. Failing loudly is the only safe behaviour for a workspace switch.
    const teamId = resolveBisonTeamId(opts.wsId);
    if (!teamId || !/^\d+$/.test(String(teamId))) {
      throw new Error('Bison switch refused: workspace "' + opts.wsId + '" does not resolve to a Bison team_id (add it to BISON_TEAMS).');
    }
    let wsToken = getBisonWsToken(teamId);
    if (!wsToken) {
      // POLICY: per-workspace work uses the workspace's OWN token; the super-admin
      // key is for minting only. If this team has no token yet, MINT one on demand
      // (super-admin, allowed) and use it — instead of switching the super-admin
      // token to this workspace for the data call. Self-heals into the per-workspace
      // model. If minting fails (e.g. no super-admin key), fall back to the stateful
      // switch so the request can still complete rather than hard-failing the page.
      try {
        wsToken = await mintBisonWsToken(teamId);
      } catch (e) {
        console.warn('[bison] on-demand mint for team ' + teamId + ' failed, falling back to switch:', e.message);
      }
    }
    if (wsToken) {
      // Per-workspace token: scoped to this team, so NO switch needed. We don't
      // touch _bisonWsId — the super-admin token's active workspace is unaffected.
      bearer = wsToken;
    } else if (_bisonWsId !== String(teamId)) {
      // Last-resort fallback (no token + mint failed): switch the super-admin token.
      const sw = await fetch(BISON_BASE + '/api/workspaces/v1.1/switch-workspace', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getBisonKey(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: Number(teamId) }),
        signal: AbortSignal.timeout(10000),
      });
      if (!sw.ok) throw new Error('Bison switch-workspace ' + teamId + ' -> ' + sw.status);
      _bisonWsId = String(teamId);
    }
  }
  const url = new URL(BISON_BASE + path);
  if (opts.params) for (const [k, v] of Object.entries(opts.params)) { if (v != null) url.searchParams.set(k, String(v)); }
  const init = {
    method: opts.method || 'GET',
    headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20000),
  };
  if (opts.body) init.body = JSON.stringify(opts.body);
  const r = await fetch(url.toString(), init);
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
  if (!r.ok) throw new Error('Bison ' + path + ' -> ' + r.status + ': ' + txt.slice(0, 200));
  return data;
}

async function bisonReq(path, opts = {}) {
  // Serialize the whole switch+fetch sequence on the shared token (see _bisonGate).
  return withBisonLock(() => _bisonRaw(path, opts));
}

// Bison replacement for the old PlusVibe `/lead/workspace-leads` endpoint.
// PlusVibe filtered leads by a `label` string; Bison filters by
// filters[lead_campaign_status] (e.g. 'replied'/'interested') on /api/leads and
// returns { data: [...] } with page/per_page paging. Returns a plain array of
// leads (already unwrapped) so callers can iterate like the old PV batches.
// The `wsId` here is the canonical PV workspace_id used elsewhere; map it to the
// Bison team_id first. A PV label is loosely mapped to a Bison campaign-status
// filter; unknown labels fall back to no filter (all leads).
const PV_LABEL_TO_BISON_STATUS = {
  REPLIED: 'replied', INTERESTED: 'interested', INFO: 'replied',
  NOT_INTERESTED: 'not_interested', NEGATIVE_REPLY: 'not_interested',
  LEAD: 'interested', WEAK_LEAD: 'interested', AWAITING_REPLY: 'replied',
};
async function bisonWorkspaceLeads(wsId, opts = {}) {
  const team = BISON_TEAMS.find(t => t.pv === String(wsId));
  const teamId = team ? team.team_id : String(wsId);
  const params = { page: opts.page || 1, per_page: opts.perPage || 100 };
  if (opts.label) {
    const status = PV_LABEL_TO_BISON_STATUS[String(opts.label).toUpperCase()];
    if (status) params['filters[lead_campaign_status]'] = status;
  }
  const raw = await bisonReq('/api/leads', { wsId: teamId, params });
  const list = Array.isArray(raw) ? raw : (raw?.data || []);
  // Normalise Bison lead fields to the keys downstream code reads (it already
  // checks `company`/`title` variants, but make email/_id reliable).
  return list.map(l => Object.assign({}, l, {
    _id: l.id != null ? String(l.id) : (l._id || null),
    email: l.email || l.email_address || null,
  }));
}

// List ALL sender emails (mailboxes) for one Bison workspace, paginated.
// IMPORTANT: Bison ignores per_page and returns a fixed ~15 rows/page, so we MUST
// page until an empty page (or a repeated page) — a single call only yields ~15.
// `wsId` is the Bison team_id. Returns the raw account objects.
async function bisonListSenderEmails(wsId) {
  const out = [];
  let prevSig = '';
  for (let page = 1; page <= 300; page++) {
    const resp = await bisonReq('/api/sender-emails', { wsId, params: { per_page: 200, page } });
    const list = Array.isArray(resp) ? resp : (resp?.data ?? []);
    if (!list.length) break;
    const sig = list.map(a => a.id ?? a.email ?? '').join(',');
    if (sig === prevSig) break;
    prevSig = sig;
    out.push(...list);
  }
  return out;
}

// Ensure a Bison workspace has every custom variable in `names` BEFORE pushing
// leads — Bison 422s ("You do not have a custom variable named X") if a lead
// references one that doesn't exist. Best-effort: a create failure is logged, not
// thrown. Used by every push path (incl. verify-and-push). wsId = Bison team id.
// Standard custom vars every Bison lead payload may reference. Seeding ALL of
// them (not just the ones present in the current batch) means a workspace is
// fully prepared once, so a later batch that happens to include e.g. `city`
// when an earlier one didn't can't 422. Keep in sync with the cv.push() names
// in the push payload builders.
const BISON_STANDARD_CUSTOM_VARS = [
  'phone_number', 'city', 'state', 'country', 'industry',
  'linkedin_person_url', 'linkedin_company_url', 'company_website',
  'department', 'address_line',
];

// Ensure a Bison workspace has every custom variable in `names` BEFORE pushing
// leads — Bison 422s ("You do not have a custom variable named X") if a lead
// references one that doesn't exist.
//
// CRITICAL: the whole GET-then-create sequence runs inside a SINGLE withBisonLock
// via _bisonRaw, so no other workspace switch can interleave between listing and
// creating (which previously created the var in the wrong workspace and left the
// 422 to surface on the lead push). Creation is verified by re-listing; a var
// that still isn't present THROWS so the caller can react rather than push blind.
async function ensureBisonCustomVars(wsId, names) {
  const needed = [...new Set([...BISON_STANDARD_CUSTOM_VARS, ...[...names].filter(Boolean)])];
  if (!needed.length) return;
  return withBisonLock(async () => {
    const listResp = await _bisonRaw('/api/custom-variables', { wsId });
    const listArr = Array.isArray(listResp) ? listResp : (listResp?.data ?? []);
    let existing = new Set(listArr.map(v => (v.name || v.slug || '').toLowerCase()));
    const toCreate = needed.filter(n => !existing.has(String(n).toLowerCase()));
    if (!toCreate.length) return;
    for (const name of toCreate) {
      try {
        await _bisonRaw('/api/custom-variables', { wsId, method: 'POST', body: { name } });
      } catch (e) {
        // "already been taken" means a concurrent run created it — that's fine.
        if (!/already been taken/i.test(e.message)) {
          console.warn(`[bison] create custom var "${name}" failed:`, e.message);
        }
      }
    }
    // Verify: re-list and confirm everything we needed now exists.
    const verifyResp = await _bisonRaw('/api/custom-variables', { wsId });
    const verifyArr = Array.isArray(verifyResp) ? verifyResp : (verifyResp?.data ?? []);
    existing = new Set(verifyArr.map(v => (v.name || v.slug || '').toLowerCase()));
    const stillMissing = needed.filter(n => !existing.has(String(n).toLowerCase()));
    if (stillMissing.length) {
      throw new Error('Bison custom vars could not be created in ws ' + wsId + ': ' + stillMissing.join(', '));
    }
  });
}

// Known PlusVibe workspace_id → Bison team_id map (Bison's /api/workspaces only
// returns the token user's OWN teams, not all client teams, so we map clients
// explicitly). Update here when a client is added/migrated to Bison.
// pv = the client's workspace_id key in the SQLite `clients` table (a legacy
// PlusVibe-style id; we are Bison-only now, it's just the internal client key).
// team_id = the Bison workspace this client maps to. Verified 2026-06-15 by
// cross-referencing the live clients table against Bison /api/workspaces.
const BISON_TEAMS = [
  // Bison-only workspace with no client record — keyed by its own team_id (the
  // resolver accepts a bare team_id as its own pv). Needed so mailbox/stats listing
  // (now sourced from this map, not a super-admin API call) includes it. ByboDigital
  // holds ~50 SMTP (Winnr) mailboxes that were dropping from the count.
  // (Team 2 "Jesse's Team" is personal/test — deliberately NOT included.)
  { team_id: '6',  name: 'ByboDigital',         pv: '6' },
  { team_id: '3',  name: 'Ottaly',              pv: '690ee665bcb253de4fb44538' },
  { team_id: '4',  name: 'AccrueAccounting',    pv: '6912ddfef9582848982b9a62' },
  { team_id: '5',  name: 'ButterflyEco',        pv: '69a9db307af7ef2854f57637' },
  { team_id: '7',  name: 'Shire',               pv: '6a15cdb4e4f1d4a2e6d6062a' }, // ShireRecoveries
  { team_id: '8',  name: 'MDH',                 pv: '6a15cda912293dbfe5eab6c3' },
  { team_id: '9',  name: 'Meades',              pv: '6a108e72b20829cbce44fa6c' }, // Meades Group
  { team_id: '10', name: 'Lending Team',        pv: '6a108e69cfbd57f86dbea524' },
  { team_id: '11', name: 'Bubble',              pv: '6a0e29d0d004be93be3f33f2' },
  { team_id: '12', name: 'MagnaMoney',          pv: '6a0cc49a4a80688441614dfb' },
  { team_id: '13', name: 'Bruud',               pv: '69ffaf6904ca7138af16013a' },
  { team_id: '14', name: 'GXI Furniture',       pv: '69c43d1e07bf312ff0026643' }, // clients row = AuraaDesign (rename to GXI Furniture)
  { team_id: '15', name: 'GXI',                 pv: '69c43d1407bf312ff0026642' },
  { team_id: '16', name: 'LVM',                 pv: '6a19a054d42a3f59aac110d6' },
  { team_id: '17', name: 'Indigo',              pv: '695259c3d6154e27d164bcf7' },
  { team_id: '18', name: 'Enviro',              pv: '699714b02f0830a7148fcf3e' },
  { team_id: '19', name: 'PPC',                 pv: '695259dc8de377db7577dc45' },
  { team_id: '20', name: 'Jumping Spider',      pv: '697e20f02db8460f8ba68792' },
  { team_id: '21', name: 'HydrationCompany',    pv: '69525a0eceae00718efdaeaa' },
  { team_id: '22', name: 'Animo',               pv: '69a686632f5aaca7d9602c1f' },
  { team_id: '23', name: 'ButterflyEco SOP',    pv: '6a1d40b3bb80380c1be750c6' }, // also labelled "ButterflyEco 2" in clients
  { team_id: '24', name: 'Josh - Commercial Flooring', pv: '6989ac90bb085fcd05167fc9' },
];

// Resolve an incoming workspace identifier to a Bison team_id. The dashboard
// passes the client's PlusVibe workspace_id (a Mongo-style string), but some
// callers already have the integer team_id. Accept EITHER:
//   - matches a BISON_TEAMS.pv  -> return that team_id
//   - already a BISON_TEAMS.team_id -> return as-is
//   - looks like a plain integer (a team_id we don't have mapped) -> return as-is
// Returns null when it can't be resolved, so callers can fail loudly instead of
// switching to team_id NaN (which silently leaves Bison on the wrong workspace —
// the cause of "create works but existing campaigns don't load" and pushes
// landing in the wrong client).
function resolveBisonTeamId(wsId) {
  const s = String(wsId || '').trim();
  if (!s) return null;
  const byPv = BISON_TEAMS.find(t => t.pv === s);
  if (byPv) return byPv.team_id;
  if (BISON_TEAMS.some(t => t.team_id === s)) return s;
  if (/^\d+$/.test(s)) return s; // bare integer team_id not in the map
  return null;                   // PV id with no mapping — unresolvable
}

// Resolve a client to the CANONICAL workspace_id that the performance cache is
// keyed by (BISON_TEAMS[].pv — the id the warm loop uses). A client's stored
// clients.workspace_id usually already equals its pv, but some rows were created
// manually/by webhook with an id that doesn't match byte-for-byte (e.g. Bubble),
// so the Stats page read missed the cache and the client showed 0 sent/replies →
// got filtered out entirely. Map via id (pv or team_id) first, then by NAME, so a
// mismatched id still lands on the right cache bucket. Falls back to the raw id.
function canonicalWorkspaceId(wsId, name) {
  const s = String(wsId || '').trim();
  const byId = BISON_TEAMS.find(t => t.pv === s || t.team_id === s);
  if (byId) return byId.pv;
  const n = String(name || '').trim().toLowerCase();
  if (n) {
    const byName = BISON_TEAMS.find(t => t.name.toLowerCase() === n);
    if (byName) return byName.pv;
  }
  return s;
}

// List the Bison workspaces WITHOUT calling the API. Per policy, the super-admin
// key is reserved for token minting only — it must NOT be used for routine
// listing. We already hold every workspace in BISON_TEAMS, so return that in the
// Bison /api/workspaces shape ({ data: [{ id, name }] }) so existing callers
// work unchanged. Add new clients to BISON_TEAMS, not via a super-admin fetch.
function listBisonWorkspaces() {
  return { data: BISON_TEAMS.map(t => ({ id: t.team_id, name: t.name, pv_workspace_id: t.pv })) };
}

const ANTHROPIC_API_KEY      = process.env.ANTHROPIC_API_KEY      || '';
const SLACK_SIGNING_SECRET   = process.env.SLACK_SIGNING_SECRET   || '';
const ANTHROPIC_MODEL        = process.env.ANTHROPIC_MODEL        || 'claude-haiku-4-5-20251001';
const NO2BOUNCE_KEY          = process.env.NO2BOUNCE_KEY          || 'ab55c5f1325ad50bf92850e030c16caa';
const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY      || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET  || '';
const APP_URL                = process.env.APP_URL                || 'http://localhost:3000';
const NONLEAD_WEBHOOK_URL    = 'https://n8n1-n8n.xuobbb.easypanel.host/webhook/ottaly-nonlead';
const AUTOMATION_RUN_DIR     = path.resolve(process.env.AUTOMATION_RUN_DIR || 'automation-runs');
const AUTOMATION_NOVNC_PORT  = process.env.AUTOMATION_NOVNC_PORT || '6080';
const EMAIL_FINDER_URL       = process.env.EMAIL_FINDER_URL || '';
const EMAIL_FINDER_INTERNAL_PORT = process.env.EMAIL_FINDER_INTERNAL_PORT || '5055';
const EV2_INTERNAL_PORT      = process.env.EV2_INTERNAL_PORT || '5056';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// ── Database ──────────────────────────────────────────────
let db = null;
if (Database) {
  const DB_PATH = process.env.DB_PATH || 'ottaly.db';
  const DB_DIR  = path.dirname(DB_PATH);
  if (DB_DIR !== '.') { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch {} }
  try {
    db = new Database(DB_PATH);
  } catch (err) {
    console.warn('[SQLite] Failed to instantiate database:', err.message);
    Database = null;
  }
}

if (db) {
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    username           TEXT    UNIQUE NOT NULL,
    password_hash      TEXT    NOT NULL,
    workspace_id       TEXT    NOT NULL,
    workspace_name     TEXT    NOT NULL,
    plan_leads         INTEGER DEFAULT 0,
    price_per_lead     REAL    DEFAULT 0,
    stripe_customer_id TEXT,
    created_at         TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS leads (
    id           TEXT    PRIMARY KEY,
    workspace_id TEXT    NOT NULL,
    data         TEXT    NOT NULL,
    closed_value REAL,
    status       TEXT    DEFAULT 'active',
    received_at  TEXT    DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_leads_ws ON leads(workspace_id);
  CREATE TABLE IF NOT EXISTS nonlead_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id      TEXT    NOT NULL,
    client_id    INTEGER NOT NULL,
    workspace_id TEXT    NOT NULL,
    reason       TEXT    NOT NULL,
    status       TEXT    DEFAULT 'pending',
    created_at   TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id         INTEGER NOT NULL,
    leads_purchased   INTEGER NOT NULL,
    amount_paid       INTEGER NOT NULL,
    stripe_session_id TEXT,
    created_at        TEXT    DEFAULT (datetime('now'))
  );
`);

// Manager accounts
db.exec(`CREATE TABLE IF NOT EXISTS managers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now'))
)`);

// Non-lead overrides (keyed by email — persists across restarts, survives cache rebuilds)
db.exec(`CREATE TABLE IF NOT EXISTS nonlead_overrides (
  email      TEXT PRIMARY KEY,
  reason     TEXT DEFAULT '',
  marked_at  TEXT DEFAULT (datetime('now')),
  active     INTEGER DEFAULT 1
)`);

db.exec(`CREATE TABLE IF NOT EXISTS manager_commission_payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_name  TEXT NOT NULL,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  status        TEXT DEFAULT 'unpaid',
  payslip_name  TEXT DEFAULT '',
  payslip_type  TEXT DEFAULT '',
  payslip_data  TEXT DEFAULT '',
  paid_at       TEXT DEFAULT NULL,
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(manager_name, period_start, period_end)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS manager_commission_adjustments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  manager_name  TEXT NOT NULL,
  label         TEXT NOT NULL,
  amount        REAL DEFAULT 0,
  active        INTEGER DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS revenue_lead_first_seen (
  lead_key      TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  email         TEXT DEFAULT '',
  first_seen    TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now'))
)`);


db.exec(`CREATE TABLE IF NOT EXISTS app_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
)`);

const revenueDateMigration = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('revenue_first_seen_uses_modified_at');
if (!revenueDateMigration) {
  db.prepare('DELETE FROM revenue_lead_first_seen').run();
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run('revenue_first_seen_uses_modified_at', '1');
}

// Migrations for existing deployments
for (const sql of [
  `ALTER TABLE clients ADD COLUMN plan_leads INTEGER DEFAULT 0`,
  `ALTER TABLE clients ADD COLUMN price_per_lead REAL DEFAULT 0`,
  `ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT`,
  `ALTER TABLE clients ADD COLUMN contact_name TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN contact_email TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN contact_phone TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN website TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN notes TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN client_status TEXT DEFAULT 'active'`,
  `ALTER TABLE clients ADD COLUMN restart_date TEXT DEFAULT NULL`,
  `ALTER TABLE clients ADD COLUMN campaign_manager TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN commission_rate REAL DEFAULT 15`,
  `ALTER TABLE clients ADD COLUMN manager_start_date TEXT DEFAULT NULL`,
  // Monthly lead target — drives "behind pace" detection in the Client
  // Health view. 0 means "no target set" (skip pace scoring).
  `ALTER TABLE clients ADD COLUMN lead_target_monthly INTEGER DEFAULT 0`,
  `ALTER TABLE clients ADD COLUMN campaign_manager_2 TEXT DEFAULT ''`,
  `ALTER TABLE managers ADD COLUMN commission_rate REAL DEFAULT 15`,
  `ALTER TABLE managers ADD COLUMN base_salary REAL DEFAULT 0`,
  `ALTER TABLE leads ADD COLUMN closed_value REAL`,
  `ALTER TABLE leads ADD COLUMN status TEXT DEFAULT 'active'`,
  `ALTER TABLE leads ADD COLUMN received_at TEXT`,
]) { try { db.exec(sql); } catch {} }

// One-time data fix: the client at workspace_id 69c43d1e... is GXI Furniture
// (Bison team 14), historically labelled "AuraaDesign". Rename everywhere so the
// dropdown and reports show the correct name. Idempotent.
try {
  db.prepare(`UPDATE clients SET workspace_name = 'GXI Furniture'
              WHERE workspace_id = '69c43d1e07bf312ff0026643' AND workspace_name = 'AuraaDesign'`).run();
} catch (e) { console.warn('[migrate] AuraaDesign→GXI Furniture rename failed:', e.message); }

// CM workload — junction table for client↔manager assignments with per-assignment commission rate
db.exec(`CREATE TABLE IF NOT EXISTS client_managers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  client_workspace_id TEXT NOT NULL,
  manager_name        TEXT NOT NULL,
  commission_rate     REAL DEFAULT 0,
  assigned_at         TEXT DEFAULT (datetime('now')),
  UNIQUE(client_workspace_id, manager_name)
)`);

// Backfill client_managers from existing campaign_manager / campaign_manager_2 columns
try {
  const clients = db.prepare('SELECT workspace_id, campaign_manager, campaign_manager_2, commission_rate FROM clients').all();
  const insert  = db.prepare(`INSERT OR IGNORE INTO client_managers (client_workspace_id, manager_name, commission_rate) VALUES (?, ?, ?)`);
  const backfill = db.transaction(() => {
    for (const c of clients) {
      if (c.campaign_manager?.trim())   insert.run(c.workspace_id, c.campaign_manager.trim(),   c.commission_rate || 0);
      if (c.campaign_manager_2?.trim()) insert.run(c.workspace_id, c.campaign_manager_2.trim(), c.commission_rate || 0);
    }
  });
  backfill();
} catch (e) { console.warn('[workload] backfill error:', e.message); }

// Backfill any leads that arrived before received_at column existed
db.exec(`UPDATE leads SET received_at = datetime('now') WHERE received_at IS NULL`);

// ── Client targeting config (stored in SQLite for fast access) ──────────
db.exec(`CREATE TABLE IF NOT EXISTS client_verticals (
  workspace_id          TEXT PRIMARY KEY,
  workspace_name        TEXT,
  vertical              TEXT,
  exclude_remote        INTEGER DEFAULT 0,
  require_owns_building INTEGER DEFAULT 0,
  snooze_months         INTEGER DEFAULT 6,
  notes                 TEXT,
  updated_at            TEXT DEFAULT (datetime('now'))
)`);
try { db.exec(`ALTER TABLE client_verticals ADD COLUMN exclude_remote INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE client_verticals ADD COLUMN require_owns_building INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE client_verticals ADD COLUMN snooze_months INTEGER DEFAULT 6`); } catch {}
try { db.exec(`ALTER TABLE client_verticals ADD COLUMN notes TEXT`); } catch {}
// Master exclusion lists — applied automatically whenever this client is
// the active "Filter for Client" target on the contacts page. Comma-
// separated values; merged with any user-typed excludes server-side so
// operators can't accidentally bypass them.
try { db.exec(`ALTER TABLE client_verticals ADD COLUMN excluded_industries    TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE client_verticals ADD COLUMN excluded_company_sizes TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE client_verticals ADD COLUMN excluded_keywords      TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE client_verticals ADD COLUMN excluded_counties      TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE client_verticals ADD COLUMN excluded_cities        TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE client_verticals ADD COLUMN excluded_job_titles    TEXT DEFAULT ''`); } catch {}

// ── Webhook event store (SQLite — survives restarts) ─────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS webhook_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT DEFAULT 'plusvibe',
  event_type  TEXT,
  email       TEXT,
  payload     TEXT,
  processed   INTEGER DEFAULT 0,
  processed_at TEXT,
  error       TEXT,
  received_at TEXT DEFAULT (datetime('now'))
)`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_unprocessed ON webhook_events(processed) WHERE processed = 0`); } catch {}

// ── Email Verify 2.0 proxy table ─────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS ev2_proxies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  host        TEXT NOT NULL,
  port        INTEGER NOT NULL,
  username    TEXT DEFAULT '',
  password    TEXT DEFAULT '',
  label       TEXT DEFAULT '',
  status      TEXT DEFAULT 'untested',
  tested_at   TEXT,
  added_at    TEXT DEFAULT (datetime('now')),
  use_count   INTEGER DEFAULT 0,
  last_used   TEXT
)`);
// Add columns if upgrading from old schema
try { db.exec(`ALTER TABLE ev2_proxies ADD COLUMN use_count INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE ev2_proxies ADD COLUMN last_used TEXT`); } catch {}


// Auto-reactivate clients whose restart_date has passed
function checkClientReactivations() {
  const today = new Date().toISOString().split('T')[0];
  const changed = db.prepare(`
    UPDATE clients SET client_status='active', restart_date=NULL
    WHERE client_status='inactive' AND restart_date IS NOT NULL AND restart_date <= ?
  `).run(today);
  if (changed.changes > 0) console.log(`[clients] Auto-reactivated ${changed.changes} client(s)`);
}
checkClientReactivations();
setInterval(checkClientReactivations, 60 * 60 * 1000); // check hourly

// ── Client seed — prices, campaign managers & commission rates ──
const CLIENT_SEED = [
  { workspace_id: '690ee665bcb253de4fb44538', workspace_name: 'Ottaly',                     price_per_lead: 1,      campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '6912ddfef9582848982b9a62', workspace_name: 'AccrueAccounting',            price_per_lead: 72.99,  campaign_manager: 'Joey', commission_rate: 15 },
  { workspace_id: '691ed9eaa1b5035dd42b4d86', workspace_name: 'Volancy',                    price_per_lead: 0,      campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '6932e1e2d3beeb70040857e7', workspace_name: 'AIVI',                       price_per_lead: 0,      campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '693fc9d9fd3453ffb933c88c', workspace_name: 'FleetSauce',                 price_per_lead: 0,      campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '695259b0d1677bc04d5a3aa8', workspace_name: 'Stribe',                     price_per_lead: 0,      campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '695259c3d6154e27d164bcf7', workspace_name: 'Indigo',                     price_per_lead: 79.99,  campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '695259dc8de377db7577dc45', workspace_name: 'PPC',                        price_per_lead: 99.99,  campaign_manager: 'Joey', commission_rate: 15 },
  { workspace_id: '695259ea8de377db7577dc46', workspace_name: 'JMC Accountants',            price_per_lead: 0,      campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '69525a0eceae00718efdaeaa', workspace_name: 'HydrationCompany',           price_per_lead: 72.99,  campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '6964c76a36e2bd2af31c7adf', workspace_name: 'V4One',                      price_per_lead: 0,      campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '6964ec1b2364418165378b13', workspace_name: 'Rural & Country',            price_per_lead: 0,      campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '6964ec4f693ae16dcb15b9f7', workspace_name: 'TangerineTax',               price_per_lead: 0,      campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '6967e4b912a9eb99bbafe356', workspace_name: "Tristan's Workspace",        price_per_lead: 0,      campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '696e3c1682c0ae8e5357c552', workspace_name: 'FAIT',                       price_per_lead: 0,      campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '697e20f02db8460f8ba68792', workspace_name: 'Jumping Spider',             price_per_lead: 100,    campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '6989ac90bb085fcd05167fc9', workspace_name: 'Josh - Commercial Flooring', price_per_lead: 189.99, campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '699714b02f0830a7148fcf3e', workspace_name: 'Enviro',                     price_per_lead: 89,     campaign_manager: 'Joey', commission_rate: 15 },
  { workspace_id: '69a686632f5aaca7d9602c1f', workspace_name: 'Animo',                      price_per_lead: 195,    campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '69a9db287af7ef2854f57636', workspace_name: 'GGRS',                       price_per_lead: 178,    campaign_manager: 'Joey', commission_rate: 15 },
  { workspace_id: '69a9db307af7ef2854f57637', workspace_name: 'ButterflyEco',               price_per_lead: 205,    campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '69c43d1407bf312ff0026642', workspace_name: 'GXI',                        price_per_lead: 169,    campaign_manager: 'Joey', commission_rate: 15 },
  { workspace_id: '69c43d1e07bf312ff0026643', workspace_name: 'GXI Furniture',              price_per_lead: 100,    campaign_manager: '',     commission_rate: 15 },
  { workspace_id: '69ce40f616a9cc965746b1a6', workspace_name: 'Ottaly Test Account',        price_per_lead: 0,      campaign_manager: '',     commission_rate: 15 },
];

const upsertClient = db.prepare(`
  INSERT INTO clients (username, password_hash, workspace_id, workspace_name, price_per_lead, campaign_manager, commission_rate)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET
    price_per_lead   = excluded.price_per_lead,
    campaign_manager = excluded.campaign_manager,
    commission_rate  = excluded.commission_rate,
    workspace_id     = excluded.workspace_id,
    workspace_name   = excluded.workspace_name
`);
for (const s of CLIENT_SEED) {
  const existing = db.prepare('SELECT id, price_per_lead FROM clients WHERE workspace_id = ?').get(s.workspace_id);
  if (existing) {
    const newPrice = (s.price_per_lead > 0 && (existing.price_per_lead || 0) === 0)
      ? s.price_per_lead : existing.price_per_lead;
    // Only set campaign_manager from seed if DB is currently blank (don't overwrite manual edits)
    const cur = db.prepare('SELECT campaign_manager, commission_rate FROM clients WHERE workspace_id=?').get(s.workspace_id);
    const mgr  = (cur?.campaign_manager || '') === '' && s.campaign_manager ? s.campaign_manager : (cur?.campaign_manager || '');
    db.prepare(`UPDATE clients SET workspace_name=?, price_per_lead=?, campaign_manager=? WHERE workspace_id=?`)
      .run(s.workspace_name, newPrice, mgr, s.workspace_id);
  } else {
    const tempHash = bcrypt.hashSync('Ottaly2025!', 10);
    upsertClient.run(
      s.workspace_name.toLowerCase().replace(/\s+/g, '_'),
      tempHash, s.workspace_id, s.workspace_name, s.price_per_lead,
      s.campaign_manager || '', s.commission_rate || 15
    );
  }
}
}

// ── Stripe webhook — MUST be before express.json() ────────
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET)
    return res.status(503).json({ error: 'Stripe webhook not configured' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (event.type === 'checkout.session.completed' && db) {
    const s          = event.data.object;
    const clientId   = parseInt(s.metadata?.client_id);
    const leadsCount = parseInt(s.metadata?.leads_count);
    if (clientId && leadsCount) {
      db.prepare('UPDATE clients SET plan_leads = plan_leads + ? WHERE id = ?').run(leadsCount, clientId);
      db.prepare('INSERT INTO transactions (client_id, leads_purchased, amount_paid, stripe_session_id) VALUES (?,?,?,?)')
        .run(clientId, leadsCount, s.amount_total || 0, s.id);
    }
  }
  res.json({ received: true });
});

// ── Embedded Email Finder app ─────────────────────────────
let emailFinderProc = null;
function startEmailFinderApp() {
  if (process.env.EMAIL_FINDER_EMBEDDED === 'false') return;
  const finderServer = path.join(__dirname, 'email-finder-local', 'server.js');
  if (!fs.existsSync(finderServer)) return;
  emailFinderProc = spawn(process.execPath, [finderServer], {
    cwd: path.join(__dirname, 'email-finder-local'),
    env: {
      ...process.env,
      PORT: EMAIL_FINDER_INTERNAL_PORT,
      SMTP_TIMEOUT_MS: process.env.SMTP_TIMEOUT_MS || '10000',
      CHECK_DELAY_MS: process.env.CHECK_DELAY_MS || '0',
      MAX_CANDIDATES: process.env.MAX_CANDIDATES || '12',
      VERIFY_CANDIDATES: process.env.VERIFY_CANDIDATES || '12',
      ROW_CONCURRENCY: process.env.ROW_CONCURRENCY || '3',
      CANDIDATE_CONCURRENCY: process.env.CANDIDATE_CONCURRENCY || '2',
      SMTP_RETRIES: process.env.SMTP_RETRIES || '1',
      CHECK_CATCH_ALL: process.env.CHECK_CATCH_ALL || 'false',
      DEFAULT_VERIFIER: process.env.DEFAULT_VERIFIER || 'reacher',
      REACHER_URL: process.env.REACHER_URL || 'http://127.0.0.1:8080',
      REACHER_API_KEY: process.env.REACHER_API_KEY || '',
      REACHER_FROM_EMAIL: process.env.REACHER_FROM_EMAIL || '',
      REACHER_HELLO_NAME: process.env.REACHER_HELLO_NAME || '',
      REACHER_TIMEOUT_MS: process.env.REACHER_TIMEOUT_MS || '15000',
      REACHER_TEST_EMAIL: process.env.REACHER_TEST_EMAIL || 'jesse@ottaly.co.uk',
      REACHER_URL_2: process.env.REACHER_URL_2 || '',
      REACHER_API_KEY_2: process.env.REACHER_API_KEY_2 || '',
      REACHER_URL_2_DAILY_LIMIT: process.env.REACHER_URL_2_DAILY_LIMIT || '10000',
      PRIMARY_REACHER_CONCURRENCY: process.env.PRIMARY_REACHER_CONCURRENCY || '4',
      REACHER_RETRIES: process.env.REACHER_RETRIES || '1',
      MAX_CONTACTS: process.env.MAX_CONTACTS || '10000',
      // Email Verify 1.0 — proxy4smtp SOCKS5 (port 25 capable), NO Webshare
      EV2_PROXY_URL: '',
      SOCKS5_HOST: process.env.SOCKS5_HOST || 'r1.proxy4smtp.com',
      SOCKS5_PORT: process.env.SOCKS5_PORT || '1081',
      SOCKS5_USER: process.env.SOCKS5_USER || 'jesseottalycouk',
      SOCKS5_PASS: process.env.SOCKS5_PASS || 'myQEqtgdR6FZhwC5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  emailFinderProc.stdout.on('data', chunk => console.log(`[email-finder] ${chunk.toString().trim()}`));
  emailFinderProc.stderr.on('data', chunk => console.error(`[email-finder] ${chunk.toString().trim()}`));
  emailFinderProc.on('exit', code => {
    console.log(`[email-finder] exited with code ${code}`);
    emailFinderProc = null;
  });
}

startEmailFinderApp();

// ── Email Verify 2.0 — second instance (own stats, own port) ─
let ev2FinderProc = null;
function startEv2FinderApp() {
  if (process.env.EMAIL_FINDER_EMBEDDED === 'false') return;
  const finderServer = path.join(__dirname, 'email-finder-local', 'server.js');
  if (!fs.existsSync(finderServer)) return;
  const statsDir = process.env.DB_PATH ? path.dirname(path.resolve(process.env.DB_PATH)) : path.join(__dirname);
  ev2FinderProc = spawn(process.execPath, [finderServer], {
    cwd: path.join(__dirname, 'email-finder-local'),
    env: {
      ...process.env,
      PORT: EV2_INTERNAL_PORT,
      STATS_FILE: path.join(statsDir, 'ev2-verifier-stats.json'),
      DEFAULT_VERIFIER: 'reacher',
      ROW_CONCURRENCY: process.env.ROW_CONCURRENCY || '3',
      CANDIDATE_CONCURRENCY: '1',
      REACHER_URL: process.env.REACHER_URL || 'http://127.0.0.1:8080',
      REACHER_API_KEY: process.env.REACHER_API_KEY || '',
      REACHER_FROM_EMAIL: process.env.REACHER_FROM_EMAIL || '',
      REACHER_HELLO_NAME: process.env.REACHER_HELLO_NAME || '',
      REACHER_TIMEOUT_MS: process.env.REACHER_TIMEOUT_MS || '15000',
      MAX_CONTACTS: process.env.MAX_CONTACTS || '10000',
      PRIMARY_REACHER_CONCURRENCY: process.env.PRIMARY_REACHER_CONCURRENCY || '2',
      REACHER_RETRIES: process.env.REACHER_RETRIES || '1',
      // Use Webshare proxy pool — each Reacher call gets next proxy in rotation
      EV2_PROXY_URL: `http://127.0.0.1:${PORT}/api/ev2/active-proxy`,
      // Do NOT pass SOCKS5 vars — EV2 uses only Webshare proxies
      SOCKS5_HOST: '',
      SOCKS5_PORT: '',
      SOCKS5_USER: '',
      SOCKS5_PASS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ev2FinderProc.stdout.on('data', chunk => console.log(`[ev2-finder] ${chunk.toString().trim()}`));
  ev2FinderProc.stderr.on('data', chunk => console.error(`[ev2-finder] ${chunk.toString().trim()}`));
  ev2FinderProc.on('exit', code => {
    console.log(`[ev2-finder] exited with code ${code}`);
    ev2FinderProc = null;
  });
}

// EV2 disabled — only EV1 (proxy4smtp) is in use for push-verify
// startEv2FinderApp();

app.use('/email-verify2-tool', (req, res) => {
  const targetPath = req.originalUrl.replace(/^\/email-verify2-tool/, '') || '/';
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: Number(EV2_INTERNAL_PORT),
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${EV2_INTERNAL_PORT}` },
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => res.status(502).send('Email Verify 2.0 is starting. Refresh in a few seconds.'));
  req.pipe(proxyReq);
});

app.use('/email-finder-tool', (req, res) => {
  const targetPath = req.originalUrl.replace(/^\/email-finder-tool/, '') || '/';
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: Number(EMAIL_FINDER_INTERNAL_PORT),
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${EMAIL_FINDER_INTERNAL_PORT}` },
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    res.status(502).send('Email Finder is starting. Refresh in a few seconds.');
  });
  req.pipe(proxyReq);
});

// ── Sentry + security + performance middleware (must precede routes) ───────
// @sentry/node v8+: Express request/tracing handlers are automatic; only the
// error handler is wired explicitly (see Sentry.setupExpressErrorHandler below).
Sentry.init({
  dsn: process.env.SENTRY_DSN || '',
  environment: process.env.NODE_ENV || 'production',
  tracesSampleRate: 0.1,
});
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
// Rate-limit the API surface (stripe webhook excluded — it has its own verify).
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/stripe/webhook',
});
app.use('/api/', apiLimiter);

// ── Middleware ─────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ limit: '500mb', type: 'text/csv' })); // raw CSV uploads — no JSON overhead
// Claude-write permission gate. No-op unless the request carries x-claude-write:1
// (set only by the MCP server), so it never affects human operators.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.headers['x-claude-write'] !== '1') return next();
  return enforceClaudePerms(req, res, next);
});
app.use(express.static(path.join(__dirname), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.client = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired session' }); }
}

// ── Session helpers ───────────────────────────────────────
function getSessionCookie(req) {
  const raw = req.headers.cookie || '';
  const m   = raw.match(/(?:^|;\s*)ottaly_session=([^;]+)/);
  return m ? m[1] : null;
}

function decodeSession(req) {
  const token = getSessionCookie(req);
  if (!token) return null;
  try { return jwt.verify(token, SESSION_SECRET); } catch { return null; }
}

function setSessionCookie(res, payload) {
  const token = jwt.sign(payload, SESSION_SECRET, { expiresIn: '30d' });
  res.setHeader('Set-Cookie',
    `ottaly_session=${token}; HttpOnly; Path=/; Max-Age=${30*24*3600}; SameSite=Strict`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'ottaly_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
}

function requireAdmin(req, res, next) {
  // Claude (MCP) gets MANAGER-level access only — never admin-only routes. The
  // MCP server marks every call with x-claude-write:1, so admin-only endpoints
  // (finance, revenue, payslips, commission, managers, database, fresh-start…)
  // are refused for Claude even though it holds the admin key. This is the
  // authoritative wall; CLAUDE_FINANCE_BLOCK is belt-and-braces on top.
  if (req.headers['x-claude-write'] === '1') {
    return res.status(403).json({ error: 'This is an admin-only area. Claude has manager-level access only.', claudeBlocked: true });
  }
  const s = decodeSession(req);
  if (s?.role === 'admin') return next();
  // Legacy header fallback
  if (req.headers['x-admin-key'] === ADMIN_KEY) return next();
  // Legacy admin cookie fallback
  const raw = req.headers.cookie || '';
  const m   = raw.match(/(?:^|;\s*)ottaly_admin=([^;]+)/);
  if (m) { try { jwt.verify(m[1], JWT_SECRET + ADMIN_KEY); return next(); } catch {} }
  return res.status(401).json({ error: 'Unauthorized' });
}

function requireSession(req, res, next) {
  // Accepts admin OR manager session
  const s = decodeSession(req);
  if (s?.role === 'admin' || s?.role === 'manager') return next();
  if (req.headers['x-admin-key'] === ADMIN_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── Claude (MCP) write permissions ───────────────────────────────────
// Capability toggles, owned from the admin "Claude Access" panel and stored in
// app_settings under `claude_permissions`. The MCP write tools authenticate with
// the admin key like any operator, so we distinguish *Claude* calls by a marker
// header (x-claude-write) the MCP server sets. When that header is present, the
// write must map to an enabled capability or it's refused — this is how Jesse
// turns Claude's abilities on/off live, without a redeploy.
// Each capability maps to a set of (method, path-prefix) write routes. `risk` drives
// the UI badge; `group` clusters rows. System/auth/irreversible routes (login,
// stripe webhook, fresh-start, delete-database, pv-shutdown, managers, bison-key)
// are deliberately NOT represented here, so Claude can never be granted them.
const CLAUDE_CAPABILITIES = [
  // ── Campaigns & filters ──
  { id: 'campaign_filters', label: 'Campaign filters', group: 'Campaigns', risk: 'low', default: true,
    desc: 'Create and delete saved campaign filters.',
    methods: ['POST', 'DELETE'], prefixes: ['/api/campaign-filters'] },
  { id: 'campaign_create', label: 'Create campaigns', group: 'Campaigns', risk: 'med', default: false,
    desc: 'Create new Bison campaigns and push contacts into them.',
    methods: ['POST'], prefixes: ['/api/bison/create-campaign', '/api/bison/push-contacts', '/api/pv/push-contacts'] },
  { id: 'campaign_optimise', label: 'Apply campaign optimisations', group: 'Campaigns', risk: 'med', default: false,
    desc: 'Apply suggested optimisations to running campaigns.',
    methods: ['POST'], prefixes: ['/api/campaigns/apply-optimisation'] },

  // ── Mailboxes & domains ──
  { id: 'mailbox_tagging', label: 'Mailbox tagging', group: 'Mailboxes', risk: 'low', default: true,
    desc: 'Bulk-tag mailboxes by selection or by domain, and assign suppliers.',
    methods: ['POST'], prefixes: ['/api/mailboxes/bulk-tag', '/api/mailboxes/assign-suppliers'] },
  { id: 'mailbox_warmup', label: 'Mailbox warmup', group: 'Mailboxes', risk: 'med', default: false,
    desc: 'Enable / disable warmup on mailboxes.',
    methods: ['POST'], prefixes: ['/api/mailboxes/enable-warmup', '/api/warmup/enable', '/api/warmup/disable'] },
  { id: 'mailbox_billing', label: 'Mailbox billing edits', group: 'Mailboxes', risk: 'high', default: false,
    desc: 'Change mailbox billing rows and bulk-remove mailboxes.',
    methods: ['POST', 'PUT'], prefixes: ['/api/mailboxes/bulk-billing', '/api/mailboxes/bulk-remove', '/api/mailboxes/'] },
  { id: 'domains', label: 'Domain actions', group: 'Mailboxes', risk: 'med', default: false,
    desc: 'Check, refresh, restore or remove sending domains.',
    methods: ['POST', 'DELETE'], prefixes: ['/api/domains'] },

  // ── Leads ──
  { id: 'lead_status', label: 'Lead status & values', group: 'Leads', risk: 'med', default: false,
    desc: 'Mark leads / non-leads, set lead value, log replies.',
    methods: ['POST'], prefixes: ['/api/leads/', '/api/nonlead/'] },

  // ── Health & ops ──
  { id: 'health_actions', label: 'Health actions', group: 'Health & ops', risk: 'low', default: false,
    desc: 'Complete, dismiss or reopen health action items and copy alerts.',
    methods: ['POST'], prefixes: ['/api/health/actions', '/api/health/copy-alerts'] },
  { id: 'ops_refresh', label: 'Trigger refreshes', group: 'Health & ops', risk: 'low', default: false,
    desc: 'Kick off data refreshes (stats, metrics, mailboxes, health, audience).',
    methods: ['POST'], prefixes: ['/api/stats/refresh', '/api/metrics/refresh', '/api/mailboxes/refresh',
      '/api/health/refresh', '/api/audience/refresh', '/api/postmaster/refresh', '/api/warmup/refresh'] },
  { id: 'copy', label: 'Copy / templates', group: 'Health & ops', risk: 'med', default: false,
    desc: 'Refresh copy templates and manage suppressions.',
    methods: ['POST', 'DELETE'], prefixes: ['/api/copy/'] },

  // NOTE: revenue / finance / pricing / client-records capabilities are
  // intentionally absent. Money is walled off from Claude entirely (see
  // CLAUDE_FINANCE_BLOCK) — it can't read or write it, so there's nothing to toggle.
];
const CLAUDE_PERM_DEFAULTS = (() => {
  const o = { enabled: true };
  for (const c of CLAUDE_CAPABILITIES) o[c.id] = c.default;
  return o;
})();

async function getClaudePerms(pgdb) {
  if (!pgdb) return { ...CLAUDE_PERM_DEFAULTS };
  const saved = await pgdb.getSetting('claude_permissions', null);
  return saved ? { ...CLAUDE_PERM_DEFAULTS, ...saved } : { ...CLAUDE_PERM_DEFAULTS };
}

// Returns { ok } or { ok:false, reason } for a Claude-originated write.
function claudeWriteDecision(perms, method, path) {
  if (!perms.enabled) return { ok: false, reason: 'Claude write access is turned off (master switch).' };
  const cap = CLAUDE_CAPABILITIES.find(
    (c) => c.methods.includes(method) && c.prefixes.some((p) => path.startsWith(p))
  );
  if (!cap) return { ok: false, reason: `No Claude capability covers ${method} ${path}. Enable it or do it from the UI.` };
  if (!perms[cap.id]) return { ok: false, reason: `Capability "${cap.label}" is turned off for Claude.` };
  return { ok: true, capability: cap.id };
}

// Finance/revenue is OFF-LIMITS to Claude entirely — not readable, not writable,
// not even via the generic dashboard_get/dashboard_post escape hatches. Any path
// starting with one of these is refused for Claude-marked requests, regardless of
// method or capability toggles. (Combo-analysis is deliverability data, not money,
// so it stays readable.)
const CLAUDE_FINANCE_BLOCK = [
  '/api/revenue',
  '/api/finance',
  '/api/payslips',
  '/api/admin/payslips',
  '/api/workspace-prices',
  '/api/avg-lead-price',
  '/api/admin/commission',
  '/api/admin/default-commission',
];
function isClaudeFinancePath(path) {
  return CLAUDE_FINANCE_BLOCK.some((p) => path.startsWith(p));
}

// Gate for Claude-marked requests (x-claude-write:1, set by the MCP server on
// EVERY call). Finance/revenue is always refused — reads and writes alike. Other
// reads pass through; other writes must satisfy the capability toggles. Non-Claude
// operators are completely unaffected.
async function enforceClaudePerms(req, res, next) {
  if (req.headers['x-claude-write'] !== '1') return next();
  if (isClaudeFinancePath(req.path)) {
    return res.status(403).json({ error: 'Revenue & finance data are not accessible to Claude.', claudeBlocked: true });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return next(); // non-finance reads are fine
  try {
    const perms = await getClaudePerms(req.app.locals.pgDb);
    const decision = claudeWriteDecision(perms, req.method, req.path);
    if (!decision.ok) return res.status(403).json({ error: decision.reason, claudeBlocked: true });
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Claude permission check failed: ' + err.message });
  }
}

// ── Slack slash commands ──────────────────────────────────
const { verifySlackRequest, callClaude } = require('./slack-slash');

app.post('/api/slack/slash',
  express.raw({ type: 'application/x-www-form-urlencoded' }),
  async (req, res) => {
    const rawBody = req.body.toString()
    const params = new URLSearchParams(rawBody)
    const body = Object.fromEntries(params)

    console.log('[slack-slash] Received:', body.command, body.text)

    if (!verifySlackRequest(rawBody, req.headers)) {
      console.error('[slack-slash] Invalid signature')
      return res.status(401).send('Unauthorized')
    }

    const { text, user_id, response_url } = body
    if (!text) return res.json({ response_type: 'ephemeral', text: 'Usage: /agent <your question>' })

    res.json({ response_type: 'ephemeral', text: '_Thinking..._' })

    try {
      const reply = await callClaude(text)
      const payload = JSON.stringify({ response_type: 'in_channel', text: `<@${user_id}>: ${text}\n\n${reply}` })
      const url = new URL(response_url)
      const respReq = require('https').request({ hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } })
      respReq.write(payload)
      respReq.end()
    } catch (err) {
      console.error('[slack-slash] Error:', err.message)
    }
  }
)

// ── Auth endpoints ────────────────────────────────────────
app.get('/api/session', (req, res) => {
  const s = decodeSession(req);
  if (!s) {
    // Check legacy admin cookie
    const raw = req.headers.cookie || '';
    const m   = raw.match(/(?:^|;\s*)ottaly_admin=([^;]+)/);
    if (m) { try { jwt.verify(m[1], JWT_SECRET + ADMIN_KEY); return res.json({ ok: true, role: 'admin', name: 'Admin' }); } catch {} }
    return res.status(401).json({ ok: false });
  }
  // For managers include their commission_rate so commission.html can use
  // a single manager-level rate rather than reading per-client rates.
  if (s.role === 'manager' && db) {
    const mgr = db.prepare('SELECT commission_rate FROM managers WHERE LOWER(name)=LOWER(?)').get(s.name || '');
    return res.json({ ok: true, role: s.role, name: s.name || '', commission_rate: mgr?.commission_rate ?? 15 });
  }
  res.json({ ok: true, role: s.role, name: s.name || 'Admin' });
});

// Returns a manager's commission rate by name. Used by commission.html
// so admins can also view commissions (they don't get commission_rate in
// their own session since they're not managers).
app.get('/api/manager/rate', requireSession, (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const s = decodeSession(req);
  // Managers can only fetch their own rate; admins can fetch any manager's
  const name = s?.role === 'admin' ? (req.query.name || s?.name || '') : (s?.name || '');
  const mgr = db.prepare('SELECT commission_rate, base_salary FROM managers WHERE LOWER(name)=LOWER(?)').get(name.trim());
  res.json({ name, commission_rate: mgr?.commission_rate ?? 15, base_salary: mgr?.base_salary ?? 0 });
});

app.get('/api/email-finder/config', requireSession, (req, res) => {
  res.json({ url: EMAIL_FINDER_URL });
});

// Diagnostic: which one-shot migrations have been recorded as run, plus
// a sample of company_name values to spot-check cleaning state.
// Apollo account split export — filters contacts by company_region
app.get('/api/contacts/export', requireSession, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });

  const regions = (req.query.companyRegion || '').split(',').map(r => r.trim()).filter(Boolean);
  const offset  = parseInt(req.query.offset || '0', 10);
  const limit   = 50000; // 50k rows per file

  if (!regions.length) return res.status(400).json({ error: 'companyRegion required' });

  const placeholders = regions.map((_, i) => `$${i + 1}`).join(',');
  const countRes = await pgdb.query(
    `SELECT COUNT(*) AS n FROM contacts WHERE company_region = ANY(ARRAY[${placeholders}]::text[]) AND email IS NOT NULL`,
    regions
  );
  const total = parseInt(countRes.rows[0].n, 10);

  const params = [...regions, limit, offset];
  const { rows } = await pgdb.query(
    `SELECT email, first_name, last_name, company_name, company_domain, apollo_id
     FROM contacts
     WHERE company_region = ANY(ARRAY[${placeholders}]::text[]) AND email IS NOT NULL
     ORDER BY company_domain, email
     LIMIT $${regions.length + 1} OFFSET $${regions.length + 2}`,
    params
  );

  // Minimal upload: give Apollo just enough to identify the contact and company.
  // Phone, LinkedIn, title, industry, location are intentionally omitted so
  // Apollo fills them from its own live database (paid enrichment fields).
  const cols = ['First Name', 'Last Name', 'Email', 'Company Name', 'Website', 'Apollo Contact Id'];
  const esc  = v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`;
  const csv  = [cols.join(','), ...rows.map(r => [
    r.first_name, r.last_name, r.email, r.company_name, r.company_domain, r.apollo_id
  ].map(esc).join(','))].join('\n');

  const hasMore   = offset + rows.length < total;
  const nextOffset = offset + rows.length;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="export-${offset}.csv"`);
  res.setHeader('X-Has-More', hasMore ? 'true' : 'false');
  res.setHeader('X-Next-Offset', String(nextOffset));
  res.setHeader('X-Rows-In-File', String(rows.length));
  res.send(csv);
});

app.get('/api/admin/export-missing-enrichment', requireAdmin, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  const { rows } = await pgdb.query(`
    SELECT workspace_id, email, first_name, last_name, company_name, company_domain,
           job_title, industry, city, state, country, linkedin_url,
           num_employees, keywords
    FROM contacts
    WHERE (keywords IS NULL OR keywords = '')
       OR num_employees IS NULL
       OR (industry IS NULL OR industry = '')
       OR (city IS NULL OR city = '')
    ORDER BY workspace_id, company_domain
  `);
  const cols = ['workspace_id','email','first_name','last_name','company_name','company_domain','job_title','industry','city','state','country','linkedin_url','num_employees','keywords'];
  const escape = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => escape(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="missing_enrichment.csv"');
  res.send(csv);
});

// ── AI Enrichment helpers ─────────────────────────────────────────────────

// Haiku pricing per million tokens
const HAIKU_PRICE = { input: 0.80, output: 4.00, cache_write: 1.00, cache_read: 0.08 };

const CH_SIZE_MAP = {
  'micro-entity': 5, 'micro': 5,
  'small': 25,
  'medium': 150,
  'full': 500, 'group': 500,
  'total-exemption-small': 25, 'total-exemption-full': 500,
  'dormant': 1,
};

async function fetchCompaniesHouse(companyName) {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key || !companyName) return null;
  const auth = { 'Authorization': 'Basic ' + Buffer.from(key + ':').toString('base64') };
  const deadline = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('CH timeout')), ms));
  try {
    // Step 1: search for company number
    const q = encodeURIComponent(companyName.slice(0, 60));
    const sr = await Promise.race([
      fetch(`https://api.company-information.service.gov.uk/search/companies?q=${q}&items_per_page=1`, { headers: auth }),
      deadline(4000),
    ]);
    if (!sr.ok) return null;
    const sj = await sr.json();
    const item = sj?.items?.[0];
    if (!item?.company_number) return null;

    // Step 2: fetch full company profile
    const pr = await Promise.race([
      fetch(`https://api.company-information.service.gov.uk/company/${item.company_number}`, { headers: auth }),
      deadline(4000),
    ]);
    if (!pr.ok) return null;
    const p = await pr.json();

    const accountsType = p?.accounts?.last_accounts?.type || null;
    const num_employees = accountsType ? (CH_SIZE_MAP[accountsType] || null) : null;
    const addr = p?.registered_office_address;
    const city    = addr?.locality || addr?.address_line_2 || null;
    const country = addr?.country || 'United Kingdom';
    const sic     = p?.sic_codes?.[0] || item?.sic_codes?.[0] || null;

    const rawStatus = p?.company_status || null;
    const company_status = rawStatus ? (rawStatus === 'active' ? 'active' : 'not active') : null;

    // Fetch officer count in parallel
    const or = await Promise.race([
      fetch(`https://api.company-information.service.gov.uk/company/${item.company_number}/officers?items_per_page=1`, { headers: auth }).then(r => r.json()),
      deadline(4000),
    ]).catch(() => null);

    // Build full address string
    const addrParts = [addr?.premises, addr?.address_line_1, addr?.address_line_2, addr?.locality, addr?.region, addr?.postal_code, addr?.country].filter(Boolean);

    return {
      company_status,
      num_employees,
      city:    addr?.locality || null,
      country: addr?.country  || 'United Kingdom',
      sic,
      ch_company_number:    item.company_number,
      ch_company_type:      p?.type || null,
      ch_founded_year:      p?.date_of_creation ? parseInt(p.date_of_creation.slice(0,4), 10) : null,
      ch_postcode:          addr?.postal_code || null,
      ch_sic_codes:         (p?.sic_codes || []).join(',') || null,
      ch_jurisdiction:      p?.jurisdiction || null,
      ch_has_insolvency:    p?.has_insolvency_history ?? null,
      ch_has_charges:       p?.has_charges ?? null,
      ch_accounts_overdue:  p?.accounts?.next_accounts?.overdue ?? null,
      ch_active_officers:   or?.active_count ?? null,
      ch_resigned_officers: or?.resigned_count ?? null,
      ch_address:           addrParts.join(', ') || null,
      ch_date_of_cessation: p?.date_of_cessation || null,
      ch_last_accounts_date: p?.accounts?.last_accounts?.made_up_to || null,
      ch_year_end_month:    p?.accounts?.accounting_reference_date?.month ? parseInt(p.accounts.accounting_reference_date.month, 10) : null,
      ch_data:              p,
    };
  } catch { return null; }
}

async function enrichDomainFromWeb(domain, companyName, fields) {
  const cleanDomain = domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  const wantFields = [];
  if (fields.includes('industry'))      wantFields.push('"industry": single category e.g. "Software", "Healthcare", "Financial Services"');
  if (fields.includes('keywords'))      wantFields.push('"keywords": 5-10 comma-separated descriptive keywords about what the company does');
  if (fields.includes('num_employees')) wantFields.push('"num_employees": integer employee count estimate or null');
  const systemPrompt = 'You are a company data extractor. Use your knowledge to identify company data from the domain and name. Return only valid JSON, no explanation or markdown.';

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model  = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
    if (!apiKey) return null;

    // Run Companies House and Claude in parallel — CH result used if it finishes first
    const chPromise = fetchCompaniesHouse(companyName);
    const ch = await Promise.race([chPromise, new Promise(res => setTimeout(() => res(null), 3000))]);

    const userPrompt = `Company: ${companyName || cleanDomain}\nDomain: ${cleanDomain}${ch?.sic ? `\nCompanies House SIC: ${ch.sic}` : ''}${ch?.accounts_type ? `\nAccounts type: ${ch.accounts_type}` : ''}\nExtract: ${wantFields.join('; ')}.\n\nReturn JSON only: {"industry":null,"keywords":null,"num_employees":null}`;

    const claudeReq = () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
      body: JSON.stringify({ model, max_tokens: 250, system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: userPrompt }] }),
    });
    let r = await claudeReq();
    if (!r.ok && (r.status === 429 || r.status >= 500)) {
      await new Promise(res => setTimeout(res, 2000));
      r = await claudeReq();
    }
    if (!r.ok) return null;
    const j = await r.json();
    const u = j?.usage || {};
    const cost = (
      ((u.input_tokens || 0) * HAIKU_PRICE.input +
       (u.output_tokens || 0) * HAIKU_PRICE.output +
       (u.cache_creation_input_tokens || 0) * HAIKU_PRICE.cache_write +
       (u.cache_read_input_tokens || 0) * HAIKU_PRICE.cache_read) / 1_000_000
    );
    const text = (j?.content?.[0]?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const data = JSON.parse(text);

    // Fill gaps with Companies House data directly
    if (ch) {
      if (!data.num_employees && ch.num_employees) data.num_employees  = ch.num_employees;
      if (!data.city    && ch.city)               data.city            = ch.city;
      if (!data.country && ch.country)            data.country         = ch.country;
      if (ch.company_status)                      data.company_status  = ch.company_status;
      // Store all CH fields regardless
      data.ch_company_number   = ch.ch_company_number;
      data.ch_company_type     = ch.ch_company_type;
      data.ch_founded_year     = ch.ch_founded_year;
      data.ch_postcode         = ch.ch_postcode;
      data.ch_sic_codes        = ch.ch_sic_codes;
      data.ch_jurisdiction     = ch.ch_jurisdiction;
      data.ch_has_insolvency   = ch.ch_has_insolvency;
      data.ch_has_charges      = ch.ch_has_charges;
      data.ch_accounts_overdue = ch.ch_accounts_overdue;
      data.ch_active_officers  = ch.ch_active_officers;
      data.ch_data             = ch.ch_data;
    }

    return { data, cost, tokens: (u.input_tokens||0) + (u.output_tokens||0) + (u.cache_read_input_tokens||0) };
  } catch { return null; }
}

let _activeEnrichJob = null; // in-memory reference to kill running jobs
let _enrichGeneration = 0;  // increment to kill any previous loop

async function saveEnrichJob(pgdb, job) {
  const { domains, ...rest } = job;
  await pgdb.query(`INSERT INTO _enrich_job (id, state) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET state = $1, updated_at = NOW()`,
    [JSON.stringify({ ...rest, domainCount: domains?.length })]);
}

async function loadEnrichJob(pgdb) {
  try {
    const { rows } = await pgdb.query(`SELECT state FROM _enrich_job WHERE id = 1`);
    return rows[0]?.state || null;
  } catch { return null; }
}

// Fetch a company homepage and extract location signals.
// Returns { postcodes, addressCandidates } where addressCandidates are
// plain-text address strings from <address> tags and <footer> content.
// Used as a location fallback when Apollo has no address for a domain.
async function fetchWebsiteLocationData(domain) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const urls = [`https://${domain}`, `https://www.${domain}`];
    for (const url of urls) {
      try {
        const r = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Ottaly/1.0)' },
          redirect: 'follow',
        });
        if (!r.ok) continue;
        const html = await r.text();
        clearTimeout(timer);

        // 1. Full UK postcodes (most reliable)
        const postcodes = [...new Set(
          (html.match(/\b[A-Z]{1,2}[0-9][A-Z0-9]?\s+[0-9][A-Z]{2}\b/gi) || [])
            .map(m => m.toUpperCase().replace(/\s+/, ' '))
        )];

        // 2. Address text from <address> tags and <footer> — fallback when no
        //    full postcode is found. Strip tags, collapse whitespace.
        const stripTags = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const addressBlocks = (html.match(/<address[^>]*>[\s\S]*?<\/address>/gi) || []).map(stripTags);
        const footerBlocks  = (html.match(/<footer[^>]*>[\s\S]*?<\/footer>/gi)  || []).map(stripTags);
        const addressCandidates = [...addressBlocks, ...footerBlocks].filter(s => s.length > 5);

        return { postcodes, addressCandidates };
      } catch { /* try next URL */ }
    }
  } finally {
    clearTimeout(timer);
  }
  return { postcodes: [], addressCandidates: [] };
}

async function processDomain(pgdb, job, domain, name) {
  const t0 = Date.now();
  try {
    const result = await Promise.race([
      enrichDomainFromWeb(domain, name, job.fields),
      new Promise((_, rej) => setTimeout(() => rej(new Error('domain timeout')), 15000)),
    ]);
    const ms = Date.now() - t0;
    job.domain_ms.push(ms);
    if (job.domain_ms.length > 20) job.domain_ms = job.domain_ms.slice(-20);

    const data = result?.data;
    job.total_cost   += result?.cost   || 0;
    job.total_tokens += result?.tokens || 0;

    if (data) {
      let updatedCount = 0;

      // ── Query 1: Claude fields — COALESCE, only fills blanks ──────────────
      const claudeSet = [], claudeVals = [], missingConditions = [];
      if (job.fields.includes('keywords') && data.keywords)
        { claudeSet.push(`keywords = COALESCE(NULLIF(keywords,''), $${claudeVals.push(String(data.keywords))})`); missingConditions.push(`(keywords IS NULL OR keywords = '')`); }
      if (job.fields.includes('industry') && data.industry)
        { claudeSet.push(`industry = COALESCE(NULLIF(industry,''), $${claudeVals.push(String(data.industry))})`); missingConditions.push(`(industry IS NULL OR industry = '')`); }
      if (job.fields.includes('num_employees') && data.num_employees)
        { const n = parseInt(data.num_employees, 10); if (Number.isFinite(n)) { claudeSet.push(`num_employees = COALESCE(num_employees, $${claudeVals.push(n)})`); missingConditions.push(`num_employees IS NULL`); } }
      if (data.city)    claudeSet.push(`city = COALESCE(NULLIF(city,''), $${claudeVals.push(String(data.city))})`);
      if (data.country) claudeSet.push(`country = COALESCE(NULLIF(country,''), $${claudeVals.push(String(data.country))})`);
      if (claudeSet.length && missingConditions.length) {
        claudeVals.push(domain);
        const r1 = await pgdb.query(`UPDATE contacts SET ${claudeSet.join(', ')}, updated_at = NOW() WHERE company_domain = $${claudeVals.length} AND (${missingConditions.join(' OR ')})`, claudeVals);
        updatedCount += r1.rowCount || 0;
      }

      // ── Query 2: Companies House fields — always update all contacts ───────
      const chSet = [], chVals = [];
      if (data.company_status)              chSet.push(`company_status = $${chVals.push(String(data.company_status))}`);
      if (data.ch_company_number   != null) chSet.push(`ch_company_number = $${chVals.push(String(data.ch_company_number))}`);
      if (data.ch_company_type     != null) chSet.push(`ch_company_type = $${chVals.push(String(data.ch_company_type))}`);
      if (data.ch_founded_year     != null) chSet.push(`ch_founded_year = $${chVals.push(parseInt(data.ch_founded_year))}`);
      if (data.ch_postcode         != null) chSet.push(`ch_postcode = $${chVals.push(String(data.ch_postcode))}`);
      if (data.ch_sic_codes        != null) chSet.push(`ch_sic_codes = $${chVals.push(String(data.ch_sic_codes))}`);
      if (data.ch_jurisdiction     != null) chSet.push(`ch_jurisdiction = $${chVals.push(String(data.ch_jurisdiction))}`);
      if (data.ch_has_insolvency   != null) chSet.push(`ch_has_insolvency = $${chVals.push(Boolean(data.ch_has_insolvency))}`);
      if (data.ch_has_charges      != null) chSet.push(`ch_has_charges = $${chVals.push(Boolean(data.ch_has_charges))}`);
      if (data.ch_accounts_overdue != null) chSet.push(`ch_accounts_overdue = $${chVals.push(Boolean(data.ch_accounts_overdue))}`);
      if (data.ch_active_officers  != null) chSet.push(`ch_active_officers = $${chVals.push(parseInt(data.ch_active_officers))}`);
      if (data.ch_resigned_officers!= null) chSet.push(`ch_resigned_officers = $${chVals.push(parseInt(data.ch_resigned_officers))}`);
      if (data.ch_address          != null) chSet.push(`ch_address = $${chVals.push(String(data.ch_address))}`);
      if (data.ch_date_of_cessation!= null) chSet.push(`ch_date_of_cessation = $${chVals.push(String(data.ch_date_of_cessation))}`);
      if (data.ch_last_accounts_date!=null) chSet.push(`ch_last_accounts_date = $${chVals.push(String(data.ch_last_accounts_date))}`);
      if (data.ch_year_end_month   != null) chSet.push(`ch_year_end_month = $${chVals.push(parseInt(data.ch_year_end_month))}`);
      if (data.ch_data             != null) chSet.push(`ch_data = $${chVals.push(JSON.stringify(data.ch_data))}`);
      // Always stamp enriched_at so the domain is skipped on future scans
      chSet.push(`enriched_at = NOW()`);
      chVals.push(domain);
      const r2 = await pgdb.query(`UPDATE contacts SET ${chSet.join(', ')}, updated_at = NOW() WHERE company_domain = $${chVals.length}`, chVals);
      updatedCount = Math.max(updatedCount, r2.rowCount || 0);

      // ── Query 3: Website address fallback — fills company_region for contacts
      // with no region. Fetches homepage, extracts full UK postcodes, maps via
      // geo-lookup. Single postcode → use it; multiple → flag for review.
      // Per spec: Companies House address NOT used (accountants' addresses).
      try {
        const { rows: [{ n: missing }] } = await pgdb.query(
          `SELECT COUNT(*) AS n FROM contacts WHERE company_domain = $1 AND (company_region IS NULL OR company_region = '')`,
          [domain]
        );
        if (parseInt(missing) > 0) {
          const { postcodes, addressCandidates } = await fetchWebsiteLocationData(domain);
          const geo        = require('./geo-lookup');
          const { normalize } = require('./location-normalizer');

          // Try to resolve a single unambiguous location from the website.
          // Priority: full postcode → address/footer text via normalizer.
          let resolvedLoc = null;
          let resolvedSource = 'website';

          if (postcodes.length === 1) {
            const area = geo.extractPostcodeArea(postcodes[0]);
            const loc  = area ? geo.lookupPostcodeArea(area) : null;
            if (loc) resolvedLoc = { region: loc.region, county: loc.county, town: loc.postTown };
          } else if (postcodes.length === 0 && addressCandidates.length > 0) {
            // No full postcode — try each address candidate through the normalizer.
            // Accept only if all candidates that resolve agree on the same region.
            const regions = new Set();
            let bestLoc = null;
            for (const candidate of addressCandidates.slice(0, 5)) {
              const r = normalize({ address: candidate });
              if (r.region) { regions.add(r.region); bestLoc = r; }
            }
            if (regions.size === 1 && bestLoc) {
              resolvedLoc = { region: bestLoc.region, county: bestLoc.county, town: bestLoc.town || bestLoc.city };
            }
          }

          if (resolvedLoc) {
            const r3 = await pgdb.query(`
              UPDATE contacts SET
                company_region = $1, company_county = $2, company_town = $3,
                location_source = $4, location_needs_review = false,
                location_normalized_at = NOW(), updated_at = NOW()
              WHERE company_domain = $5 AND (company_region IS NULL OR company_region = '')
            `, [resolvedLoc.region, resolvedLoc.county || null, resolvedLoc.town || null, resolvedSource, domain]);
            if (r3.rowCount > 0) {
              updatedCount = Math.max(updatedCount, r3.rowCount);
              job.log.push(`  ↳ location: ${resolvedLoc.region} via website`);
            }
          } else if (postcodes.length > 1) {
            await pgdb.query(`
              UPDATE contacts SET
                location_needs_review = true,
                location_review_reason = 'multiple_website_addresses',
                updated_at = NOW()
              WHERE company_domain = $1 AND (company_region IS NULL OR company_region = '')
            `, [domain]);
          }
        }
      } catch (locErr) {
        // Non-fatal — don't let website scraping break the main enrichment loop
      }

      if (claudeSet.length || chSet.length) {
        job.updated += updatedCount;
        job.log.push(`✓ ${domain} → ${claudeSet.length + chSet.length} field(s), ${updatedCount} contacts`);
        job.results.push({ domain, name:name||domain, status:'updated', contacts:updatedCount, industry:data.industry||null, keywords:data.keywords||null, num_employees:data.num_employees||null });
      } else {
        job.skipped++;
        job.log.push(`– ${domain} → no data found`);
        job.results.push({ domain, name:name||domain, status:'skipped', contacts:0, industry:null, keywords:null, num_employees:null });
      }
    } else {
      job.skipped++;
      job.log.push(`– ${domain} → no response`);
      job.results.push({ domain, name:name||domain, status:'failed', contacts:0, industry:null, keywords:null, num_employees:null });
    }
  } catch (err) {
    job.failed++;
    job.log.push(`✗ ${domain} → ${err.message}`);
  }
}

async function runEnrichment(pgdb, job) {
  if (!job || job.paused) return;
  _activeEnrichJob = job;
  const myGeneration = _enrichGeneration;
  job.total_cost   = job.total_cost   || 0;
  job.total_tokens = job.total_tokens || 0;
  job.domain_ms    = job.domain_ms    || [];
  const CONCURRENCY = job.concurrency || 5;

  // Build WHERE from fields — re-query from DB so we survive server restarts
  const conditions = [];
  if ((job.fields||[]).includes('keywords'))      conditions.push(`(keywords IS NULL OR keywords = '')`);
  if ((job.fields||[]).includes('industry'))      conditions.push(`(industry IS NULL OR industry = '')`);
  if ((job.fields||[]).includes('num_employees')) conditions.push(`num_employees IS NULL`);
  if ((job.fields||[]).includes('company_status')) conditions.push(`company_status IS NULL`);
  const whereConditions = conditions.join(' OR ');

  const { rows: allDomains } = await pgdb.query(`
    SELECT DISTINCT ON (company_domain) company_domain, company_name
    FROM contacts
    WHERE company_domain IS NOT NULL AND company_domain != ''
      AND (${whereConditions})
    ORDER BY company_domain
  `);

  const todo = allDomains.slice(job.processed).map(r => ({ domain: r.company_domain, name: r.company_name }));
  console.log(`[enrich] pid=${process.pid} resuming at ${job.processed}/${allDomains.length} domains (concurrency=${CONCURRENCY})`);

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    if (job.paused) break;
    if (_enrichGeneration !== myGeneration) break; // newer job started, stop this loop

    // Check paused state from DB every batch
    const fresh = await loadEnrichJob(pgdb).catch(() => null);
    if (fresh?.paused) { job.paused = true; break; }

    const batch = todo.slice(i, i + CONCURRENCY);
    job.current_domain = batch[0].domain;
    await saveEnrichJob(pgdb, job).catch(() => {});

    // Process batch with slight stagger to avoid Claude rate limits
    await Promise.all(batch.map(({ domain, name }, i) =>
      new Promise(res => setTimeout(res, i * 200))
        .then(() => { if (job.paused) return; return processDomain(pgdb, job, domain, name); })
        .then(async () => {
          job.processed++;
          if (job.log.length > 300)     job.log     = job.log.slice(-300);
          if (job.results.length > 200) job.results = job.results.slice(-200);
          await saveEnrichJob(pgdb, job).catch(() => {});
          // Check pause after each domain
          const fresh = await loadEnrichJob(pgdb).catch(() => null);
          if (fresh?.paused) job.paused = true;
        })
    ));
  }

  if (!job.paused) {
    job.status = 'completed'; job.current_domain = null;
    job.log.push(`✓ Done — ${job.updated} contacts updated, cost $${(job.total_cost||0).toFixed(4)}`);
    await saveEnrichJob(pgdb, job).catch(() => {});
  }
}

// ── AI Enrichment — state persisted in Postgres so all instances share it ──

async function enrichDbState(pgdb) {
  await pgdb.query(`CREATE TABLE IF NOT EXISTS _enrich_job (
    id INT PRIMARY KEY DEFAULT 1,
    state JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
}

app.post('/api/admin/enrich/start', requireAdmin, async (req, res) => {
  const { fields = ['keywords', 'industry', 'num_employees'], limit = 0, concurrency = 5 } = req.body;
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });

  await enrichDbState(pgdb);
  // Kill any in-memory running job before starting fresh
  _enrichGeneration++;
  if (_activeEnrichJob) {
    _activeEnrichJob.paused = true;
    _activeEnrichJob.status = 'stopped';
    _activeEnrichJob = null;
  }

  const conditions = [];
  if (fields.includes('keywords'))      conditions.push(`(keywords IS NULL OR keywords = '')`);
  if (fields.includes('industry'))      conditions.push(`(industry IS NULL OR industry = '')`);
  if (fields.includes('num_employees')) conditions.push(`num_employees IS NULL`);
  if (conditions.length === 0) return res.status(400).json({ error: 'No fields selected' });

  const limitClause = limit > 0 ? `LIMIT ${parseInt(limit, 10)}` : '';
  const { rows } = await pgdb.query(`
    SELECT DISTINCT ON (company_domain) company_domain, company_name
    FROM contacts
    WHERE company_domain IS NOT NULL AND company_domain != ''
      AND (${conditions.join(' OR ')})
    ORDER BY company_domain
    ${limitClause}
  `);

  const job = {
    status: 'running', fields, concurrency: Math.min(Math.max(parseInt(concurrency)||5, 1), 10),
    total: rows.length, processed: 0, updated: 0, failed: 0, skipped: 0,
    current_domain: null, log: [], results: [], started_at: new Date().toISOString(),
    paused: false,
  };

  await saveEnrichJob(pgdb, job);
  res.json({ ok: true, total: job.total });
  runEnrichment(pgdb, job).catch(err => console.error('[enrich]', err.message));
});

app.get('/api/admin/enrich/scan', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });

  const fields = (req.query.fields || 'keywords,industry,num_employees').split(',').map(f => f.trim());
  const conditions = [];
  if (fields.includes('keywords'))      conditions.push(`(keywords IS NULL OR keywords = '')`);
  if (fields.includes('industry'))      conditions.push(`(industry IS NULL OR industry = '')`);
  if (fields.includes('num_employees')) conditions.push(`num_employees IS NULL`);
  if (fields.includes('company_status')) conditions.push(`company_status IS NULL`);

  const { rows } = await pgdb.query(`
    SELECT
      COUNT(DISTINCT company_domain) AS domains,
      COUNT(*) AS contacts
    FROM contacts
    WHERE company_domain IS NOT NULL AND company_domain != ''
      AND (${conditions.join(' OR ')})
  `);

  const domains = parseInt(rows[0].domains, 10);
  const contacts = parseInt(rows[0].contacts, 10);
  const cost_usd = +(domains * 0.00002).toFixed(4);

  res.json({ domains, contacts, cost_usd });
});

app.get('/api/admin/enrich/status', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.json({ status: 'idle' });
  await enrichDbState(pgdb).catch(() => {});
  const job = await loadEnrichJob(pgdb);
  if (!job) return res.json({ status: 'idle', pid: process.pid });
  res.json({ ...job, pid: process.pid });
});

app.get('/api/admin/enrich/test', requireAdmin, async (req, res) => {
  const domain = req.query.domain || 'bbc.co.uk';
  const trace = { domain, pid: process.pid, steps: [] };
  try {
    trace.steps.push('calling claude');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model  = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
    trace.steps.push(`api key present: ${!!apiKey}, model: ${model}`);
    if (apiKey) {
      const cr = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 150, system: 'Extract JSON only.', messages: [{ role: 'user', content: `Domain: ${domain}\nReturn: {"industry":null,"keywords":null}` }] }),
      });
      const cj = await cr.json();
      trace.steps.push(`claude status: ${cr.status}, response: ${JSON.stringify(cj).slice(0, 300)}`);
    }
    res.json({ ok: true, trace });
  } catch (e) {
    trace.steps.push(`fatal: ${e.message}`);
    res.json({ ok: false, trace });
  }
});

app.get('/api/admin/enrich/sample-csv', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });

  // Get 100 contacts (1 per domain) — only those missing enrichment data
  const { rows: contacts } = await pgdb.query(`
    SELECT DISTINCT ON (company_domain)
      id, workspace_id, email, first_name, last_name, company_name, company_domain,
      job_title, job_title_cleaned, seniority, department, sub_departments,
      industry, num_employees, keywords, technologies, company_status,
      city, state, country, company_city, company_state, company_country,
      linkedin_url, company_linkedin_url, email_status, status, source, imported_at,
      ch_company_number, ch_company_type, ch_founded_year, ch_postcode,
      ch_sic_codes, ch_jurisdiction, ch_has_insolvency, ch_has_charges,
      ch_accounts_overdue, ch_active_officers
    FROM contacts
    WHERE company_domain IS NOT NULL AND company_domain != ''
      AND (keywords IS NULL OR keywords = '')
      AND (industry IS NULL OR industry = '')
      AND num_employees IS NULL
    ORDER BY company_domain, imported_at DESC
    LIMIT 100
  `);

  // Enrich each domain (5 at a time) — only factual data from Companies House + Claude
  const results = [];
  let totalCost = 0, totalTokens = 0;
  for (let i = 0; i < contacts.length; i += 5) {
    const batch = contacts.slice(i, i + 5);
    const enriched = await Promise.all(batch.map(async c => {
      const result = await Promise.race([
        enrichDomainFromWeb(c.company_domain, c.company_name, ['keywords','industry','num_employees']),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
      ]).catch(() => null);
      totalCost   += result?.cost   || 0;
      totalTokens += result?.tokens || 0;
      const d = result?.data || {};
      return {
        ...c,
        enriched_industry:             d.industry             || '',
        enriched_keywords:             d.keywords             || '',
        enriched_num_employees:        d.num_employees        || '',
        enriched_company_status:       d.company_status       || '',
        enriched_city:                 d.city                 || '',
        enriched_country:              d.country              || '',
        enriched_ch_company_number:    d.ch_company_number    || '',
        enriched_ch_company_type:      d.ch_company_type      || '',
        enriched_ch_founded_year:      d.ch_founded_year      || '',
        enriched_ch_postcode:          d.ch_postcode          || '',
        enriched_ch_sic_codes:         d.ch_sic_codes         || '',
        enriched_ch_jurisdiction:      d.ch_jurisdiction      || '',
        enriched_ch_has_insolvency:    d.ch_has_insolvency    ?? '',
        enriched_ch_has_charges:       d.ch_has_charges       ?? '',
        enriched_ch_accounts_overdue:  d.ch_accounts_overdue  ?? '',
        enriched_ch_active_officers:   d.ch_active_officers   || '',
      };
    }));
    results.push(...enriched);
  }

  const esc = v => v == null || v === '' ? '' : `"${String(v).replace(/"/g,'""')}"`;

  // ── Original CSV ──────────────────────────────────────────────
  const origCols = [
    'workspace_id','email','first_name','last_name','company_name','company_domain',
    'job_title','seniority','department','sub_departments',
    'industry','keywords','num_employees','technologies','company_status',
    'city','state','country','company_city','company_state','company_country',
    'linkedin_url','company_linkedin_url','email_status','status','source','imported_at',
    'ch_company_number','ch_company_type','ch_founded_year','ch_postcode',
    'ch_sic_codes','ch_jurisdiction','ch_has_insolvency','ch_has_charges',
    'ch_accounts_overdue','ch_active_officers',
  ];
  const origCsv = [origCols.join(','), ...results.map(r => origCols.map(c => esc(r[c])).join(','))].join('\n');

  // ── Enriched CSV — what Claude/CH found fresh ─────────────────
  const enrichCols = [
    'company_domain','company_name',
    'enriched_industry','enriched_keywords','enriched_num_employees',
    'enriched_company_status','enriched_city','enriched_country',
    'enriched_ch_company_number','enriched_ch_company_type','enriched_ch_founded_year',
    'enriched_ch_postcode','enriched_ch_sic_codes','enriched_ch_jurisdiction',
    'enriched_ch_has_insolvency','enriched_ch_has_charges',
    'enriched_ch_accounts_overdue','enriched_ch_active_officers',
  ];
  const enrichedResults = results.filter(r => r.enriched_industry || r.enriched_keywords || r.enriched_num_employees || r.enriched_company_status);
  const summaryRow = `"--- SUMMARY ---","Contacts: ${results.length}","Enriched: ${enrichedResults.length}","Tokens: ${totalTokens.toLocaleString()}","Cost: $${totalCost.toFixed(5)}","Est. 185k domains: $${(totalCost / Math.max(results.length,1) * 185515).toFixed(2)}"`;
  const enrichCsv = [enrichCols.join(','), ...enrichedResults.map(r => enrichCols.map(c => esc(r[c])).join(',')), '', summaryRow].join('\n');

  // ── Return both as a simple multipart-like response using JSON ─
  // Client receives JSON with both CSVs as base64 and triggers two downloads
  const toB64 = s => Buffer.from(s).toString('base64');
  res.json({
    original: { filename: 'contacts-original.csv', data: toB64(origCsv) },
    enriched: { filename: 'contacts-enriched.csv', data: toB64(enrichCsv) },
    summary: { contacts: results.length, tokens: totalTokens, cost_usd: parseFloat(totalCost.toFixed(5)), est_full_db_usd: parseFloat((totalCost / Math.max(results.length,1) * 185515).toFixed(2)) },
  });
});

app.get('/api/admin/enrich/ch-raw', requireAdmin, async (req, res) => {
  const name = req.query.name || req.query.domain || 'Bruud Drinks';
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) return res.status(503).json({ error: 'COMPANIES_HOUSE_API_KEY not set' });
  const auth = { 'Authorization': 'Basic ' + Buffer.from(key + ':').toString('base64') };
  try {
    const q = encodeURIComponent(name.slice(0, 60));
    const sr = await fetch(`https://api.company-information.service.gov.uk/search/companies?q=${q}&items_per_page=3`, { headers: auth });
    const sj = await sr.json();
    const item = sj?.items?.[0];
    if (!item) return res.json({ search_results: sj, profile: null, officers: null });
    const [pr, or] = await Promise.all([
      fetch(`https://api.company-information.service.gov.uk/company/${item.company_number}`, { headers: auth }).then(r => r.json()),
      fetch(`https://api.company-information.service.gov.uk/company/${item.company_number}/officers?items_per_page=10`, { headers: auth }).then(r => r.json()),
    ]);
    res.json({ search_results: sj?.items?.slice(0,3), profile: pr, officers: or });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/enrich/pause', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  const job = await loadEnrichJob(pgdb);
  if (!job) return res.status(404).json({ error: 'No job' });
  job.paused = true; job.status = 'paused';
  await saveEnrichJob(pgdb, job);
  res.json({ ok: true });
});

app.post('/api/admin/enrich/resume', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  const job = await loadEnrichJob(pgdb);
  if (!job) return res.status(404).json({ error: 'No job' });
  if (job.status === 'stopped') return res.status(409).json({ error: 'Job was stopped — start a new job instead of resuming' });
  job.paused = false; job.status = 'running';
  await saveEnrichJob(pgdb, job);
  runEnrichment(pgdb, job).catch(err => console.error('[enrich]', err.message));
  res.json({ ok: true });
});

app.post('/api/admin/enrich/stop', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  // Kill in-memory job immediately
  _enrichGeneration++;
  if (_activeEnrichJob) {
    _activeEnrichJob.paused = true;
    _activeEnrichJob.status = 'stopped';
    _activeEnrichJob = null;
  }
  await pgdb.query(`INSERT INTO _enrich_job (id, state) VALUES (1, $1)
    ON CONFLICT (id) DO UPDATE SET state = $1, updated_at = NOW()`,
    [JSON.stringify({ status: 'stopped', paused: true, stopped_at: new Date().toISOString() })]).catch(() => {});
  res.json({ ok: true });
});

// enrichDomainFromWeb + runEnrichment defined after callClaude — see below

app.get('/api/admin/migrations-status', requireAdmin, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const mig = await pgdb.query(`SELECT name, ran_at FROM _migrations ORDER BY ran_at`);
    const allCapsCount = await pgdb.query(`
      SELECT COUNT(*) AS n FROM contacts
      WHERE company_name IS NOT NULL
        AND company_name !~ '[a-z]'
        AND company_name ~ '[A-Z]'
    `);
    const sample = await pgdb.query(`
      SELECT company_name, COUNT(*) AS n FROM contacts
      WHERE company_name IS NOT NULL
        AND company_name !~ '[a-z]'
      GROUP BY company_name
      ORDER BY n DESC
      LIMIT 10
    `);
    res.json({
      migrations: mig.rows,
      all_caps_remaining: parseInt(allCapsCount.rows[0]?.n || 0, 10),
      sample_all_caps: sample.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-shot mass cleanup: walks every contact, re-runs cleanCompanyName +
// normalizeJobTitle, writes back the rows where it would change. Runs
// async in the background — endpoint returns immediately with a job id
// you can poll via GET. Idempotent — safe to run multiple times.
let _massCleanJob = null;
app.post('/api/admin/clean-all-names', requireAdmin, async (req, res) => {
  if (_massCleanJob && _massCleanJob.status === 'running') {
    return res.json({ ok: true, alreadyRunning: true, job: _massCleanJob });
  }
  _massCleanJob = {
    status: 'running',
    started_at: new Date().toISOString(),
    scanned: 0,
    updated: 0,
    error: null,
  };
  // Kick off in the background, return immediately.
  (async () => {
    try {
      const pgdb = app.locals.pgDb;
      const PAGE = 500;
      let lastId = '00000000-0000-0000-0000-000000000000';
      while (true) {
        const r = await pgdb.query(
          `SELECT id, company_name, job_title, job_title_cleaned
           FROM contacts
           WHERE id > $1
           ORDER BY id
           LIMIT $2`,
          [lastId, PAGE]
        );
        if (!r.rows.length) break;
        const updates = [];
        for (const row of r.rows) {
          const newCompany = cleanCompanyName(row.company_name || '');
          const titleSource = row.job_title_cleaned || row.job_title || '';
          const newTitle = normalizeJobTitle(titleSource);
          if (newCompany !== row.company_name || newTitle !== row.job_title_cleaned) {
            updates.push({
              id: row.id,
              company_name: newCompany || null,
              job_title_cleaned: newTitle || null,
            });
          }
          lastId = row.id;
        }
        if (updates.length && pgdb.bulkUpdateCleanedNames) {
          const out = await pgdb.bulkUpdateCleanedNames(updates);
          _massCleanJob.updated += (out.updated || 0);
        }
        _massCleanJob.scanned += r.rows.length;
        if (r.rows.length < PAGE) break;
      }
      _massCleanJob.status = 'done';
      _massCleanJob.finished_at = new Date().toISOString();
      console.log(`[clean-all-names] done — scanned ${_massCleanJob.scanned}, updated ${_massCleanJob.updated}`);
    } catch (err) {
      _massCleanJob.status = 'failed';
      _massCleanJob.error = err.message;
      console.error('[clean-all-names] error:', err.message);
    }
  })();
  res.json({ ok: true, started: true, job: _massCleanJob });
});

app.get('/api/admin/clean-all-names/status', requireAdmin, (req, res) => {
  res.json({ job: _massCleanJob });
});

// Delete contacts that have no first_name AND no last_name (treats NULL and ''
// as missing). FK cascade removes their campaign_contacts / audience_scores.
// Streams the deleted rows back as a CSV download so they can be verified.
// Batched at 500/iter to stay under the 45s pool statement_timeout — a
// single-shot DELETE on tens of thousands of rows hits the timeout and 500s.
// Pass ?dryRun=1 to preview matches without deleting, ?max=N to cap the run.
app.post('/api/admin/contacts/delete-nameless', requireAdmin, async (req, res) => {
  const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
  const maxRows = parseInt(req.query.max || '0', 10) || 0;
  const BATCH = 500;
  const pgdb = app.locals.pgDb;
  const colNames = ['id','workspace_id','email','first_name','last_name',
                    'company_name','company_domain','job_title','source','imported_at'];
  const colList = colNames.join(', ');
  const whereSql = `
    (first_name IS NULL OR first_name = '')
    AND (last_name IS NULL OR last_name = '')
  `;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${dryRun ? 'preview' : 'deleted'}-nameless-contacts-${stamp}.csv`;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('X-Dry-Run', dryRun ? '1' : '0');

  const esc = v => {
    const s = String(v == null ? '' : v);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  res.write(colNames.join(',') + '\n');

  let total = 0;
  try {
    while (true) {
      const limit = maxRows > 0 ? Math.min(BATCH, maxRows - total) : BATCH;
      if (limit <= 0) break;

      let rows;
      if (dryRun) {
        // Pure SELECT — paginate by id so we don't re-read the same rows.
        const r = await pgdb.query(
          `SELECT ${colList} FROM contacts WHERE ${whereSql}
           ORDER BY id LIMIT $1 OFFSET $2`,
          [limit, total]
        );
        rows = r.rows;
      } else {
        // Pull a batch of ids with SKIP LOCKED so we never block on rows
        // another transaction is touching, then DELETE them by id list and
        // RETURNING the columns for the CSV.
        const r = await pgdb.query(
          `DELETE FROM contacts WHERE id IN (
             SELECT id FROM contacts
             WHERE ${whereSql}
             ORDER BY id
             LIMIT $1
             FOR UPDATE SKIP LOCKED
           ) RETURNING ${colList}`,
          [limit]
        );
        rows = r.rows;
      }

      if (!rows.length) break;
      for (const row of rows) {
        res.write(colNames.map(c => esc(row[c])).join(',') + '\n');
      }
      total += rows.length;
      if (!dryRun) console.log(`[delete-nameless] batch ${rows.length}, total ${total}`);
    }
    console.log(`[delete-nameless] ${dryRun ? 'previewed' : 'deleted'} ${total} contacts`);
    res.end();
  } catch (err) {
    console.error(`[delete-nameless] error after ${total} rows:`, err.message);
    // Headers already sent — finish the stream with an inline error marker
    // so the downloaded CSV makes the failure obvious.
    res.write(`\n# ERROR after ${total} rows: ${err.message}\n`);
    res.end();
  }
});

// Build version = process start time. Every redeploy spawns a new process,
// so the value changes. The client compares against localStorage to decide
// whether to show the "Ottaly 2.0" splash on this deploy.
const BUILD_VERSION = String(Date.now());
app.get('/api/build-version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ version: BUILD_VERSION });
});

// Liveness/readiness probe for Easypanel/uptime monitoring. No auth — 200 when
// the process is up and Postgres answers SELECT 1, else 503.
app.get('/healthz', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const health = { status: 'ok', uptime: Math.round(process.uptime()), db: 'unknown' };
  try {
    const pgPool = req.app.locals.pgDb;
    if (pgPool && typeof pgPool.query === 'function') {
      await pgPool.query('SELECT 1');
      health.db = 'ok';
    } else {
      health.db = 'unconfigured';
    }
    res.json(health);
  } catch (err) {
    health.status = 'degraded';
    health.db = 'error';
    health.error = err.message;
    res.status(503).json(health);
  }
});

// Hoisted to module scope so functions defined after the if(db) block (e.g.
// runAudienceScoringAll) can still reference pvFetch. Assignment happens
// inside the if(db) block at runtime.
var pvFetch;

if (db) {
app.post('/api/admin/login', (req, res) => {
  const { key } = req.body || {};
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Wrong key' });
  setSessionCookie(res, { role: 'admin', name: 'Admin' });
  res.json({ ok: true, role: 'admin' });
});

app.post('/api/manager/login', (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) return res.status(400).json({ error: 'Missing fields' });
  const mgr = db.prepare('SELECT * FROM managers WHERE LOWER(name)=LOWER(?)').get(name.trim());
  if (!mgr || !bcrypt.compareSync(password, mgr.password_hash))
    return res.status(401).json({ error: 'Incorrect name or password' });
  setSessionCookie(res, { role: 'manager', name: mgr.name });
  res.json({ ok: true, role: 'manager', name: mgr.name });
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.setHeader('Set-Cookie', [
    'ottaly_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict',
    'ottaly_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict'
  ]);
  res.json({ ok: true });
});

// Legacy compat
app.post('/api/admin/logout', (req, res) => {
  clearSessionCookie(res);
  res.setHeader('Set-Cookie', 'ottaly_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
  res.json({ ok: true });
});
app.get('/api/admin/verify', (req, res) => {
  const s = decodeSession(req);
  if (s?.role === 'admin') return res.json({ ok: true });
  const raw = req.headers.cookie || '';
  const m   = raw.match(/(?:^|;\s*)ottaly_admin=([^;]+)/);
  if (m) { try { jwt.verify(m[1], JWT_SECRET + ADMIN_KEY); return res.json({ ok: true }); } catch {} }
  res.status(401).json({ ok: false });
});

// ── Bison API key (admin only) ───────────────────────────
// The key lives in app_settings and overrides BISON_API_KEY (env). We never
// return the full key to the browser — only a masked hint (last 4 chars).
app.get('/api/admin/bison-key', requireAdmin, (req, res) => {
  const key = getBisonKey();
  res.json({
    configured: !!key,
    source: _bisonKeyOverride ? 'dashboard' : (BISON_ENV_KEY ? 'env' : 'none'),
    masked: key ? '••••••••' + key.slice(-4) : null,
  });
});

app.post('/api/admin/bison-key', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  const key = (req.body && req.body.key != null ? String(req.body.key) : '').trim();
  if (!key) return res.status(400).json({ error: 'key is required' });
  try {
    await pgdb.setSetting('bison_api_key', key);
    _bisonKeyOverride = key;        // takes effect immediately, no restart
    _bisonWsId = null;              // force a workspace re-switch on next call
    res.json({ ok: true, masked: '••••••••' + key.slice(-4) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear the dashboard key and fall back to the env var.
app.delete('/api/admin/bison-key', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    await pgdb.setSetting('bison_api_key', '');
    _bisonKeyOverride = null;
    _bisonWsId = null;
    res.json({ ok: true, source: BISON_ENV_KEY ? 'env' : 'none' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test the currently-effective key against Bison. Reports workspace count so
// the admin gets instant confirmation the dashboard is talking to Bison.
app.post('/api/admin/bison-key/test', requireAdmin, async (req, res) => {
  if (!getBisonKey()) return res.status(400).json({ ok: false, error: 'No Bison key configured' });
  try {
    const data = await bisonReq('/api/workspaces/v1.1');
    const list = Array.isArray(data) ? data : (data?.data || []);
    res.json({ ok: true, workspaces: list.length });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── Per-workspace Bison tokens (admin only) ──────────────
// These eliminate the "only one login at a time" logouts: each workspace gets
// its own scoped API token so the crons never call switch-workspace. See the
// _bisonWsTokens block near getBisonKey(). The super-admin key must still be
// configured (it's what mints these). We never return token plaintext to the
// browser — only which teams have one.
//
// Status: which BISON_TEAMS have a per-workspace token.
app.get('/api/admin/bison-tokens', requireAdmin, (req, res) => {
  res.json({
    superAdminConfigured: !!getBisonKey(),
    teams: BISON_TEAMS.map((t) => ({
      team_id: t.team_id, name: t.name,
      hasToken: !!getBisonWsToken(t.team_id),
    })),
    count: BISON_TEAMS.filter((t) => getBisonWsToken(t.team_id)).length,
    total: BISON_TEAMS.length,
  });
});

// Mint per-workspace tokens via POST /api/workspaces/v1.1/{team_id}/api-tokens
// (requires the super-admin key). Body { team_id? } mints one team; omit to mint
// for every team missing a token. Existing tokens are kept unless force=true.
// Minting does NOT switch the active workspace (the api-tokens endpoint is
// team-scoped in the path), so it's safe to run while the dashboard is live.
app.post('/api/admin/bison-tokens/mint', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  if (!getBisonKey()) return res.status(400).json({ error: 'Configure the super-admin Bison key first' });
  const body = req.body || {};
  const force = body.force === true;
  // Which teams to mint for: a specific one, or all that lack a token.
  let targets;
  if (body.team_id != null) {
    const tid = String(body.team_id).trim();
    const team = BISON_TEAMS.find((t) => t.team_id === tid);
    if (!team) return res.status(400).json({ error: `Unknown team_id ${tid} (not in BISON_TEAMS)` });
    targets = [team];
  } else {
    targets = BISON_TEAMS.filter((t) => force || !getBisonWsToken(t.team_id));
  }
  const results = [];
  for (const team of targets) {
    if (!force && getBisonWsToken(team.team_id)) { results.push({ team_id: team.team_id, name: team.name, status: 'skipped (exists)' }); continue; }
    try {
      // The super-admin key authorizes; team_id in the PATH scopes the token. We
      // call _bisonRaw with NO wsId so it does not switch any workspace.
      const data = await bisonReq(`/api/workspaces/v1.1/${team.team_id}/api-tokens`, {
        method: 'POST',
        body: { name: `ottaly-admin-${team.name}`.slice(0, 60) },
      });
      const token = data?.data?.plain_text_token;
      if (!token) throw new Error('no plain_text_token in response');
      _bisonWsTokens[String(team.team_id)] = token;
      results.push({ team_id: team.team_id, name: team.name, status: 'minted' });
    } catch (err) {
      results.push({ team_id: team.team_id, name: team.name, status: 'error', error: err.message });
    }
    await new Promise((r) => setTimeout(r, 600)); // gentle on Bison
  }
  // Persist the whole map (only successful mints changed it).
  try { await pgdb.setSetting('bison_ws_tokens', _bisonWsTokens); }
  catch (err) { return res.status(500).json({ error: 'Minted but failed to persist: ' + err.message, results }); }
  const minted = results.filter((r) => r.status === 'minted').length;
  res.json({ ok: true, minted, results, count: BISON_TEAMS.filter((t) => getBisonWsToken(t.team_id)).length, total: BISON_TEAMS.length });
});

// Clear all per-workspace tokens (falls back to super-admin + switch-workspace).
app.delete('/api/admin/bison-tokens', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    _bisonWsTokens = {};
    await pgdb.setSetting('bison_ws_tokens', {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Claude Access (admin only) ───────────────────────────
// Read the capability catalog + current toggles for the "Claude Access" panel.
app.get('/api/admin/claude-permissions', requireAdmin, async (req, res) => {
  try {
    const perms = await getClaudePerms(req.app.locals.pgDb);
    res.json({
      enabled: perms.enabled,
      capabilities: CLAUDE_CAPABILITIES.map((c) => ({
        id: c.id, label: c.label, group: c.group, risk: c.risk, desc: c.desc,
        methods: c.methods, endpointCount: c.prefixes.length, enabled: !!perms[c.id],
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save toggles. Body: { enabled?, capabilities?: { [id]: bool } }. Only known
// keys are persisted, so the stored object can't drift from the catalog.
app.post('/api/admin/claude-permissions', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const current = await getClaudePerms(pgdb);
    const body = req.body || {};
    const next = { ...current };
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    const caps = body.capabilities || {};
    for (const c of CLAUDE_CAPABILITIES) {
      if (typeof caps[c.id] === 'boolean') next[c.id] = caps[c.id];
    }
    await pgdb.setSetting('claude_permissions', next);
    console.log('[claude-permissions] updated:', JSON.stringify(next));
    res.json({ ok: true, enabled: next.enabled,
      capabilities: CLAUDE_CAPABILITIES.map((c) => ({
        id: c.id, label: c.label, group: c.group, risk: c.risk, desc: c.desc,
        methods: c.methods, endpointCount: c.prefixes.length, enabled: !!next[c.id] })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic: live per-workspace mailbox count straight from Bison, paginated.
// Lets us see exactly where the dashboard count diverges from Bison's real total
// (e.g. 165 shown vs ~1000 expected) without waiting for the 30-min cache.
// Export every email currently in the mailbox cache (what the dashboard sees).
// Use to diff against a known list. ?domain=foo.co.uk filters; default returns all.
app.get('/api/admin/mailbox-emails', requireAdmin, (req, res) => {
  const all = (_mailboxCache.mailboxes || []).map(m => m.email).sort();
  res.json({ total: all.length, lastRun: _mailboxCache.lastRun, emails: all });
});

// Hunt for a sender email / domain across EVERY Bison workspace. Bison's own
// ?search= is fuzzy and unreliable, so we pull the FULL sender-email list per
// workspace (all pages, all statuses) and filter client-side by exact substring.
// Tells us definitively whether a "missing" mailbox is in Bison, in which
// workspace, and its status. GET /api/admin/mailbox-find?q=gxifitouts
// Optional ?statuses=1 includes a per-workspace status breakdown.
// ── PlusVibe shutdown: warmup OFF + cold-email daily limit 0, ALL workspaces ──
// PV is being wound down. This turns off warmup and sets daily sending to 0 for
// every mailbox in every PV workspace, directly via the live PlusVibe API.
// GET  ?dry=1            → preview (counts per workspace, no changes)
// POST                   → execute
// Optional ?key=<pvkey>  → override the (possibly stale) PLUSVIBE_KEY env.
const PV_API_BASE = 'https://api.plusvibe.ai/api/v1';
async function pvApi(path, { method = 'GET', body, key } = {}) {
  const apiKey = key || PLUSVIBE_KEY;
  const init = { method, headers: { 'x-api-key': apiKey, 'User-Agent': 'Mozilla/5.0' } };
  if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(PV_API_BASE + path, init);
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
  if (!r.ok) throw new Error(`PV ${path} → ${r.status}: ${txt.slice(0, 200)}`);
  return data;
}
async function pvListAllAccountIds(workspaceId, key) {
  const ids = [];
  for (let skip = 0; skip < 5000; skip += 200) {
    const resp = await pvApi(`/account/list?workspace_id=${workspaceId}&limit=200&skip=${skip}`, { key });
    const list = Array.isArray(resp) ? resp : (resp?.accounts || resp?.email_accounts || resp?.data || []);
    if (!list.length) break;
    for (const a of list) { const id = a._id || a.id; if (id) ids.push(String(id)); }
    if (list.length < 200) break;
  }
  return ids;
}
async function pvShutdownHandler(req, res) {
  const key = (req.query.key || req.body?.key || '').toString().trim() || PLUSVIBE_KEY;
  const dryRun = req.method === 'GET' || req.query.dry === '1';
  try {
    const wsRaw = await pvApi('/workspaces', { key });
    const workspaces = Array.isArray(wsRaw) ? wsRaw : (wsRaw?.workspaces || wsRaw?.data || []);
    const report = [];
    for (const ws of workspaces) {
      const wsId = ws.id || ws._id;
      const name = ws.name || wsId;
      try {
        const ids = await pvListAllAccountIds(wsId, key);
        const entry = { workspace_id: wsId, name, mailboxes: ids.length, warmup_off: 0, daily_zeroed: 0 };
        if (!dryRun && ids.length) {
          // PV bulk endpoints cap batch size; chunk to be safe.
          for (let i = 0; i < ids.length; i += 100) {
            const chunk = ids.slice(i, i + 100);
            await pvApi('/account/bulk-update-warmup', { method: 'PATCH', key,
              body: { workspace_id: wsId, ids: chunk, warmup_status: 'INACTIVE' } });
            entry.warmup_off += chunk.length;
            await pvApi('/account/bulk-update', { method: 'PUT', key,
              body: { workspace_id: wsId, ids: chunk, daily_limit: 0 } });
            entry.daily_zeroed += chunk.length;
          }
        }
        report.push(entry);
      } catch (e) {
        report.push({ workspace_id: wsId, name, error: e.message });
      }
    }
    const totals = report.reduce((t, r) => ({
      workspaces: t.workspaces + 1,
      mailboxes: t.mailboxes + (r.mailboxes || 0),
      warmup_off: t.warmup_off + (r.warmup_off || 0),
      daily_zeroed: t.daily_zeroed + (r.daily_zeroed || 0),
      errors: t.errors + (r.error ? 1 : 0),
    }), { workspaces: 0, mailboxes: 0, warmup_off: 0, daily_zeroed: 0, errors: 0 });
    res.json({ dry_run: dryRun, totals, workspaces: report });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
app.get('/api/admin/pv-shutdown',  requireAdmin, pvShutdownHandler);
app.post('/api/admin/pv-shutdown', requireAdmin, pvShutdownHandler);

app.get('/api/admin/mailbox-find', requireAdmin, async (req, res) => {
  if (!getBisonKey()) return res.status(400).json({ error: 'No Bison key configured' });
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.status(400).json({ error: 'q (search term) required' });
  try {
    const wsRaw = listBisonWorkspaces();
    const workspaces = Array.isArray(wsRaw) ? wsRaw : (wsRaw?.data || []);
    const hits = [];
    const scanned = [];
    for (const w of workspaces) {
      try {
        const list = await bisonListSenderEmails(String(w.id)); // full paginated list
        const statusCounts = {};
        let wsHits = 0;
        for (const a of list) {
          const email = String(a.email || a.name || '').toLowerCase();
          const st = String(a.status || 'unknown');
          statusCounts[st] = (statusCounts[st] || 0) + 1;
          if (email.includes(q)) {
            hits.push({ team_id: String(w.id), workspace: w.name, email, status: a.status, type: a.type });
            wsHits++;
          }
        }
        scanned.push({ team_id: String(w.id), workspace: w.name, total: list.length, hits: wsHits, statuses: statusCounts });
      } catch (e) {
        scanned.push({ team_id: String(w.id), workspace: w.name, error: e.message });
      }
    }
    res.json({ q, matches: hits.length, hits, scanned });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Diff a posted list against the mailbox cache. Body: { emails: [...] }.
// Returns which of YOUR emails are missing from the dashboard, and which extra
// emails the dashboard has that aren't in your list.
app.post('/api/admin/mailbox-diff', requireAdmin, (req, res) => {
  const yours = new Set((req.body?.emails || []).map(e => String(e).trim().toLowerCase()).filter(Boolean));
  const dash = new Set((_mailboxCache.mailboxes || []).map(m => m.email));
  const missing = [...yours].filter(e => !dash.has(e)).sort();   // in your list, not on dashboard
  const extra   = [...dash].filter(e => !yours.has(e)).sort();   // on dashboard, not in your list
  res.json({
    your_count: yours.size,
    dashboard_count: dash.size,
    missing_from_dashboard: missing,
    extra_on_dashboard: extra,
  });
});

app.get('/api/admin/mailbox-debug', requireAdmin, async (req, res) => {
  if (!getBisonKey()) return res.status(400).json({ error: 'No Bison key configured' });
  try {
    const wsRaw = listBisonWorkspaces();
    const workspaces = Array.isArray(wsRaw) ? wsRaw : (wsRaw?.data || []);
    const PER_PAGE = 200;
    const perWorkspace = [];
    let total = 0;
    for (const w of workspaces) {
      let count = 0, pages = 0, firstPageLen = null, err = null, prevSig = '';
      try {
        for (let page = 1; page <= 300; page++) {
          const resp = await bisonReq('/api/sender-emails', { wsId: String(w.id), params: { per_page: PER_PAGE, page } });
          const list = Array.isArray(resp) ? resp : (resp?.data ?? []);
          if (page === 1) firstPageLen = list.length;
          if (!list.length) break;
          const sig = list.map(a => a.id ?? a.email ?? '').join(',');
          if (sig === prevSig) break; // Bison repeated the page → end
          prevSig = sig;
          count += list.length;
          pages = page;
        }
      } catch (e) { err = e.message; }
      total += count;
      perWorkspace.push({ team_id: String(w.id), name: w.name, count, pages, first_page_len: firstPageLen, error: err });
    }
    perWorkspace.sort((a, b) => b.count - a.count);
    res.json({ total, workspace_count: workspaces.length, per_page: PER_PAGE, workspaces: perWorkspace });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Stats id-mismatch diagnostic (admin only) ───────────
// For each active client: stored workspace_id, the canonical id the perf cache is
// keyed by, whether the cache actually has any data under each, frozen-leads count,
// and unibox_replies count under each id. Pinpoints clients (e.g. Bubble) whose
// stored id doesn't match the cache/portal so they read empty and drop off Stats.
app.get('/api/admin/stats-debug', requireAdmin, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    // ?probe=<workspace_id> — run the EXACT chart-stats fetch the warm loop does and
    // return the raw Bison response + any error, so a swallowed failure becomes visible.
    if (req.query.probe) {
      const wsId = String(req.query.probe);
      const today = serverDateString(new Date());
      const y = new Date(today + 'T00:00:00'); y.setDate(y.getDate() - 1);
      const out = { workspace_id: wsId, team_id: resolveBisonTeamId(wsId), has_ws_token: null };
      try { out.has_ws_token = !!getBisonWsToken(out.team_id); } catch {}
      // Single-day (today) — the old behaviour
      try {
        const single = await bisonFetch('/api/workspaces/v1.1/line-area-chart-stats', { wsId, params: { start_date: today, end_date: today } });
        out.single_day = { ok: true, labels: ((single.data || single) || []).map(s => ({ label: s.label, points: (s.dates || []).length })) };
      } catch (e) { out.single_day = { ok: false, error: e.message }; }
      // 7-day range — what every working caller uses
      try {
        const range = await bisonFetch('/api/workspaces/v1.1/line-area-chart-stats', { wsId, params: { start_date: serverDateString(y), end_date: today } });
        const pivot = pivotBisonStats((range.data || range) || []);
        out.range = { ok: true, dates: Object.keys(pivot), today_bucket: pivot[today] || null, agg: aggPvEmailStats(Object.values(pivot)) };
      } catch (e) { out.range = { ok: false, error: e.message }; }
      return res.json(out);
    }
    const clientRows = db.prepare(
      `SELECT workspace_id, workspace_name, client_status FROM clients WHERE workspace_id IS NOT NULL AND workspace_id != ''`
    ).all().filter(c => c.client_status !== 'inactive');
    const cacheHas = (id) => {
      for (const k of performanceCache.dailyStats.keys()) if (k.startsWith(id + '|')) return true;
      return false;
    };
    const out = [];
    for (const c of clientRows) {
      const canon = canonicalWorkspaceId(c.workspace_id, c.workspace_name);
      const leadsStored = (revenueCache.leads || []).filter(l => l.workspace_id === c.workspace_id).length;
      const leadsCanon  = (revenueCache.leads || []).filter(l => l.workspace_id === canon).length;
      let uniboxStored = null, uniboxCanon = null;
      if (pgdb) {
        try {
          const a = await pgdb.query(`SELECT COUNT(*)::int n FROM unibox_replies WHERE workspace_id = $1`, [c.workspace_id]);
          const b = await pgdb.query(`SELECT COUNT(*)::int n FROM unibox_replies WHERE workspace_id = $1`, [canon]);
          uniboxStored = a.rows[0].n; uniboxCanon = b.rows[0].n;
        } catch (e) { uniboxStored = 'err: ' + e.message; }
      }
      out.push({
        name: c.workspace_name,
        stored_id: c.workspace_id,
        canonical_id: canon,
        id_mismatch: canon !== c.workspace_id,
        cache_has_stored: cacheHas(c.workspace_id),
        cache_has_canonical: cacheHas(canon),
        leads_stored: leadsStored,
        leads_canonical: leadsCanon,
        unibox_stored: uniboxStored,
        unibox_canonical: uniboxCanon,
      });
    }
    out.sort((a, b) => (b.id_mismatch === a.id_mismatch ? 0 : b.id_mismatch ? 1 : -1));
    res.json({ count: out.length, cache_keys: performanceCache.dailyStats.size, clients: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Fresh start / Show historical (admin only) ───────────
// Status of the cutover + toggle.
app.get('/api/admin/fresh-start', requireAdmin, (req, res) => {
  res.json({ fresh_start_date: _freshStartDate, show_historical: _showHistorical });
});

// Enable fresh start "from now": record today's date as the cutover, so the
// dashboard defaults to showing only data from this point forward.
app.post('/api/admin/fresh-start', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const date = serverDateString(new Date());
    await pgdb.setSetting('fresh_start_date', date);
    await pgdb.setSetting('show_historical', false);
    _freshStartDate = date;
    _showHistorical = false;
    res.json({ ok: true, fresh_start_date: date, show_historical: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Flip the global "show historical" toggle (reveal/hide pre-cutover data).
app.post('/api/admin/show-historical', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const on = req.body && req.body.show === true;
    await pgdb.setSetting('show_historical', on);
    _showHistorical = on;
    res.json({ ok: true, show_historical: on });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Clear fresh start entirely (back to showing all data, no cutover).
app.delete('/api/admin/fresh-start', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    await pgdb.setSetting('fresh_start_date', '');
    await pgdb.setSetting('show_historical', false);
    _freshStartDate = null;
    _showHistorical = false;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Manager management (admin only) ──────────────────────
app.get('/api/admin/managers', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, name, commission_rate, base_salary, created_at FROM managers ORDER BY name').all());
});

app.put('/api/admin/managers/:id', requireAdmin, (req, res) => {
  const { commission_rate, base_salary } = req.body || {};
  if (commission_rate == null && base_salary == null)
    return res.status(400).json({ error: 'Nothing to update' });
  const updates = [];
  const params  = [];
  if (commission_rate != null) { updates.push('commission_rate=?'); params.push(parseFloat(commission_rate) || 0); }
  if (base_salary     != null) { updates.push('base_salary=?');     params.push(parseFloat(base_salary)     || 0); }
  params.push(req.params.id);
  db.prepare(`UPDATE managers SET ${updates.join(',')} WHERE id=?`).run(...params);
  res.json({ ok: true });
});

app.post('/api/admin/managers', requireAdmin, (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
  try {
    db.prepare('INSERT INTO managers (name, password_hash) VALUES (?,?)')
      .run(name.trim(), bcrypt.hashSync(password, 10));
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Name already exists' }); }
});

app.put('/api/admin/managers/:id/password', requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  db.prepare('UPDATE managers SET password_hash=? WHERE id=?')
    .run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/managers/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM managers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Payslips ─────────────────────────────────────────────────
// Files arrive as base64 in JSON body — no multer dependency needed.
app.post('/api/admin/payslips', requireAdmin, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
    const { manager_name, month, filename, mimetype, data } = req.body || {};
    if (!manager_name || !month || !data) return res.status(400).json({ error: 'manager_name, month and data required' });
    await pgdb.upsertPayslip(manager_name, month, filename || 'payslip.pdf', mimetype || 'application/pdf', data);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/payslips', requireAdmin, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.json([]);
    res.json(await pgdb.listAllPayslips());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/payslips/:id', requireAdmin, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
    await pgdb.deletePayslip(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manager fetches their own payslip for a given month
app.get('/api/payslips/:month', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(404).json({ error: 'Not found' });
    const s = decodeSession(req);
    const name = s?.name || '';
    const row = await pgdb.getPayslip(name, req.params.month);
    if (!row) return res.status(404).json({ error: 'No payslip for this month' });
    const buf = Buffer.from(row.data, 'base64');
    res.setHeader('Content-Type', row.mimetype);
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Check if payslip exists for a month (no file data — just metadata)
app.get('/api/payslips/:month/meta', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.json({ exists: false });
    const s = decodeSession(req);
    const row = await pgdb.getPayslip(s?.name || '', req.params.month);
    res.json(row ? { exists: true, filename: row.filename, uploaded_at: row.uploaded_at } : { exists: false });
  } catch (err) { res.json({ exists: false }); }
});

// ── Manager page visibility ──────────────────────────────────
app.get('/api/admin/page-visibility', requireAdmin, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.json({});
    const val = await pgdb.getSetting('manager_page_visibility', {});
    res.json(val);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/page-visibility', requireAdmin, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
    await pgdb.setSetting('manager_page_visibility', req.body || {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Public (session-only) endpoint — nav.js calls this to know which pages to show.
app.get('/api/nav-settings', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.json({ pageVisibility: {} });
    const val = await pgdb.getSetting('manager_page_visibility', {});
    res.json({ pageVisibility: val });
  } catch (err) { res.json({ pageVisibility: {} }); }
});

// ── Reset the reply-intelligence side effects ───────────────
// Wipes vertical snoozes and reply-intelligence notes set by the old
// over-active parser. Deliberately leaves do_not_contact intact —
// 'remove me' replies that legitimately set DNC should stand.
// Diagnostic: what's actually in revenue_leads — grouped by client + insert
// timestamp, so we can spot bad batches (e.g. 15 leads inserted at the same
// second = a misattributed/test batch, not real leads).
app.get('/api/admin/revenue-leads-debug', requireAdmin, async (req, res) => {
  const dbPg = app.locals.pgDb;
  if (!dbPg) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const byClient = await dbPg.query(`
      SELECT workspace_id, client_name,
             COUNT(*)::int AS leads,
             COUNT(*) FILTER (WHERE pv_nonlead) ::int AS nonleads,
             MIN(date) AS first_date, MAX(date) AS last_date,
             MIN(updated_at) AS first_seen, MAX(updated_at) AS last_seen
      FROM revenue_leads
      GROUP BY workspace_id, client_name
      ORDER BY leads DESC
    `);
    // Suspicious batches: many leads sharing the exact same updated_at second.
    const batches = await dbPg.query(`
      SELECT client_name, date_trunc('second', updated_at) AS inserted_at, COUNT(*)::int AS n
      FROM revenue_leads
      GROUP BY client_name, date_trunc('second', updated_at)
      HAVING COUNT(*) >= 5
      ORDER BY n DESC
      LIMIT 50
    `);
    const total = await dbPg.query(`SELECT COUNT(*)::int AS n FROM revenue_leads`);
    res.json({ total: total.rows[0].n, by_client: byClient.rows, suspicious_batches: batches.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a bad batch: revenue_leads for a client inserted within the same second
// (updated_at). Optionally scope to a workspace_id for precision. Use after
// inspecting /revenue-leads-debug. Returns count.
app.post('/api/admin/revenue-leads-purge-batch', requireAdmin, async (req, res) => {
  const dbPg = app.locals.pgDb;
  if (!dbPg) return res.status(503).json({ error: 'DB unavailable' });
  const { client_name, inserted_at, workspace_id } = req.body || {};
  if (!client_name || !inserted_at) return res.status(400).json({ error: 'client_name and inserted_at (a second timestamp) required' });
  try {
    const params = [client_name, inserted_at];
    let sql = `DELETE FROM revenue_leads
        WHERE client_name = $1 AND date_trunc('second', updated_at) = $2::timestamp`;
    if (workspace_id) { params.push(workspace_id); sql += ` AND workspace_id = $3`; }
    const r = await dbPg.query(sql, params);
    refreshRevenueCache().catch(() => {});
    res.json({ ok: true, deleted: r.rowCount || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Targeted cleanup: revenue_leads keyed by a Bison NUMERIC team_id instead of the
// canonical PV workspace_id are phantom rows written by the (now-removed) broken
// live-fetch. Real workspace_ids are long hex strings; Bison team ids are short
// integers. GET previews (paste in browser address bar); POST deletes.
async function previewNumericWsLeads(dbPg) {
  const r = await dbPg.query(`SELECT workspace_id, client_name, COUNT(*)::int AS n FROM revenue_leads WHERE workspace_id ~ '^[0-9]+$' GROUP BY workspace_id, client_name`);
  return r.rows;
}
// GET = safe preview (no delete). Open this URL in your browser to check first.
app.get('/api/admin/revenue-leads-purge-numeric-ws', requireAdmin, async (req, res) => {
  const dbPg = app.locals.pgDb;
  if (!dbPg) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const rows = await previewNumericWsLeads(dbPg);
    const total = rows.reduce((s, r) => s + r.n, 0);
    res.json({ preview_only: true, would_delete_total: total, would_delete: rows,
      note: 'Nothing deleted. To actually delete, POST to this same URL.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// POST = actually delete.
app.post('/api/admin/revenue-leads-purge-numeric-ws', requireAdmin, async (req, res) => {
  const dbPg = app.locals.pgDb;
  if (!dbPg) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const groups = await previewNumericWsLeads(dbPg);
    const r = await dbPg.query(`DELETE FROM revenue_leads WHERE workspace_id ~ '^[0-9]+$'`);
    refreshRevenueCache().catch(() => {});
    res.json({ ok: true, deleted: r.rowCount || 0, groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sync-leads-to-portal — RETIRED.
// Historical PV leads are backfilled directly via SQL from the revenue_leads
// table (the authoritative source the admin counts) into esp_leads. The earlier
// cache/SQLite-based versions pulled the wrong/empty sources and could write
// Bison test leads as plusvibe, so this is disabled. See revenue_leads backfill.
app.post('/api/admin/sync-leads-to-portal', requireAdmin, async (req, res) => {
  return res.status(410).json({ error: 'Retired — historical leads are backfilled via SQL from revenue_leads.' });
  // eslint-disable-next-line no-unreachable
  const dbPg = app.locals.pgDb;
  if (!dbPg) return res.status(500).json({ error: 'DB not available' });
  // Same non-lead exclusion the admin uses (NON_LEAD / WEAK_LEAD / Non Lead…).
  const NON_LEAD = /(^|[_\-\s])non([_\-\s]?lead)?([_\-\s]|$)/i;
  try {
    // Source = the IN-MEMORY labeled-leads cache (what the admin dashboard
    // displays). The perf_cache_leads TABLE is unreliable (its save fails), so
    // we read performanceCache.labeledLeads directly. Ensure every active client
    // workspace is populated first so nothing is missed.
    let wsIds = [];
    try {
      wsIds = db.prepare(
        `SELECT workspace_id FROM clients WHERE workspace_id IS NOT NULL AND workspace_id != '' AND (client_status IS NULL OR client_status != 'inactive')`
      ).all().map(r => r.workspace_id);
    } catch { /* fall back to whatever's cached */ }
    try { await ensurePerformanceLabeledLeads(wsIds, performanceCache.labeledLeads, false); } catch (e) {
      console.warn('[sync-leads-to-portal] ensure cache failed (using existing):', e.message);
    }

    let synced = 0, skipped = 0;
    const perWs = {};
    for (const [wsId, val] of performanceCache.labeledLeads) {
      const leads = Array.isArray(val?.data) ? val.data : [];
      const seen = new Set();
      for (const l of leads) {
        const email = (l.email || '').toString().trim().toLowerCase();
        const label = String(l.label || '');
        if (!wsId || !email.includes('@')) { skipped++; continue; }
        if (l._pv_nonlead || NON_LEAD.test(label)) { skipped++; continue; } // exclude non-leads
        if (seen.has(email)) { skipped++; continue; }                       // dedup within workspace
        seen.add(email);
        const id = String(l._id || l.id || `${wsId}:${email}`);
        try {
          await dbPg.query(
            `INSERT INTO esp_leads
               (id, source, workspace_id, campaign_id, email, first_name, last_name,
                company_name, status, label, created_at, updated_at, raw, synced_at)
             VALUES ($1,'plusvibe',$2,$3,$4,$5,$6,$7,'INTERESTED','INTERESTED',$8,$8,$9,now())
             ON CONFLICT (id, source) DO UPDATE SET
               status='INTERESTED', label='INTERESTED',
               email=EXCLUDED.email, first_name=EXCLUDED.first_name,
               last_name=EXCLUDED.last_name, company_name=EXCLUDED.company_name,
               synced_at=now()`,
            [id, wsId, l.campaign_id || null, email,
             l.first_name || null, l.last_name || null, l.company_name || l.company || null,
             l.created_at || l.date || new Date().toISOString(), JSON.stringify(l)]
          );
          synced++;
          perWs[wsId] = (perWs[wsId] || 0) + 1;
        } catch (e) { skipped++; }
      }
    }
    console.log(`[sync-leads-to-portal] synced ${synced}, skipped ${skipped}, across ${Object.keys(perWs).length} workspace(s)`);
    res.json({ ok: true, synced, skipped, workspaces: Object.keys(perWs).length, perWorkspace: perWs });
  } catch (err) {
    console.error('[sync-leads-to-portal]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/clear-snoozes', requireAdmin, async (req, res) => {
  try {
    const dbPg = app.locals.pgDb;
    if (!dbPg) return res.status(503).json({ error: 'Postgres not available' });
    const r = await dbPg.query(`
      UPDATE contacts
         SET snoozed_verticals = '[]'::jsonb,
             reply_notes = NULL,
             updated_at = CURRENT_TIMESTAMP
       WHERE (snoozed_verticals IS NOT NULL AND snoozed_verticals <> '[]'::jsonb)
          OR reply_notes IS NOT NULL
    `);
    console.log(`[admin] cleared snoozes + reply notes on ${r.rowCount} contacts`);
    res.json({ ok: true, updated: r.rowCount });
  } catch (err) {
    console.error('[admin] clear-snoozes', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Manager commission payments ───────────────────────────
app.get('/api/admin/commission-payments', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT manager_name, period_start, period_end, status, payslip_name, payslip_type,
           payslip_data, paid_at, updated_at
    FROM manager_commission_payments
    ORDER BY period_start DESC, manager_name
  `).all());
});

app.put('/api/admin/commission-payments', requireAdmin, (req, res) => {
  const { manager_name, period_start, period_end, status, payslip_name, payslip_type, payslip_data } = req.body || {};
  if (!manager_name || !period_start || !period_end) return res.status(400).json({ error: 'Missing payment key' });
  const cleanStatus = status === 'paid' ? 'paid' : 'unpaid';
  db.prepare(`
    INSERT INTO manager_commission_payments
      (manager_name, period_start, period_end, status, payslip_name, payslip_type, payslip_data, paid_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ?='paid' THEN datetime('now') ELSE NULL END, datetime('now'))
    ON CONFLICT(manager_name, period_start, period_end) DO UPDATE SET
      status=excluded.status,
      payslip_name=excluded.payslip_name,
      payslip_type=excluded.payslip_type,
      payslip_data=excluded.payslip_data,
      paid_at=CASE WHEN excluded.status='paid' THEN COALESCE(manager_commission_payments.paid_at, datetime('now')) ELSE NULL END,
      updated_at=datetime('now')
  `).run(
    manager_name.trim(), period_start, period_end, cleanStatus,
    payslip_name || '', payslip_type || '', payslip_data || '', cleanStatus
  );
  res.json({ ok: true });
});

app.get('/api/admin/commission-adjustments', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT id, manager_name, label, amount, active, created_at
    FROM manager_commission_adjustments
    ORDER BY active DESC, manager_name, label
  `).all());
});

app.post('/api/admin/commission-adjustments', requireAdmin, (req, res) => {
  const { manager_name, label, amount } = req.body || {};
  const cleanManager = (manager_name || '').trim();
  const cleanLabel = (label || '').trim();
  const cleanAmount = parseFloat(amount);
  if (!cleanManager || !cleanLabel || !Number.isFinite(cleanAmount)) {
    return res.status(400).json({ error: 'Manager, label and amount are required' });
  }
  db.prepare(`
    INSERT INTO manager_commission_adjustments (manager_name, label, amount, active)
    VALUES (?, ?, ?, 1)
  `).run(cleanManager, cleanLabel, cleanAmount);
  res.json({ ok: true });
});

app.put('/api/admin/commission-adjustments/:id', requireAdmin, (req, res) => {
  const { manager_name, label, amount, active } = req.body || {};
  const updates = [];
  const vals = [];
  if (manager_name !== undefined) { updates.push('manager_name = ?'); vals.push((manager_name || '').trim()); }
  if (label !== undefined) { updates.push('label = ?'); vals.push((label || '').trim()); }
  if (amount !== undefined) { updates.push('amount = ?'); vals.push(parseFloat(amount) || 0); }
  if (active !== undefined) { updates.push('active = ?'); vals.push(active ? 1 : 0); }
  if (updates.length) {
    db.prepare(`UPDATE manager_commission_adjustments SET ${updates.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/commission-adjustments/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM manager_commission_adjustments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Auth ───────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });
  const c = db.prepare('SELECT * FROM clients WHERE username = ?').get(username);
  if (!c || !bcrypt.compareSync(password, c.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign(
    { id: c.id, workspace_id: c.workspace_id, workspace_name: c.workspace_name, username: c.username },
    JWT_SECRET, { expiresIn: '7d' }
  );
  res.json({ token, workspace_name: c.workspace_name, username: c.username });
});

// ── Webhook — receives leads from N8n ──────────────────────
app.post('/webhook/lead', (req, res) => {
  const payload = Array.isArray(req.body) ? req.body[0]?.body : req.body;
  if (!payload?.workspace_id || !payload?._id)
    return res.status(400).json({ error: 'Missing workspace_id or _id' });

  const existing = db.prepare('SELECT status, closed_value FROM leads WHERE id = ?').get(payload._id);
  if (existing) {
    db.prepare('UPDATE leads SET workspace_id = ?, data = ? WHERE id = ?')
      .run(payload.workspace_id, JSON.stringify(payload), payload._id);
  } else {
    db.prepare('INSERT INTO leads (id, workspace_id, data, received_at) VALUES (?, ?, ?, datetime(\'now\'))')
      .run(payload._id, payload.workspace_id, JSON.stringify(payload));
  }
  console.log(`Lead received: ${payload.first_name} ${payload.last_name} → ${payload.workspace_name}`);
  res.json({ ok: true });
});

// ── Client stats ───────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
  const delivered = db.prepare(
    `SELECT COUNT(*) as n FROM leads WHERE workspace_id = ? AND (status = 'active' OR status IS NULL)`
  ).get(c.workspace_id).n;
  const closed = db.prepare(
    `SELECT COALESCE(SUM(closed_value),0) as t FROM leads WHERE workspace_id = ? AND (status = 'active' OR status IS NULL)`
  ).get(c.workspace_id).t;
  const spent     = delivered * (c.price_per_lead || 0);
  const remaining = Math.max(0, (c.plan_leads || 0) - delivered);
  const roi       = spent > 0 ? Math.round(closed / spent * 100) : null;
  res.json({
    delivered,
    remaining,
    plan_leads:     c.plan_leads     || 0,
    spent,
    price_per_lead: c.price_per_lead || 0,
    closed_value:   closed,
    roi,
  });
});

// ── Client leads list ──────────────────────────────────────
app.get('/api/leads', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, workspace_id, data, closed_value, status, received_at
    FROM leads WHERE workspace_id = ?
    ORDER BY received_at DESC
  `).all(req.client.workspace_id);

  res.json(rows.map(r => {
    const d = JSON.parse(r.data);
    return {
      id:              r.id,
      received_at:     r.received_at,
      status:          r.status || 'active',
      closed_value:    r.closed_value,
      first_name:      d.first_name,
      last_name:       d.last_name,
      company_name:    d.company_name,
      email:           d.email,
      job_title:       d.job_title,
      city:            d.city,
      country:         d.country,
      phone:           d.phone_number || d.phone || '',
      website:         d.website      || '',
      linkedin:        d.linkedin_url || d.linkedin || '',
      sentiment:       d.sentiment,
      subject:         d.last_lead_reply_subject || d.latest_subject || '',
      snippet:         (d.text_body || '').substring(0, 120),
      last_reply_html: d.last_lead_reply || d.latest_message || '',
      campaign_name:   d.campaign_name || '',
      email_account:   d.email_account_name || '',
      last_email_id:   d.last_email_id,
      last_thread_id:  d.last_thread_id,
      workspace_id:    d.workspace_id,
    };
  }));
});

// ── Leads analysis — individual lead rows (admin/manager) ──
app.get('/api/leads/analysis', requireSession, async (req, res) => {
  const { workspace_id } = req.query;
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

  let raw = [];
  try {
    const cached = performanceCache?.labeledLeads?.get(workspace_id);
    if (cached && Date.now() - cached.savedAt < PERF_LEADS_TTL_MS) {
      raw = cached.data || [];
    } else {
      raw = await fetchPerformanceLabeledLeads(workspace_id);
    }
  } catch(e) {
    return res.status(502).json({ error: 'PlusVibe fetch failed: ' + e.message });
  }

  function cv(lead, key) {
    const vars = lead.custom_variables || lead.customVariables;
    if (!vars) return null;
    if (Array.isArray(vars)) {
      const found = vars.find(v => String(v.name||v.key||'').toLowerCase() === key.toLowerCase());
      return found ? String(found.value || '').trim() || null : null;
    }
    if (typeof vars === 'object') {
      const val = vars[key] || vars[key.toLowerCase()];
      return val ? String(val).trim() || null : null;
    }
    return null;
  }

  function empBucket(lead) {
    const n = parseInt(lead.num_employees || lead.estimated_num_employees || cv(lead, 'num_employees') || cv(lead, 'estimated_num_employees') || 0, 10);
    if (!n) return null;
    if (n <= 10)   return '1–10';
    if (n <= 50)   return '11–50';
    if (n <= 200)  return '51–200';
    if (n <= 500)  return '201–500';
    if (n <= 1000) return '501–1,000';
    if (n <= 5000) return '1,001–5,000';
    return '5,000+';
  }

  const qualifiedLeads = raw.filter(l => !isPvNonLeadLabel(l.label) && !l._pv_nonlead);
  const emails = [...new Set(qualifiedLeads.map(l => (l.email||'').toLowerCase()).filter(Boolean))];

  // ── Enrich from Postgres contacts (seniority, num_employees, department) ──
  const pgMap = {};
  const pgdb = req.app.locals.pgDb;
  if (pgdb && emails.length) {
    try {
      const { rows: contacts } = await pgdb.query(
        `SELECT LOWER(email) AS email, seniority, num_employees, department, sub_departments, job_title_cleaned
         FROM contacts WHERE LOWER(email) = ANY($1::text[])`,
        [emails]
      );
      contacts.forEach(c => { pgMap[c.email] = c; });
    } catch(e) { console.warn('[leads/analysis] contacts enrich failed:', e.message); }
  }

  // ── Enrich subject from email_events + campaign_templates ──
  const subjectMap = {};
  if (pgdb && emails.length) {
    try {
      const { rows: subRows } = await pgdb.query(
        `SELECT DISTINCT ON (LOWER(ee.lead_email))
           LOWER(ee.lead_email) AS email, t.subject, t.body_excerpt AS snippet
         FROM email_events ee
         JOIN campaign_templates ct ON ct.content_hash = ee.content_hash AND ct.workspace_id = $1
         JOIN templates t ON t.content_hash = ee.content_hash
         WHERE LOWER(ee.lead_email) = ANY($2::text[])
           AND ee.event_type IN ('interested','lead','positive_reply','reply')
           AND t.subject IS NOT NULL
         ORDER BY LOWER(ee.lead_email), ee.event_at DESC`,
        [workspace_id, emails]
      );
      subRows.forEach(r => { subjectMap[r.email] = { subject: r.subject || '', snippet: r.snippet || '' }; });
    } catch(e) { console.warn('[leads/analysis] subject enrich failed:', e.message); }
  }

  // ── SQLite webhook fallback for subject/snippet ──
  const sqMap = {};
  try {
    db.prepare('SELECT data FROM leads WHERE workspace_id = ?').all(workspace_id).forEach(row => {
      try {
        const d = JSON.parse(row.data);
        if (d.email) sqMap[d.email.toLowerCase()] = {
          subject: d.last_lead_reply_subject || d.latest_subject || d.subject || '',
          snippet: (d.text_body || d.last_lead_reply || d.latest_message || '').slice(0, 200),
        };
      } catch {}
    });
  } catch {}

  const leads = qualifiedLeads.map(l => {
    const email = (l.email||'').toLowerCase();
    const pg = pgMap[email] || {};
    const sub = subjectMap[email] || sqMap[email] || {};
    return {
      id:           l._id || l.id || l.email,
      first_name:   l.first_name  || l.firstName  || '',
      last_name:    l.last_name   || l.lastName   || '',
      email:        l.email || '',
      company_name: l.company_name || l.companyName || '',
      job_title:    l.job_title || l.title || pg.job_title_cleaned || cv(l, 'job_title') || '',
      industry:     l.industry  || cv(l, 'industry')  || '',
      seniority:    l.seniority || pg.seniority || cv(l, 'seniority') || '',
      department:   l.department|| pg.department|| cv(l, 'department')|| '',
      company_size: empBucket(l) || (pg.num_employees ? empBucket({ num_employees: pg.num_employees }) : ''),
      city:         l.city    || cv(l, 'city')    || '',
      country:      l.country || cv(l, 'country') || '',
      campaign:     l.camp_name || l.campaign_name || l.campaignName || '',
      subject:      sub.subject || '',
      snippet:      (sub.snippet || '').slice(0, 200),
      label:        l.label || '',
      date:         l._pv_lead_date || l.lead_date || l.updatedAt || l.created_at || '',
    };
  });

  res.json({ total: leads.length, leads });
});

// ── Set closed deal value ──────────────────────────────────
app.post('/api/leads/:id/value', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id FROM leads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.client.workspace_id);
  if (!row) return res.status(404).json({ error: 'Lead not found' });
  const value = parseFloat(req.body?.value);
  if (isNaN(value) || value < 0) return res.status(400).json({ error: 'Invalid value' });
  db.prepare('UPDATE leads SET closed_value = ? WHERE id = ?').run(value, req.params.id);
  res.json({ ok: true });
});

// ── Submit non-lead request ────────────────────────────────
app.post('/api/leads/:id/nonlead', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM leads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.client.workspace_id);
  if (!row) return res.status(404).json({ error: 'Lead not found' });
  if (row.status === 'nonlead_pending')
    return res.status(400).json({ error: 'Request already pending' });
  if (row.status === 'nonlead')
    return res.status(400).json({ error: 'Already marked as not a lead' });
  const { reason } = req.body || {};
  if (!reason?.trim()) return res.status(400).json({ error: 'Reason required' });
  db.prepare(`UPDATE leads SET status = 'nonlead_pending' WHERE id = ?`).run(req.params.id);
  db.prepare(`INSERT INTO nonlead_requests (lead_id, client_id, workspace_id, reason) VALUES (?,?,?,?)`)
    .run(req.params.id, req.client.id, req.client.workspace_id, reason.trim());
  res.json({ ok: true });
});

// ── Full thread from EmailBison ──────────────────────────────
app.get('/api/leads/:id/thread', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT data FROM leads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.client.workspace_id);
  if (!row) return res.status(404).json({ error: 'Lead not found' });
  const lead = JSON.parse(row.data);
  try {
    var threadRaw = await bisonFetch('/api/replies/' + (lead.last_thread_id || lead.bison_reply_id) + '/conversation-thread', { wsId: lead.workspace_id });
    var threadMsgs = [].concat(threadRaw.data && threadRaw.data.older_messages || [], threadRaw.data && threadRaw.data.current_reply ? [threadRaw.data.current_reply] : [], threadRaw.data && threadRaw.data.newer_messages || []).map(function(m) { return { id: m.id, direction: m.folder === 'Sent' ? 'OUT' : 'IN', subject: m.subject, body: { html: m.html_body, text: m.text_body }, timestamp_created: m.date_received, from_address_email: m.from_email_address, to_address_email_list: m.primary_to_email_address, is_unread: m.read ? 0 : 1 }; });
    res.json({ source: 'bison', data: { messages: threadMsgs } });
  } catch {
    res.json({
      source: 'webhook',
      data: { messages: [{
        from:    lead.email,
        to:      lead.email_account_name,
        subject: lead.last_lead_reply_subject || '',
        body:    lead.last_lead_reply || lead.latest_message || '',
        date:    lead.modified_at,
      }] }
    });
  }
});

// ── Reply ──────────────────────────────────────────────────
app.post('/api/leads/:id/reply', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT data FROM leads WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.client.workspace_id);
  if (!row) return res.status(404).json({ error: 'Lead not found' });
  const lead   = JSON.parse(row.data);
  const { body } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: 'Reply body required' });
  const body_text = typeof body === 'string' ? body : (body && body.text) || '';
  try {
    var replyPayload = { message: (body && body.text) || body_text || '', content_type: 'text', reply_all: true };
    var replyRes = await bisonFetch('/api/replies/' + (lead.last_thread_id || lead.bison_reply_id) + '/reply', { wsId: lead.workspace_id, method: 'POST', body: replyPayload });
    res.json({ ok: true, result: replyRes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Stripe checkout session ────────────────────────────────
app.post('/api/stripe/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const qty = parseInt(req.body?.leads_count);
  if (!qty || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
  if (!c.price_per_lead) return res.status(400).json({ error: 'No price configured for this account. Contact support.' });

  let customerId = c.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { client_id: String(c.id), username: c.username }
    });
    customerId = customer.id;
    db.prepare('UPDATE clients SET stripe_customer_id = ? WHERE id = ?').run(customerId, c.id);
  }

  const session = await stripe.checkout.sessions.create({
    customer:             customerId,
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency:     'gbp',
        unit_amount:  Math.round(c.price_per_lead * 100),
        product_data: { name: `Ottaly Leads — ${qty} lead${qty > 1 ? 's' : ''}` },
      },
      quantity: qty,
    }],
    mode:        'payment',
    success_url: `${APP_URL}/client.html?payment=success`,
    cancel_url:  `${APP_URL}/client.html`,
    metadata:    { client_id: String(c.id), leads_count: String(qty) },
  });
  res.json({ url: session.url });
});

// ── Stripe customer portal ─────────────────────────────────
app.post('/api/stripe/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  const c = db.prepare('SELECT stripe_customer_id FROM clients WHERE id = ?').get(req.client.id);
  if (!c?.stripe_customer_id)
    return res.status(400).json({ error: 'No billing account yet. Make a purchase first.' });
  const session = await stripe.billingPortal.sessions.create({
    customer:   c.stripe_customer_id,
    return_url: `${APP_URL}/client.html`,
  });
  res.json({ url: session.url });
});

// ── Agency lead counts (uses SQLite received_at) ──────────
app.get('/api/agency/leads', (req, res) => {
  const { workspace_id, start_date, end_date } = req.query;
  if (!workspace_id || !start_date || !end_date)
    return res.status(400).json({ error: 'Missing params' });
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM leads
    WHERE workspace_id = ?
    AND (status IS NULL OR status NOT IN ('nonlead','nonlead_pending'))
    AND received_at IS NOT NULL
    AND date(received_at) >= date(?)
    AND date(received_at) <= date(?)
  `).get(workspace_id, start_date, end_date);
  res.json({ count: row.count });
});

// ── Client status (public — single source of truth for all pages) ──
app.get('/api/client-status', (req, res) => {
  const rows = db.prepare(`SELECT workspace_id, workspace_name, client_status, restart_date FROM clients`).all();
  res.json(rows);
});

app.post('/api/client-status/:id', requireAdmin, (req, res) => {
  const { client_status, restart_date } = req.body || {};
  if (!['active','inactive'].includes(client_status))
    return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`UPDATE clients SET client_status=?, restart_date=? WHERE id=?`)
    .run(client_status, restart_date || null, req.params.id);
  res.json({ ok: true });
  // Trigger immediate cache refreshes so change takes effect right away
  refreshRevenueCache().catch(() => {});
  refreshCampaignCache().catch(() => {});
});

// ── Workspace prices (public — used by Revenue page) ──────
app.get('/api/workspace-prices', (req, res) => {
  const rows = db.prepare(`SELECT workspace_id, workspace_name, price_per_lead, client_status, contact_name, campaign_manager, campaign_manager_2, commission_rate, manager_start_date FROM clients`).all();
  res.json(rows);
});

// ── Revenue leads cache (refreshed every 3 min server-side) ──
const LEAD_LABELS = ['LEAD', 'MEETING_BOOKED', 'MEETING_COMPLETED', 'CLOSED', 'ADDED_TO_ZOHO', 'AWAITING_REPLY', 'NON_LEAD', 'WEAK_LEAD'];
const NON_LEAD_LABEL_RE = /(^|[_\-\s])non([_\-\s]?lead)?([_\-\s]|$)/i;
const REVENUE_EXCLUDED_WORKSPACE_IDS = new Set([
  '690ee665bcb253de4fb44538', // Ottaly
  '69ce40f616a9cc965746b1a6', // Ottaly Test Account
]);
let revenueCache = { leads: [], updatedAt: null };

// ── Global PlusVibe rate limiter — max 1 request per 600ms across ALL caches ──
let _pvLastCall = 0;
const PV_MIN_GAP_MS = 600; // 100 req/min max → 600ms between calls

pvFetch = async function pvFetch(path, retries = 5, opts = {}) {
  // opts.method, opts.body — POSTs supply a JSON body. Default is GET.
  //
  // Bison migration: legacy callers do pvFetch('/workspaces'), but on Bison the
  // workspace list lives at /api/workspaces/v1.1 and returns { data: [...] } with
  // numeric ids. Redirect here so every caller (revenue/performance/campaign
  // caches, combo-analysis) keeps working — they already normalise the
  // { workspaces } / { data } / array shapes. Without this they 404 and the
  // dependent caches silently stop populating.
  if (path === '/workspaces') {
    // Bison returns numeric team ids, but the rest of the app keys workspaces by
    // the canonical PlusVibe workspace_id (stored in clients.workspace_id and in
    // BISON_TEAMS[].pv). Map each Bison team back to its PV id so client-status
    // filtering and revenue/campaign joins keep matching. Bison teams with no PV
    // mapping (BISON_TEAMS) are skipped — they aren't tracked as clients.
    const wsRaw = listBisonWorkspaces();
    const list = Array.isArray(wsRaw) ? wsRaw : (wsRaw?.data || []);
    const byTeamId = new Map(BISON_TEAMS.map(t => [String(t.team_id), t]));
    const workspaces = list
      .map(w => {
        const t = byTeamId.get(String(w.id));
        return t ? { id: t.pv, name: t.name, bison_team_id: String(w.id) } : null;
      })
      .filter(Boolean);
    return { workspaces };
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Enforce minimum gap between ALL PlusVibe requests
    const now = Date.now();
    const wait = _pvLastCall + PV_MIN_GAP_MS - now;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _pvLastCall = Date.now();

    const init = { headers: { 'Authorization': 'Bearer ' + getBisonKey() } };
    if (opts.body) {
      init.method = opts.method || 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    const _pvStart = Date.now();
    const r = await fetch(BISON_BASE + '/api' + path, init);
    const _pvMs = Date.now() - _pvStart;
    const _pvEndpoint = path.split('?')[0];
    // Log every 10th call (sampling) plus all non-200s to avoid DB pressure
    if (attempt === 0 && (_pvMs > 500 || !r.ok || Math.random() < 0.1)) {
      const { logSignal } = require('./api-diagnostics');
      logSignal({ signal_type: 'api_health', metric_key: `pv_latency_ms`, metric_value: _pvMs, unit: 'ms',
        status: _pvMs > 1000 ? 'critical' : _pvMs > 500 ? 'warning' : 'normal', notes: _pvEndpoint });
      if (!r.ok) logSignal({ signal_type: 'api_health', metric_key: `pv_http_${r.status}`,
        metric_value: 1, status: r.status === 429 ? 'warning' : 'critical', notes: _pvEndpoint });
    }
    if (r.ok) return r.json();
    if (r.status === 429) {
      const backoff = Math.min(Math.pow(2, attempt + 1) * 2000, 30000); // 4s, 8s, 16s, 30s max
      console.warn(`[PlusVibe] 429 on ${path} — backing off ${backoff/1000}s`);
      _pvLastCall = Date.now() + backoff; // block the queue during backoff
      await new Promise(res => setTimeout(res, backoff));
      continue;
    }
    throw new Error(`PlusVibe ${r.status}: ${path}`);
  }
  throw new Error(`PlusVibe 429: ${path} (gave up after ${retries} retries)`);
};

// Low-level switch (assumes caller already holds the Bison lock).
async function _bisonSwitchUnlocked(wsId) {
  // Resolve PV id -> team_id and refuse non-integer targets (see _bisonRaw): a
  // raw PV string switched to team_id NaN and left Bison on the wrong workspace.
  const teamId = resolveBisonTeamId(wsId);
  if (!teamId || !/^\d+$/.test(String(teamId))) {
    throw new Error('Bison switch refused: workspace "' + wsId + '" does not resolve to a Bison team_id (add it to BISON_TEAMS).');
  }
  if (_bisonWsId === String(teamId)) return;
  const sw = await fetch(BISON_BASE + '/api/workspaces/v1.1/switch-workspace', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + getBisonKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ team_id: Number(teamId) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!sw.ok) throw new Error('Bison switch-workspace ' + teamId + ' -> ' + sw.status);
  _bisonWsId = String(teamId);
}

// Standalone switch — serialized through the gate. Most callers now pass wsId
// straight to bisonFetch (which switches atomically with its fetch), so this is
// only needed when a later bisonFetch is called WITHOUT wsId and relies on the
// active workspace persisting. Even then it's gated so it can't race a cron.
async function bisonSwitch(wsId) {
  return withBisonLock(() => _bisonSwitchUnlocked(wsId));
}

async function bisonFetch(path, opts) {
  opts = opts || {};
  // Serialize switch+fetch as one atomic unit on the shared token (see _bisonGate).
  return withBisonLock(async () => {
    // Per-workspace token path (the logout fix, mirrors _bisonRaw): if the target
    // workspace has its own scoped token, use it as the bearer and DON'T switch —
    // so this cron call can't kick a human's Bison web-UI session.
    var bearer = getBisonKey();
    if (opts.wsId) {
      var teamId = resolveBisonTeamId(opts.wsId);
      var wsToken = teamId ? getBisonWsToken(teamId) : null;
      // POLICY: per-workspace work uses the workspace's own token; super-admin is
      // for minting only. No token yet? Mint one on demand (super-admin, allowed),
      // then use it. Only if minting fails do we fall back to the stateful switch.
      if (!wsToken && teamId) {
        try { wsToken = await mintBisonWsToken(teamId); }
        catch (e) { console.warn('[bison] on-demand mint (bisonFetch) team ' + teamId + ' failed:', e.message); }
      }
      if (wsToken) bearer = wsToken;
      else await _bisonSwitchUnlocked(opts.wsId);
    }
    var url = new URL(BISON_BASE + path);
    if (opts.params) {
      Object.keys(opts.params).forEach(function(k) {
        if (opts.params[k] !== undefined && opts.params[k] !== null) url.searchParams.set(k, String(opts.params[k]));
      });
    }
    var init = {
      method: opts.method || 'GET',
      headers: { 'Authorization': 'Bearer ' + bearer, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    };
    if (opts.body) init.body = JSON.stringify(opts.body);
    var r = await fetch(url.toString(), init);
    if (!r.ok) {
      var txt = await r.text().catch(function() { return ''; });
      throw new Error('Bison ' + path + ' -> ' + r.status + ': ' + txt.slice(0, 200));
    }
    return r.json();
  });
}

function normBisonWs(ws) {
  return { id: String(ws.id), name: ws.name };
}

function pivotBisonStats(bisonData) {
  var out = {};
  var labelMap = { 'Sent': 'total_sent_count', 'Replied': 'total_reply_count', 'Bounced': 'total_bounce_count', 'Total Opens': 'total_open_count', 'Interested': 'total_pos_reply_count' };
  (bisonData || []).forEach(function(series) {
    var field = labelMap[series.label];
    if (!field) return;
    (series.dates || []).forEach(function(pair) {
      var date = pair[0], count = pair[1];
      if (!out[date]) out[date] = { date: date, total_sent_count: 0, total_reply_count: 0, total_bounce_count: 0, total_open_count: 0, total_pos_reply_count: 0, total_ooo_reply_count: 0, total_contacted_count: 0 };
      out[date][field] = count;
    });
  });
  return out;
}

function normalizePvLabel(label) {
  return String(label || '').trim().replace(/\s+/g, '_').toUpperCase();
}

function isPvNonLeadLabel(label) {
  return NON_LEAD_LABEL_RE.test(String(label || ''));
}

function isRevenueExcludedWorkspace(value = {}) {
  const workspaceId = String(value.workspace_id || value.id || '').trim();
  const workspaceName = String(value.workspace_name || value.name || value.client_name || '').trim().toLowerCase();
  return REVENUE_EXCLUDED_WORKSPACE_IDS.has(workspaceId) || workspaceName === 'ottaly' || workspaceName.startsWith('ottaly ');
}

function stableLeadKey(workspaceId, lead) {
  return String(lead?._id || lead?.id || lead?.lead_id || `${workspaceId}:${(lead?.email || '').toLowerCase()}`);
}

function sourceLeadDate(lead) {
  return lead?.modified_at || lead?.created_at || lead?.createdAt || lead?.lead_created_at || lead?.added_at || lead?.date || null;
}

function getStableRevenueLeadDate(workspaceId, leadKey, email, sourceDate) {
  const existing = db.prepare('SELECT first_seen FROM revenue_lead_first_seen WHERE lead_key = ?').get(leadKey);
  // If PlusVibe gave us a source date (modified_at = when label was applied)
  // and it's older than what we have stored, the stored value is a stale
  // "we first saw this today" record from before we extracted modified_at.
  // Correct it so 90-day windows aren't flooded with historical leads.
  if (existing?.first_seen) {
    if (sourceDate) {
      const src = new Date(sourceDate).getTime();
      const cur = new Date(existing.first_seen).getTime();
      if (Number.isFinite(src) && Number.isFinite(cur) && src < cur) {
        db.prepare(`UPDATE revenue_lead_first_seen SET first_seen = ? WHERE lead_key = ?`)
          .run(sourceDate, leadKey);
        return sourceDate;
      }
    }
    return existing.first_seen;
  }
  const fallback = sourceDate || new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO revenue_lead_first_seen (lead_key, workspace_id, email, first_seen)
    VALUES (?, ?, ?, ?)
  `).run(leadKey, workspaceId, email || '', fallback);
  return db.prepare('SELECT first_seen FROM revenue_lead_first_seen WHERE lead_key = ?').get(leadKey)?.first_seen || fallback;
}

// One-shot: wipe revenue_lead_first_seen rows where first_seen is unrealistically
// recent given when the lead was actually labeled. The next refresh will rebuild
// them with correct dates from PV's modified_at. Runs once on boot.
let _firstSeenResetDone = false;
function resetStaleFirstSeenOnce() {
  if (_firstSeenResetDone) return;
  _firstSeenResetDone = true;
  try {
    // If 90%+ of records share the same first_seen date, they were almost
    // certainly written as a batch when modified_at wasn't being read.
    const all = db.prepare('SELECT first_seen FROM revenue_lead_first_seen').all();
    if (!all.length) return;
    const dayCounts = {};
    all.forEach(r => {
      const day = String(r.first_seen).slice(0, 10);
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    });
    const topDay = Object.entries(dayCounts).sort((a,b) => b[1] - a[1])[0];
    if (topDay[1] > all.length * 0.5) {
      // More than half the leads share one calendar day — clearly stale batch.
      const r = db.prepare(`DELETE FROM revenue_lead_first_seen WHERE first_seen LIKE ?`).run(topDay[0] + '%');
      console.log(`[revenue cache] reset ${r.changes} stale first_seen records all dated ${topDay[0]} — will rebuild with PV modified_at on next refresh`);
    }
  } catch (err) {
    console.warn('[revenue cache] reset stale first_seen failed:', err.message);
  }
}

async function refreshRevenueCache() {
  resetStaleFirstSeenOnce();
  try {
    // REVENUE = FROZEN STORAGE ONLY. The historical lead/revenue data lives in
    // the revenue_leads table (Postgres). We do NOT live-fetch leads from Bison
    // here: Bison leads have different IDs than the stored PlusVibe-era leads, so
    // merging them would double-count the same person and inflate revenue. New
    // leads enter revenue_leads via the reply webhook going forward. This keeps
    // the historical figure exact and stable. (Decision: 2026-06-14.)
    const pgdb = app.locals?.pgDb;
    const prices = db.prepare('SELECT workspace_id, workspace_name, price_per_lead, client_status FROM clients').all();
    const priceMap = {};
    const statusMap = {};
    const nameMap = {};
    prices.forEach(p => {
      priceMap[p.workspace_id]  = p.price_per_lead || 0;
      statusMap[p.workspace_id] = p.client_status || 'active';
      nameMap[p.workspace_id]   = p.workspace_name || '';
    });

    const leads = [];
    if (pgdb) {
      try {
        // Empty set → all stored leads (the method returns everything when the
        // live set is empty). This IS the revenue dataset now.
        const storedRows = await pgdb.getDeletedWorkspaceLeads(new Set());
        for (const row of storedRows) {
          if (isRevenueExcludedWorkspace({ id: row.workspace_id, name: row.client_name || row.workspace_name })) continue;
          leads.push({
            lead_key:        row.lead_key,
            client_name:     nameMap[row.workspace_id] || row.client_name || row.workspace_name || row.workspace_id,
            workspace_id:    row.workspace_id,
            campaign:        row.campaign    || '',
            first_name:      row.first_name  || '',
            last_name:       row.last_name   || '',
            lead_email:      row.lead_email  || '',
            // Use the current client price if set, else the price stored with the lead.
            lead_price:      (priceMap[row.workspace_id] ?? Number(row.lead_price)) || 0,
            label:           row.label       || '',
            date:            row.date        || '',
            client_inactive: statusMap[row.workspace_id] === 'inactive',
            pv_nonlead:      Boolean(row.pv_nonlead),
          });
        }
      } catch (err) {
        console.warn('[revenue cache] load from storage failed:', err.message);
      }
    }

    revenueCache = { leads, updatedAt: new Date().toISOString() };
    console.log(`[revenue cache] refreshed — ${leads.length} total leads (from storage)`);

    // Lead counts in workspace_stats come from revenueCache — recompute so
    // Capacity / Audience / Health show the latest numbers right away.
    if (typeof refreshAllWorkspaceStats === 'function') {
      refreshAllWorkspaceStats().catch(() => {});
    }
  } catch (err) {
    console.error('[revenue cache] refresh failed:', err.message);
  }
}

// Refresh on startup then every 3 minutes
setTimeout(refreshRevenueCache, 5000); // slight delay so server is fully up first
setInterval(refreshRevenueCache, 3 * 60 * 1000);

// GBP→ZAR rate cached server-side — browser calls this instead of hitting frankfurter directly
let _zarRateCache = { rate: null, fetchedAt: 0 };
app.get('/api/gbp-zar-rate', requireSession, async (req, res) => {
  const now = Date.now();
  if (_zarRateCache.rate && now - _zarRateCache.fetchedAt < 30 * 60 * 1000) {
    return res.json({ rate: _zarRateCache.rate, source: 'cache' });
  }
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const r = await fetch('https://api.frankfurter.app/latest?from=GBP&to=ZAR', { signal: controller.signal });
    clearTimeout(t);
    const d = await r.json();
    const rate = d?.rates?.ZAR;
    if (rate && rate > 0) { _zarRateCache = { rate, fetchedAt: now }; return res.json({ rate, source: 'live' }); }
  } catch {}
  res.json({ rate: _zarRateCache.rate || 23.5, source: 'fallback' });
});

// All-time average lead price — drives CM per-lead bonus (uses total history, not just last month)
app.get('/api/avg-lead-price', requireSession, (req, res) => {
  const overrides = db.prepare('SELECT email, active FROM nonlead_overrides').all();
  const nonleadMap = {};
  overrides.forEach(o => { nonleadMap[o.email.toLowerCase()] = o; });

  const livePrices = db.prepare('SELECT workspace_id, price_per_lead FROM clients').all();
  const livePriceMap = {};
  livePrices.forEach(p => { livePriceMap[p.workspace_id] = p.price_per_lead || 0; });

  // All leads (no date filter) — all-time average
  const leads = (revenueCache.leads || []).filter(l => {
    if (isRevenueExcludedWorkspace(l)) return false;
    const override  = nonleadMap[(l.lead_email || '').toLowerCase()];
    const pvNonlead = Boolean(l.pv_nonlead || isPvNonLeadLabel(l.label));
    return !(override?.active || pvNonlead);
  });

  const totalRevenue = leads.reduce((s, l) => s + (livePriceMap[l.workspace_id] ?? l.lead_price ?? 0), 0);
  const totalLeads   = leads.length;
  const avg          = totalLeads > 0 ? totalRevenue / totalLeads : 0;

  // Managers need avg_lead_price_gbp for commission, but must NOT see
  // agency-wide revenue totals (policy: managers ≠ Revenue/Finance). Strip the
  // aggregate figures for non-admins; commission.html only reads avg_lead_price_gbp.
  const isAdmin = decodeSession(req)?.role === 'admin';
  const payload = { avg_lead_price_gbp: parseFloat(avg.toFixed(2)), period: 'all-time' };
  if (isAdmin) {
    payload.total_leads = totalLeads;
    payload.total_revenue = parseFloat(totalRevenue.toFixed(2));
  }
  res.json(payload);
});

app.get('/api/revenue/leads', requireSession, (req, res) => {
  // Apply non-lead overrides from SQLite
  const overrides = db.prepare(`SELECT email, reason, marked_at, active FROM nonlead_overrides`).all();
  const nonleadMap = {};
  overrides.forEach(o => { nonleadMap[o.email.toLowerCase()] = o; });

  // Always use current price from DB — never trust cached lead_price
  const currentPrices = db.prepare('SELECT workspace_id, price_per_lead FROM clients').all();
  const livePriceMap = {};
  currentPrices.forEach(p => { livePriceMap[p.workspace_id] = p.price_per_lead || 0; });

  const leads = (revenueCache.leads || []).filter(l => !isRevenueExcludedWorkspace(l)).map(l => {
    const o        = nonleadMap[(l.lead_email || '').toLowerCase()];
    const livePrice = livePriceMap[l.workspace_id] ?? l.lead_price ?? 0;
    const pvNonlead = Boolean(l.pv_nonlead || isPvNonLeadLabel(l.label));
    return {
      ...l,
      lead_price:     livePrice,
      is_nonlead:     o?.active || pvNonlead ? true : false,
      nonlead_reason: o?.active ? o.reason : (pvNonlead ? 'PlusVibe label: Non Lead' : ''),
      nonlead_date:   o?.active ? o.marked_at : (pvNonlead ? l.date : ''),
    };
  });
  res.json({ ...revenueCache, leads });
});

// Mark lead as non-lead
app.post('/api/nonlead/mark', (req, res) => {
  const { email, reason } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing email' });
  db.prepare(`INSERT INTO nonlead_overrides (email, reason, active) VALUES (?, ?, 1)
    ON CONFLICT(email) DO UPDATE SET reason=excluded.reason, marked_at=datetime('now'), active=1`)
    .run(email.toLowerCase(), reason || '');
  res.json({ ok: true });
});

// Restore lead to active
app.post('/api/nonlead/restore', (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing email' });
  db.prepare(`UPDATE nonlead_overrides SET active=0 WHERE email=?`).run(email.toLowerCase());
  res.json({ ok: true });
});

app.get('/api/revenue/stats-by-workspace', requireAdmin, (req, res) => {
  // Always use current price from DB so changing a price reflects immediately
  const currentPrices = db.prepare('SELECT workspace_id, price_per_lead FROM clients').all();
  const livePriceMap  = {};
  currentPrices.forEach(p => { livePriceMap[p.workspace_id] = p.price_per_lead || 0; });
  const manualNonleads = new Set(
    db.prepare(`SELECT email FROM nonlead_overrides WHERE active = 1`).all()
      .map(r => String(r.email || '').toLowerCase())
  );

  const counts = {};
  (revenueCache.leads || []).forEach(l => {
    if (isRevenueExcludedWorkspace(l)) return;
    if (manualNonleads.has(String(l.lead_email || '').toLowerCase())) return;
    if (l.pv_nonlead || isPvNonLeadLabel(l.label)) return;
    if (!counts[l.workspace_id]) counts[l.workspace_id] = { delivered: 0, revenue: 0 };
    counts[l.workspace_id].delivered++;
    counts[l.workspace_id].revenue += livePriceMap[l.workspace_id] ?? l.lead_price ?? 0;
  });
  res.json(counts);
});

// ── Performance cache (kept warm so filter changes are fast) ──
const performanceCache = {
  dailyStats: new Map(),
  labeledLeads: new Map(),
  warming: false,
  updatedAt: null,
  version: 0,
  lastStartedAt: null,
};
const PERF_TODAY_TTL_MS = 2 * 60 * 1000;   // today refreshes every ~2 min (live Bison)
const PERF_OLD_TTL_MS = 12 * 60 * 60 * 1000;
const PERF_LEADS_TTL_MS = 15 * 60 * 1000;
const PERF_WARM_INTERVAL_MS = 2 * 60 * 1000;
const EMPTY_PERF_AGG = { sent: 0, replies: 0, oooReplies: 0, posReplies: 0, bounces: 0, contacted: 0 };
let performanceWarmPromise = null;

function serverDateString(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

function serverDateList(startStr, endStr) {
  const out = [];
  const cur = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  while (cur <= end) {
    out.push(serverDateString(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function lastNDates(n) {
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - (n - 1));
  return serverDateList(serverDateString(start), serverDateString(today));
}

function aggPvEmailStats(stats) {
  // Always use chart (daily rows) — header is cumulative all-time totals, not per-day
  const rows = (Array.isArray(stats) ? stats : (stats?.chart || []));
  return rows.reduce((a, r) => ({
    sent:       a.sent       + (r.total_sent_count               || 0),
    replies:    a.replies    + (r.total_reply_count              || 0),
    oooReplies: a.oooReplies + (r.total_ooo_reply_count          || 0),
    posReplies: a.posReplies + (r.total_pos_reply_count          || 0),
    bounces:    a.bounces    + (r.total_bounce_count             || 0),
    contacted:  a.contacted  + (r.total_contacted_count || r.total_sent_count || 0),
  }), { sent: 0, replies: 0, oooReplies: 0, posReplies: 0, bounces: 0, contacted: 0 });
}

async function activePerformanceWorkspaces() {
  let clientRows = [];
  try { clientRows = db.prepare(`SELECT workspace_id, client_status FROM clients`).all(); } catch {}
  const [wsRaw] = await Promise.all([pvFetch('/workspaces')]);
  const inactiveIds = new Set(clientRows.filter(r => r.client_status === 'inactive').map(r => r.workspace_id));
  const workspaces = Array.isArray(wsRaw) ? wsRaw : (wsRaw?.workspaces || wsRaw?.data || []);
  return workspaces.filter(ws => !inactiveIds.has(ws.id));
}

// Reply data is sourced from the client-portal's CLASSIFIED unibox_replies table
// (reviewed, so warm-up/auto noise is excluded) instead of Bison's raw
// total_reply_count. We override the reply fields on the daily-stats aggregate for
// dates ON/AFTER the fresh-start cutover; before the cutover we keep the frozen
// historic (PlusVibe-era) numbers. sent/bounce/contacted always stay from Bison —
// the portal doesn't track sends. Leads are unchanged (revenueCache/esp_leads).
//
//   replies    = HUMAN replies  (interested + not_interested + question + unsubscribe)
//   oooReplies = ooo_auto_reply
//   posReplies = interested  (the "positive reply" the RTL view keys on)
//   warmup is EXCLUDED entirely.
//
// One batched query for all needed (wsId,date) pairs (keyed off received_at::date),
// so there's no per-day N+1. Returns Map "wsId|date" -> {replies,oooReplies,posReplies}.
async function fetchPortalReplyCounts(wsIds, dates) {
  const out = new Map();
  const pgdb = app.locals.pgDb;
  if (!pgdb || !wsIds.length || !dates.length) return out;
  // Only override dates at/after the cutover; before it, historic numbers stand.
  const cutover = _freshStartDate; // 'YYYY-MM-DD' or null
  const targetDates = cutover ? dates.filter(d => d >= cutover) : dates;
  if (!targetDates.length) return out;
  const minDate = targetDates.reduce((m, d) => (d < m ? d : m), targetDates[0]);
  const maxDate = targetDates.reduce((m, d) => (d > m ? d : m), targetDates[0]);
  try {
    const { rows } = await pgdb.query(
      `SELECT workspace_id AS ws,
              to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
              COUNT(*) FILTER (WHERE COALESCE(admin_label, category)
                       IN ('interested','not_interested','question','unsubscribe'))::int AS replies,
              COUNT(*) FILTER (WHERE COALESCE(admin_label, category) = 'ooo_auto_reply')::int AS ooo,
              COUNT(*) FILTER (WHERE COALESCE(admin_label, category) = 'interested')::int AS pos
         FROM unibox_replies
        WHERE workspace_id = ANY($1)
          AND received_at >= $2::date
          AND received_at <  ($3::date + interval '1 day')
        GROUP BY workspace_id, 2`,
      [wsIds, minDate, maxDate]
    );
    for (const r of rows) {
      out.set(`${r.ws}|${r.date}`, { replies: r.replies, oooReplies: r.ooo, posReplies: r.pos });
    }
  } catch (e) {
    console.warn('[performance cache] portal reply override query failed:', e.message);
  }
  return out;
}

async function ensurePerformanceDailyStats(wsIds, dates, dailyStats = performanceCache.dailyStats, forceDates = new Set()) {
  const today = serverDateString(new Date());
  // Build list of (wsId, date) pairs that actually need a fetch.
  const needed = [];
  for (const wsId of wsIds) {
    for (const date of dates) {
      const key = `${wsId}|${date}`;
      const cached = dailyStats.get(key);
      const ttl = date === today ? PERF_TODAY_TTL_MS : PERF_OLD_TTL_MS;
      if (forceDates.has(date) || !cached || Date.now() - cached.savedAt > ttl) needed.push({ wsId, date, key });
    }
  }
  // Fetch up to 8 at once — fast enough to feel instant, gentle on PlusVibe.
  const CONC = 8;
  for (let i = 0; i < needed.length; i += CONC) {
    await Promise.allSettled(needed.slice(i, i + CONC).map(async ({ wsId, date, key }) => {
      try {
        // MUST pass wsId so bisonFetch uses this workspace's per-workspace token
        // (or switches to it). Without it the call hit whatever workspace was
        // active -> stats for the wrong/no workspace -> "0 sent" on the Stats page.
        //
        // TODAY is special: Bison's line-area-chart-stats does NOT return a bucket
        // for the current (incomplete) day on a single-day start==end query, so the
        // per-day warm fetch came back empty and today showed 0/frozen while older
        // days were fine. Every other caller of this endpoint queries a RANGE, which
        // does include today. So for today we fetch a 2-day range (yesterday..today)
        // and pull today's bucket out of the pivot by its date key.
        var fetchStart = date, fetchEnd = date;
        if (date === today) {
          var y = new Date(date + 'T00:00:00'); y.setDate(y.getDate() - 1);
          fetchStart = serverDateString(y);
        }
        var bStats = await bisonFetch('/api/workspaces/v1.1/line-area-chart-stats', { wsId: wsId, params: { start_date: fetchStart, end_date: fetchEnd } });
        var pivot = pivotBisonStats((bStats.data || bStats) || []);
        // Single-day query -> all rows are that day; range query (today) -> keep only
        // today's bucket so we don't sum yesterday into today's totals.
        var rows = (fetchStart === fetchEnd) ? Object.values(pivot) : (pivot[date] ? [pivot[date]] : []);
        var agg = aggPvEmailStats(rows);
        // Today can legitimately be 0 early in the day, but an empty range response
        // (Bison hiccup) also yields 0 and would freeze a previously-good number for
        // a full TTL. If today comes back with no sends AND we already have a good
        // non-zero value, keep it and mark stale so the next 2-min pass retries.
        if (date === today && agg.sent === 0) {
          var prev = dailyStats.get(key);
          if (prev && prev.data && prev.data.sent > 0) {
            dailyStats.set(key, { savedAt: 0, data: prev.data });
            return;
          }
        }
        dailyStats.set(key, { savedAt: Date.now(), data: agg });
      } catch {
        // Fetch FAILED (429 exhausted / network / bad response). Do NOT cache a
        // zero — a poisoned 0 is indistinguishable from a real "0 sends" day and
        // the TTL would trust it for up to 12h, masking real data. Keep any prior
        // good value; if none exists, store zeros but mark stale (savedAt:0) so
        // the next pass retries instead of trusting the failure.
        if (!dailyStats.has(key)) {
          dailyStats.set(key, { savedAt: 0, data: { ...EMPTY_PERF_AGG } });
        }
      }
    }));
  }
  // Override reply fields with the portal's classified counts (post-cutover dates
  // only). sent/bounce/contacted stay from Bison. A missing portal entry for a
  // post-cutover (wsId,date) means zero real replies that day → set 0, don't keep
  // the raw Bison reply number (which would include warm-up/auto noise).
  try {
    const portal = await fetchPortalReplyCounts(wsIds, dates);
    const cutover = _freshStartDate;
    for (const wsId of wsIds) for (const date of dates) {
      if (cutover && date < cutover) continue; // historic: leave frozen
      const key = `${wsId}|${date}`;
      const entry = dailyStats.get(key);
      if (!entry || !entry.data) continue;
      const p = portal.get(key) || { replies: 0, oooReplies: 0, posReplies: 0 };
      entry.data = { ...entry.data, replies: p.replies, oooReplies: p.oooReplies, posReplies: p.posReplies };
    }
  } catch (e) {
    console.warn('[performance cache] portal reply override failed:', e.message);
  }
  const out = {};
  for (const wsId of wsIds) for (const date of dates) {
    const key = `${wsId}|${date}`;
    out[key] = dailyStats.get(key)?.data;
  }
  return out;
}

function performanceLeadDate(wsId, lead) {
  const leadKey = stableLeadKey(wsId, lead);
  const email = lead?.email || lead?.lead_email || '';
  return getStableRevenueLeadDate(wsId, leadKey, email, sourceLeadDate(lead));
}

function normalizePerformanceLead(wsId, lead, label) {
  return {
    ...lead,
    _pv_lead_date: performanceLeadDate(wsId, lead),
    _pv_nonlead: isPvNonLeadLabel(label) || isPvNonLeadLabel(lead?.label),
  };
}

async function fetchPerformanceLabeledLeads(wsId) {
  const leads = [];
  const seenIds = new Set();
  for (const label of LEAD_LABELS) {
    for (let page = 1; page <= 20; page++) {
      let batch = [];
      try {
        const raw_b = await bisonFetch('/api/leads', { wsId: wsId, params: { page: page, per_page: 100 } });
        batch = (raw_b.data || []).map(function(l) { return Object.assign({}, l, { _id: String(l.id), id: String(l.id), company_name: l.company || l.company_name, job_title: l.title || l.job_title, label: l.interested ? 'INTERESTED' : (l.status || '') }); });
      } catch { break; }
      if (!batch.length) break;
      batch.forEach(l => {
        const id = l._id || l.id || l.email;
        if (seenIds.has(id)) {
          const existing = leads.find(x => (x._id || x.id || x.email) === id);
          if (existing) {
            existing._pv_lead_date = existing._pv_lead_date || performanceLeadDate(wsId, l);
            if (isPvNonLeadLabel(label) || isPvNonLeadLabel(l.label)) existing._pv_nonlead = true;
          }
          return;
        }
        seenIds.add(id);
        leads.push(normalizePerformanceLead(wsId, l, label));
      });
      if (batch.length < 100) break;
    }
  }
  return leads;
}

async function ensurePerformanceLabeledLeads(wsIds, labeledLeads = performanceCache.labeledLeads, force = false) {
  // Fetch leads for 2 workspaces concurrently. Higher values trigger
  // PlusVibe 429s (8 labels × concurrent workspaces = too many requests).
  const needed = wsIds.filter(wsId => {
    const cached = labeledLeads.get(wsId);
    return force || !cached || Date.now() - cached.savedAt > PERF_LEADS_TTL_MS;
  });
  const CONC = 2;
  for (let i = 0; i < needed.length; i += CONC) {
    await Promise.allSettled(needed.slice(i, i + CONC).map(async wsId => {
      try {
        const data = await fetchPerformanceLabeledLeads(wsId);
        labeledLeads.set(wsId, { savedAt: Date.now(), data });
      } catch {
        labeledLeads.set(wsId, { savedAt: Date.now(), data: [] });
      }
    }));
  }
  const out = {};
  for (const wsId of wsIds) out[wsId] = labeledLeads.get(wsId)?.data || [];
  return out;
}

async function loadPerfCacheFromDb() {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return;
  try {
    const [dailyRows, leadsRows] = await Promise.all([
      pgdb.loadPerfCacheDaily(),
      pgdb.loadPerfCacheLeads(),
    ]);
    for (const row of dailyRows) {
      performanceCache.dailyStats.set(`${row.ws_id}|${row.date}`, {
        savedAt: Number(row.saved_at),
        data: row.data,
      });
    }
    for (const row of leadsRows) {
      performanceCache.labeledLeads.set(row.ws_id, {
        savedAt: Number(row.saved_at),
        data: row.data,
      });
    }
    if (dailyRows.length || leadsRows.length) {
      performanceCache.version++;
      console.log(`[performance cache] loaded ${dailyRows.length} daily + ${leadsRows.length} lead entries from DB`);
    }
  } catch (err) {
    console.warn('[performance cache] DB load failed (will fetch fresh):', err.message);
  }
}

async function savePerfCacheToDb() {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return;
  try {
    const dailyEntries = [];
    for (const [key, val] of performanceCache.dailyStats) {
      const [wsId, date] = key.split('|');
      dailyEntries.push({ wsId, date, data: val.data, savedAt: val.savedAt });
    }
    const leadsEntries = [];
    for (const [wsId, val] of performanceCache.labeledLeads) {
      leadsEntries.push({ wsId, data: val.data, savedAt: val.savedAt });
    }
    // Batch in chunks of 500 to avoid huge queries
    for (let i = 0; i < dailyEntries.length; i += 500)
      await pgdb.savePerfCacheDaily(dailyEntries.slice(i, i + 500));
    for (let i = 0; i < leadsEntries.length; i += 100)
      await pgdb.savePerfCacheLeads(leadsEntries.slice(i, i + 100));
  } catch (err) {
    console.warn('[performance cache] DB save failed:', err.message);
  }
}

async function warmPerformanceCache() {
  if (performanceWarmPromise) return performanceWarmPromise;
  performanceCache.warming = true;
  performanceCache.lastStartedAt = new Date().toISOString();
  performanceWarmPromise = (async () => {
    try {
      const workspaces = await activePerformanceWorkspaces();
      const wsIds = workspaces.map(ws => ws.id);
      const today = serverDateString(new Date());
      const fullWarmDates = [...new Set([
        ...lastNDates(30),
        ...serverDateList(`${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-01`, today),
      ])].sort();

      // Phase 1 — last 7 days only. Commit immediately so the Stats page
      // (default "7 Days" view) unblocks without waiting for the full 30-day fetch.
      const nextDailyStats = new Map(performanceCache.dailyStats);
      await ensurePerformanceDailyStats(wsIds, lastNDates(7), nextDailyStats);
      performanceCache.dailyStats = nextDailyStats;
      performanceCache.updatedAt = new Date().toISOString();
      console.log(`[performance cache] phase-1 ready (7d) — ${wsIds.length} workspaces`);

      // Phase 2 — remaining dates + labeled leads. nextDailyStats is the same
      // map reference now live in performanceCache, so entries appear as they arrive.
      await ensurePerformanceDailyStats(wsIds, fullWarmDates, nextDailyStats);
      performanceCache.updatedAt = new Date().toISOString();

      // Labeled leads — slowest fetch, only needed for Performance page.
      const nextLabeledLeads = new Map(performanceCache.labeledLeads);
      await ensurePerformanceLabeledLeads(wsIds, nextLabeledLeads);
      performanceCache.labeledLeads = nextLabeledLeads;
      performanceCache.version++;
      console.log(`[performance cache] version ${performanceCache.version} ready — ${wsIds.length} workspaces`);
      // Persist to DB so next restart loads instantly
      savePerfCacheToDb().catch(() => {});
    } catch (err) {
      console.error('[performance cache] warm failed:', err.message);
    } finally {
      performanceCache.warming = false;
      performanceWarmPromise = null;
    }
  })();
  return performanceWarmPromise;
}

// Load persisted cache from DB first so pages show data instantly on restart
setTimeout(async () => {
  await loadPerfCacheFromDb();
  // Then schedule the first warm to refresh today's data + fill any gaps
  setTimeout(warmPerformanceCache, 30000);
}, 10000);
// Keep warming every 2 min after that
setInterval(warmPerformanceCache, PERF_WARM_INTERVAL_MS);

function readReadyPerformanceCache(wsIds, dates) {
  const daily = {};
  const leads = {};
  for (const wsId of wsIds) {
    leads[wsId] = performanceCache.labeledLeads.get(wsId)?.data || [];
    for (const date of dates) {
      const key = `${wsId}|${date}`;
      daily[key] = performanceCache.dailyStats.get(key)?.data || { ...EMPTY_PERF_AGG };
    }
  }
  return { daily, leads };
}

async function buildRequestedPerformanceCache(wsIds, dates, forceLeads = false, forceDates = new Set()) {
  const nextDailyStats = new Map(performanceCache.dailyStats);
  const nextLabeledLeads = new Map(performanceCache.labeledLeads);
  await ensurePerformanceLabeledLeads(wsIds, nextLabeledLeads, forceLeads);
  await ensurePerformanceDailyStats(wsIds, dates, nextDailyStats, forceDates);
  performanceCache.dailyStats = nextDailyStats;
  performanceCache.labeledLeads = nextLabeledLeads;
  performanceCache.updatedAt = new Date().toISOString();
  performanceCache.version++;
  console.log(`[performance cache] version ${performanceCache.version} ready on demand — ${wsIds.length} workspaces`);
}

function hasReadyPerformanceCache(wsIds, dates) {
  if (performanceCache.version === 0) return false;
  return wsIds.every(wsId => performanceCache.labeledLeads.has(wsId))
    && wsIds.every(wsId => dates.every(date => performanceCache.dailyStats.has(`${wsId}|${date}`)));
}

async function ensureInitialPerformanceVersion(wsIds, dates) {
  if (performanceCache.version > 0) return;
  if (performanceWarmPromise) await performanceWarmPromise;
  if (performanceCache.version === 0) await buildRequestedPerformanceCache(wsIds, dates);
}

app.get('/api/performance/agency-cache', requireSession, async (req, res) => {
  const wsIds = String(req.query.workspace_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  const start = clampStartDate(String(req.query.start || ''));
  const end = String(req.query.end || '');
  if (!wsIds.length || !start || !end) return res.status(400).json({ error: 'Missing workspace_ids, start, or end' });
  try {
    const dates = serverDateList(start, end);
    if (!hasReadyPerformanceCache(wsIds, dates)) {
      // Race: either the cache becomes ready within 12 seconds, or we
      // return whatever's there so far. The client will retry (or show
      // the partial data) rather than hanging indefinitely.
      await Promise.race([
        buildRequestedPerformanceCache(wsIds, dates),
        new Promise(resolve => setTimeout(resolve, 12000))
      ]);
    }
    const { daily, leads } = readReadyPerformanceCache(wsIds, dates);
    if (!performanceCache.warming) setTimeout(warmPerformanceCache, 0);
    res.json({
      daily,
      leads,
      updatedAt: performanceCache.updatedAt,
      version: performanceCache.version,
      warming: performanceCache.warming,
      partial: !hasReadyPerformanceCache(wsIds, dates),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats page endpoint ──────────────────────────────────────
// Returns per-workspace daily stats + leads for the requested date range.
app.post('/api/stats/refresh', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (pgdb) await pgdb.clearPerfCache();
    performanceCache.dailyStats.clear();
    performanceCache.labeledLeads.clear();
    performanceCache.version = 0;
    performanceWarmPromise = null;
    warmPerformanceCache().catch(() => {});
    res.json({ ok: true, message: 'Cache cleared — refreshing from PlusVibe' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reuses the existing performance cache infrastructure so data is always
// warm and consistent with the Performance page.
// Per-workspace sent/replies/bounces/leads for a date range, computed from the
// SAME authoritative sources as the Stats page:
//   • sent / replies / bounces ← performanceCache.dailyStats (deduped PlusVibe email-stats)
//   • leads                    ← revenueCache.leads (with nonlead overrides + exclusions)
// Any page that needs these numbers (Stats summary, CM Performance) MUST use this
// so the totals always agree. Returns a map keyed by workspace_id.
function computeWorkspaceStatsForRange(wsIds, start, end) {
  const dates = serverDateList(start, end);
  const nonleadEmails = new Set(
    db.prepare(`SELECT email FROM nonlead_overrides WHERE active = 1`).all()
      .map(o => o.email.toLowerCase())
  );
  const out = {};
  for (const wsId of wsIds) {
    const wsLeads = (revenueCache.leads || []).filter(l => {
      // Match on the canonical id so leads stored under a mismatched workspace_id
      // (e.g. Bubble's webhook id) still attach to the right client. Cheap: most
      // leads already equal wsId and short-circuit on the first check.
      if (l.workspace_id !== wsId && canonicalWorkspaceId(l.workspace_id, l.workspace_name || l.client_name) !== wsId) return false;
      if (isRevenueExcludedWorkspace(l)) return false;
      if (nonleadEmails.has((l.lead_email || '').toLowerCase())) return false;
      if (l.pv_nonlead || isPvNonLeadLabel(l.label)) return false;
      const d = (l.date || '').slice(0, 10);
      return d >= start && d <= end;
    });
    const totals = { sent: 0, replies: 0, posReplies: 0, oooReplies: 0, bounces: 0, leads: wsLeads.length };
    const series = dates.map(date => {
      const d = performanceCache.dailyStats.get(`${wsId}|${date}`)?.data || { ...EMPTY_PERF_AGG };
      const dayLeads = wsLeads.filter(l => (l.date || '').slice(0,10) === date).length;
      totals.sent       += d.sent;
      totals.replies    += d.replies;
      totals.posReplies += d.posReplies;
      totals.oooReplies += d.oooReplies;
      totals.bounces    += d.bounces;
      return { date, sent: d.sent, replies: d.replies, posReplies: d.posReplies, oooReplies: d.oooReplies, bounces: d.bounces, leads: dayLeads };
    });
    const replyRate  = totals.sent    > 0 ? totals.replies / totals.sent    : 0;
    const bounceRate = totals.sent    > 0 ? totals.bounces / totals.sent    : 0;
    const rtl        = totals.replies > 0 ? totals.leads   / totals.replies : 0;
    const sendsPerDay   = dates.length > 0 ? totals.sent    / dates.length : 0;
    const repliesPerDay = dates.length > 0 ? totals.replies / dates.length : 0;
    out[wsId] = { totals: { ...totals, replyRate, bounceRate, rtl, sendsPerDay, repliesPerDay }, series };
  }
  return out;
}

app.get('/api/stats/summary', requireSession, async (req, res) => {
  const start = clampStartDate(String(req.query.start || ''));
  const end   = String(req.query.end   || '');
  if (!start || !end) return res.status(400).json({ error: 'start and end required (YYYY-MM-DD)' });
  try {
    // Use SQLite clients table — no PlusVibe API call needed.
    const clientRows = db.prepare(
      `SELECT workspace_id, workspace_name, client_status FROM clients WHERE workspace_id IS NOT NULL AND workspace_id != ''`
    ).all();
    const filterIds = req.query.workspace_ids ? String(req.query.workspace_ids).split(',').filter(Boolean) : null;
    const activeClients = clientRows.filter(c => {
      if (c.client_status === 'inactive') return false;
      if (filterIds) return filterIds.includes(c.workspace_id);
      return true;
    });
    // Key everything by the CANONICAL workspace_id (the id the perf cache is keyed
    // by). For most clients this equals clients.workspace_id; for rows whose stored
    // id doesn't match the cache (e.g. Bubble) it resolves via BISON_TEAMS so their
    // data is found instead of reading an empty bucket and being filtered out.
    const wsIds   = [...new Set(activeClients.map(c => canonicalWorkspaceId(c.workspace_id, c.workspace_name)))];
    const wsNames = Object.fromEntries(activeClients.map(c => [canonicalWorkspaceId(c.workspace_id, c.workspace_name), c.workspace_name]));
    const dates   = serverDateList(start, end);

    // Read whatever daily stats are already in the performance cache — no blocking PlusVibe fetch.
    // Stale or missing dates get back-filled in the background; the client retries on partial=true.
    const today = serverDateString(new Date());
    const daily = {};
    for (const wsId of wsIds) for (const date of dates) {
      const key = `${wsId}|${date}`;
      daily[key] = performanceCache.dailyStats.get(key)?.data || { ...EMPTY_PERF_AGG };
    }

    // partial = the page should keep its spinner because data is genuinely
    // MISSING (not merely stale). A present-but-old entry still renders fine and
    // refreshes in the background — only a total absence of data should block.
    //
    // A workspace with zero entries across the whole window is a non-PlusVibe
    // client (33 in SQLite vs ~30 fetched) — those never get data, so they must
    // not count toward "missing" or the spinner would hang forever.
    const wsHasAnyData = {};
    for (const wsId of wsIds) {
      wsHasAnyData[wsId] = dates.some(d => performanceCache.dailyStats.has(`${wsId}|${d}`));
    }
    const anyDataAtAll = performanceCache.dailyStats.size > 0;
    // Missing = a workspace that DOES have some data in range but is missing a
    // specific day. If nothing has loaded yet at all, treat as missing (spinner).
    const missing = !anyDataAtAll || wsIds.some(wsId =>
      wsHasAnyData[wsId] && dates.some(date => !performanceCache.dailyStats.has(`${wsId}|${date}`))
    );
    // Stale (present but past TTL) — refresh in the background, do NOT block.
    const anyStale = wsIds.some(wsId =>
      wsHasAnyData[wsId] && dates.some(date => {
        const cached = performanceCache.dailyStats.get(`${wsId}|${date}`);
        const ttl = date === today ? PERF_TODAY_TTL_MS : PERF_OLD_TTL_MS;
        return cached && Date.now() - cached.savedAt > ttl;
      })
    );
    const partial = missing;
    if ((missing || anyStale) && !performanceCache.warming) {
      // Background refresh; warmPerformanceCache fetches daily stats first.
      warmPerformanceCache().catch(() => {});
    }

    // Build per-workspace aggregated stats + per-day series from the shared
    // helper so Stats and CM Performance always agree.
    const wsStats = computeWorkspaceStatsForRange(wsIds, start, end);
    const workspaces = wsIds.map(wsId => ({
      workspace_id: wsId,
      name: wsNames[wsId] || wsId,
      totals: wsStats[wsId].totals,
      series: wsStats[wsId].series,
    })).filter(w => w.totals.sent > 0 || w.totals.leads > 0);

    workspaces.sort((a, b) => b.totals.replies - a.totals.replies);

    res.json({
      workspaces,
      dates,
      start,
      end,
      partial,
      updatedAt: performanceCache.updatedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Verification-split analytics (safe vs catch-all performance) ──────────────
app.get('/api/verify-split', requireSession, async (req, res) => {
  const start = clampStartDate(String(req.query.start || ''));
  const end   = String(req.query.end   || '');
  if (!start || !end) return res.status(400).json({ error: 'start and end required (YYYY-MM-DD)' });
  try {
    const pgdb = app.locals.pgDb;

    // Primary source: contacts table. Filter to contacts last-emailed in the
    // period so we see who was actually sent to. email_count = all-time sends
    // to this contact; replies/bounces/leads are filtered to the same window.
    const summaryQ = `
      SELECT
        COALESCE(email_status, 'unknown')                                       AS email_status,
        COUNT(*)::int                                                            AS unique_contacts,
        SUM(COALESCE(email_count, 0))::bigint                                   AS sent,
        COUNT(*) FILTER (WHERE last_reply_at >= $1)::int                        AS replies,
        COUNT(*) FILTER (WHERE bounced_at    >= $1)::int                        AS bounces,
        COUNT(*) FILTER (WHERE marked_as_lead_at >= $1
                            OR (status = 'interested' AND last_reply_at >= $1))::int AS leads
      FROM contacts
      WHERE last_emailed_at >= $1
        AND last_emailed_at < ($2::date + interval '1 day')
      GROUP BY COALESCE(email_status, 'unknown')
      ORDER BY sent DESC
    `;

    // Daily trend: contacts first emailed each day, split by verification type
    const dailyQ = `
      SELECT
        last_emailed_at::date                                                    AS day,
        COALESCE(email_status, 'unknown')                                       AS email_status,
        COUNT(*)::int                                                            AS contacts,
        SUM(COALESCE(email_count, 0))::bigint                                   AS sent,
        COUNT(*) FILTER (WHERE last_reply_at >= last_emailed_at)::int           AS replies,
        COUNT(*) FILTER (WHERE bounced_at    >= last_emailed_at)::int           AS bounces
      FROM contacts
      WHERE last_emailed_at >= $1
        AND last_emailed_at < ($2::date + interval '1 day')
        AND email_status IN ('safe', 'safe_catchall')
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;

    const [{ rows: summary }, { rows: daily }] = await Promise.all([
      pgdb.query(summaryQ, [start, end]),
      pgdb.query(dailyQ,   [start, end]),
    ]);

    res.json({ summary, daily, start, end });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sender × Recipient provider combo analysis ────────────────────────────

// Debug: show what top-level keys exist in raw JSONB + a sample record
app.get('/api/combo-analysis/debug', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
    const [keys, sample] = await Promise.all([
      pgdb.query(`
        SELECT key, COUNT(*)::int AS n
        FROM email_events, jsonb_object_keys(raw) AS key
        WHERE raw IS NOT NULL AND raw::text <> 'null' AND event_type = 'sent'
        GROUP BY key ORDER BY n DESC LIMIT 30
      `),
      pgdb.query(`
        SELECT raw FROM email_events
        WHERE raw IS NOT NULL AND raw::text <> 'null' AND event_type = 'sent'
        LIMIT 1
      `),
    ]);
    res.json({ keys: keys.rows, sample: sample.rows[0]?.raw || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Peek at raw PlusVibe email-stats response to find per-mailbox fields
app.get('/api/combo-analysis/pv-sample', requireSession, async (req, res) => {
  try {
    const wsRaw = await pvFetch('/workspaces');
    const workspaces = Array.isArray(wsRaw) ? wsRaw : (wsRaw?.workspaces || wsRaw?.data || []);
    const ws = workspaces[0];
    if (!ws) return res.json({ error: 'No workspaces found' });
    const today = new Date().toISOString().slice(0,10);
    const week  = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
    var bStats = await bisonFetch('/api/workspaces/v1.1/line-area-chart-stats', { wsId: ws.id, params: { start_date: week, end_date: today } });
    var raw = Object.values(pivotBisonStats((bStats.data || bStats) || []));
    res.json({ workspace_id: ws.id, workspace_name: ws.name, raw });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// Historical backfill: approximate FROM×TO combos from PlusVibe workspace stats
app.post('/api/combo-analysis/historical-backfill', requireSession, async (req, res) => {
  const days = Math.min(parseInt(req.body?.days || 90, 10), 365);
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });

    const endDate   = new Date();
    const startDate = new Date(Date.now() - days * 86400000);
    const start = startDate.toISOString().slice(0, 10);
    const end   = endDate.toISOString().slice(0, 10);

    const wsRaw    = await pvFetch('/workspaces');
    const workspaces = Array.isArray(wsRaw) ? wsRaw : (wsRaw?.workspaces || wsRaw?.data || []);

    let totalRows = 0;
    const results = [];

    for (const ws of workspaces) {
      try {
        // Mailbox type distribution for this workspace — use in-memory cache
        // (mailbox_meta is global and has no workspace_id column)
        const wsMailboxes = (_mailboxCache.mailboxes || []).filter(m => m.workspace_id === ws.id);
        const mboxTotal   = wsMailboxes.length;
        const fromDist    = mboxTotal > 0
          ? wsMailboxes.reduce((acc, m) => {
              const t = m.type || 'smtp';
              acc[t] = (acc[t] || 0) + 1 / mboxTotal;
              return acc;
            }, {})
          : { smtp: 1 };

        // Contact mx_provider distribution for this workspace
        const { rows: cRows } = await pgdb.query(`
          SELECT COALESCE(mx_provider,'unknown') AS prov, COUNT(*)::int AS n
          FROM contacts WHERE workspace_id = $1
          GROUP BY COALESCE(mx_provider,'unknown')
        `, [ws.id]);
        const cTotal  = cRows.reduce((s, r) => s + r.n, 0);
        const toDist  = cTotal > 0
          ? Object.fromEntries(cRows.map(r => [r.prov, r.n / cTotal]))
          : { unknown: 1 };

        // Fetch daily stats from Bison
        var bStats = await bisonFetch('/api/workspaces/v1.1/line-area-chart-stats', { wsId: ws.id, params: { start_date: start, end_date: end } });
        var pvData = Object.values(pivotBisonStats((bStats.data || bStats) || []));
        const chart  = Array.isArray(pvData) ? pvData : (pvData?.chart || []);

        for (const day of chart) {
          if (!day.date) continue;
          const sent    = day.total_sent_count    || 0;
          const replies = day.total_reply_count   || 0;
          const posRep  = day.total_pos_reply_count || 0;
          const bounces = day.total_bounce_count  || 0;
          if (!sent && !replies && !bounces) continue;

          for (const [fromType, fromPct] of Object.entries(fromDist)) {
            for (const [toType, toPct] of Object.entries(toDist)) {
              const split = fromPct * toPct;
              await pgdb.query(`
                INSERT INTO combo_history
                  (workspace_id, date, from_type, to_type, sent, replies, pos_replies, bounces)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                ON CONFLICT (workspace_id, date, from_type, to_type) DO UPDATE SET
                  sent        = EXCLUDED.sent,
                  replies     = EXCLUDED.replies,
                  pos_replies = EXCLUDED.pos_replies,
                  bounces     = EXCLUDED.bounces
              `, [ws.id, day.date, fromType, toType,
                  Math.round(sent * split),
                  Math.round(replies * split),
                  Math.round(posRep  * split),
                  Math.round(bounces * split)]);
              totalRows++;
            }
          }
        }
        results.push({ workspace: ws.name, days: chart.filter(d => d.total_sent_count > 0).length });
      } catch (err) {
        results.push({ workspace: ws.name, error: err.message });
      }
    }

    res.json({ ok: true, total_rows: totalRows, workspaces: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/combo-analysis/backfill', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });

    // First: show what keys actually exist in the raw field so we can find the sender
    const [keysRes, sampleRes] = await Promise.all([
      pgdb.query(`
        SELECT key, COUNT(*)::int AS n
        FROM email_events, jsonb_object_keys(raw) AS key
        WHERE raw IS NOT NULL AND raw::text <> 'null'
        GROUP BY key ORDER BY n DESC LIMIT 30
      `),
      pgdb.query(`
        SELECT raw FROM email_events
        WHERE raw IS NOT NULL AND raw::text <> 'null'
        LIMIT 1
      `),
    ]);

    const { rowCount } = await pgdb.query(`
      UPDATE email_events
      SET sender_email = LOWER(raw->>'sender_email')
      WHERE sender_email IS NULL
        AND raw IS NOT NULL
        AND raw::text <> 'null'
        AND raw->>'sender_email' IS NOT NULL
        AND (raw->>'seeded')::boolean IS NOT TRUE
    `);

    res.json({
      ok: true,
      updated: rowCount,
      raw_keys: keysRes.rows,
      sample_raw: sampleRes.rows[0]?.raw || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/combo-analysis/enrich-buckets', requireSession, async (req, res) => {
  enrichWorkspaceBuckets().catch(() => {});
  res.json({ ok: true, message: 'MX enrichment started in background' });
});

// Diagnostic: show how each event_type's rows are populated. Hit this once,
// share the JSON, and we'll see whether replies/leads are missing campaign_id
// or workspace_id (which would explain why send-anchored attribution
// finds 0 matches even though the events exist).
app.get('/api/combo-analysis/event-shape', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
    const { rows } = await pgdb.query(`
      SELECT event_type,
        COUNT(*)::int                                                        AS total,
        COUNT(*) FILTER (WHERE workspace_id IS NOT NULL)::int                AS with_workspace,
        COUNT(*) FILTER (WHERE campaign_id  IS NOT NULL)::int                AS with_campaign,
        COUNT(*) FILTER (WHERE lead_email   IS NOT NULL)::int                AS with_lead_email,
        COUNT(*) FILTER (WHERE event_at >= NOW() - interval '14 days')::int  AS last_14d
      FROM email_events
      GROUP BY event_type
      ORDER BY total DESC
    `);
    const { rows: sample } = await pgdb.query(`
      SELECT event_type, workspace_id, campaign_id, lead_email, event_at,
        jsonb_object_keys(raw) AS raw_key
      FROM email_events
      WHERE event_type IN ('reply','positive_reply','lead')
        AND event_at >= NOW() - interval '14 days'
      LIMIT 5
    `);
    res.json({ counts: rows, sample });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The earlier hard floor (2026-05-28) was over-restrictive — it was meant to
// keep out the inaccurate combo_history approx, but it also blocked real
// per-send webhook events from before that date. Approx is now permanently
// disabled (combo_history is no longer read), so real webhook data is safe
// to show from any date.

app.get('/api/combo-analysis', requireSession, async (req, res) => {
  const start = clampStartDate(String(req.query.start || ''));
  const end   = String(req.query.end   || '');
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });

    // Send-anchored attribution: cohort = sends in window; replies/bounces/
    // leads counted per matching (workspace_id, campaign_id, lead_email)
    // regardless of when those follow-up events landed. Uses EXISTS against
    // idx_ee_campaign (workspace_id, campaign_id, event_at) — every lookup is
    // a fast index probe, no full-table scan, no CTE join blowing the timeout.
    const exactQ = `
      WITH sender_types AS (
        SELECT DISTINCT ON (lower(email))
          lower(email) AS email_lower,
          COALESCE(mailbox_type, 'smtp') AS sender_type
        FROM mailbox_meta ORDER BY lower(email)
      ),
      recipient_types AS (
        SELECT DISTINCT ON (lower(email))
          lower(email) AS email_lower,
          mx_provider  AS recipient_type
        FROM contacts WHERE mx_provider IS NOT NULL ORDER BY lower(email)
      ),
      sends AS (
        SELECT ee.workspace_id, ee.campaign_id, lower(ee.lead_email) AS le,
          COALESCE(st.sender_type, 'smtp') AS from_type,
          COALESCE(
            rt.recipient_type,
            CASE ee.provider_bucket
              WHEN 'gmail'       THEN 'email_google'
              WHEN 'google'      THEN 'email_google'
              WHEN 'outlook'     THEN 'email_outlook'
              WHEN 'workspace'   THEN 'email_other'
              WHEN 'email_other' THEN 'email_other'
              WHEN 'unknown'     THEN 'unknown'
              ELSE               'email_other'
            END
          ) AS to_type
        FROM email_events ee
        LEFT JOIN sender_types    st ON st.email_lower = lower(ee.sender_email)
        LEFT JOIN recipient_types rt ON rt.email_lower = lower(ee.lead_email)
        WHERE ee.event_type = 'sent'
          AND ee.event_at >= $1 AND ee.event_at < ($2::date + interval '1 day')
          AND (ee.raw->>'seeded')::boolean IS NOT TRUE
      )
      SELECT s.from_type, s.to_type,
        COUNT(*)::int                                AS sent,
        -- Match follow-up events on (workspace_id, lead_email) — PlusVibe's
        -- reply/lead webhooks don't always include campaign_id, so requiring
        -- it produced 0 matches even when events existed. Within a workspace,
        -- a contact is typically in one campaign at a time, so this is
        -- accurate in practice. Bounces work either way.
        COUNT(DISTINCT CASE WHEN EXISTS (
          SELECT 1 FROM email_events e
          WHERE e.workspace_id = s.workspace_id
            AND lower(e.lead_email) = s.le
            AND e.event_type IN ('reply','positive_reply')
        ) THEN s.le END)::int                        AS replies,
        COUNT(DISTINCT CASE WHEN EXISTS (
          SELECT 1 FROM email_events e
          WHERE e.workspace_id = s.workspace_id
            AND lower(e.lead_email) = s.le
            AND e.event_type = 'positive_reply'
        ) THEN s.le END)::int                        AS pos_replies,
        COUNT(DISTINCT CASE WHEN EXISTS (
          SELECT 1 FROM email_events e
          WHERE e.workspace_id = s.workspace_id
            AND lower(e.lead_email) = s.le
            AND e.event_type = 'bounce'
        ) THEN s.le END)::int                        AS bounces,
        COUNT(DISTINCT CASE WHEN EXISTS (
          SELECT 1 FROM email_events e
          WHERE e.workspace_id = s.workspace_id
            AND lower(e.lead_email) = s.le
            AND e.event_type = 'lead'
        ) THEN s.le END)::int                        AS leads,
        COUNT(DISTINCT s.le)::int                    AS unique_contacts,
        FALSE                                        AS is_approx
      FROM sends s
      GROUP BY s.from_type, s.to_type
    `;

    // Exact webhook data only — the workspace-distribution approx was
    // inaccurate per user request (2026-05-28), so combo_history is no longer
    // blended in. The Historical Backfill button writes to combo_history but
    // we ignore it; left in place in case we revisit.
    const { rows: exact } = await pgdb.query(exactQ, [start, end]);
    const rows = exact
      .map(r => ({
        from_type: r.from_type, to_type: r.to_type,
        sent: +r.sent || 0, replies: +r.replies || 0, pos_replies: +r.pos_replies || 0,
        bounces: +r.bounces || 0, leads: +r.leads || 0, unique_contacts: +r.unique_contacts || 0,
        is_approx: false,
      }))
      .sort((a, b) => b.sent - a.sent);
    const hasApprox = rows.some(r => r.is_approx);

    // Coverage: how many non-seeded events have sender_email populated
    const { rows: cov } = await pgdb.query(`
      SELECT
        COUNT(*)                                          AS total,
        COUNT(*) FILTER (WHERE sender_email IS NOT NULL) AS with_sender
      FROM email_events
      WHERE event_at >= $1 AND event_at < ($2::date + interval '1 day')
        AND (raw->>'seeded')::boolean IS NOT TRUE
    `, [start, end]);

    res.json({ rows, coverage: cov[0], hasApprox, start, end });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Campaign intelligence cache (refreshed every 30 min) ─────
let campaignCache = { workspaces: [], targetingPatterns: [], optimisations: [], updatedAt: null };

function scoreCampaign(c, wsAvgReplyRate) {
  const sent = c.sent_count || 0;
  if (sent < 50) return { tier: 'new', replyRate: 0, posReplyRate: 0, leadRate: 0, flags: [] };
  const replyRate    = sent > 0 ? (c.replied_count || 0) / sent : 0;
  const posReplyRate = (c.replied_count || 0) > 0 ? (c.positive_reply_count || 0) / c.replied_count : 0;
  const leadRate     = (c.replied_count || 0) > 0 ? (c.lead_count || 0) / c.replied_count : 0;
  const contacted  = c.lead_contacted_count || 0;
  const total      = c.lead_count || 0; // data size (contacts in campaign list)
  const exhaustion = total > 0 ? contacted / total : 0;
  const flags = [];
  if (replyRate < 0.005 && sent > 300)  flags.push({ type: 'critical', msg: 'Very low reply rate — copy likely needs refreshing' });
  else if (replyRate < 0.01 && sent > 200) flags.push({ type: 'warning', msg: 'Below average reply rate' });
  if (wsAvgReplyRate > 0 && replyRate > wsAvgReplyRate * 1.5) flags.push({ type: 'top', msg: 'Top performer — 50%+ above workspace average' });
  if (posReplyRate > 0.4 && c.replied_count > 5) flags.push({ type: 'positive', msg: 'High quality — strong positive reply ratio' });
  if (c.bounced_count > 0 && sent > 0 && c.bounced_count / sent > 0.05) flags.push({ type: 'critical', msg: 'High bounce rate — check email list quality' });
  if (exhaustion >= 0.9) flags.push({ type: 'critical', msg: `Data exhausted — ${Math.round(exhaustion*100)}% of leads contacted, needs fresh data` });
  else if (exhaustion >= 0.75) flags.push({ type: 'warning', msg: `Data running low — ${Math.round(exhaustion*100)}% of leads contacted` });
  const tier = replyRate >= 0.025 ? 'top' : replyRate >= 0.01 ? 'good' : replyRate >= 0.005 ? 'warning' : 'critical';
  return { tier, replyRate, posReplyRate, leadRate, exhaustion, flags };
}

function analyzeVariants(steps) {
  const insights = [];
  for (const step of (steps || [])) {
    const vars = (step.variations || []).filter(v => v.sent >= 100);
    if (vars.length < 2) continue;
    vars.sort((a, b) => (b.reply / b.sent) - (a.reply / a.sent));
    const best  = vars[0];
    const worst = vars[vars.length - 1];
    const bestRate  = best.reply  / best.sent;
    const worstRate = worst.reply / worst.sent;
    if (bestRate > worstRate * 1.5 && bestRate > 0.005) {
      insights.push({
        step: step.step, winner: best.variation,
        winnerRate: (bestRate * 100).toFixed(1), loserRate: (worstRate * 100).toFixed(1),
        msg: `Step ${step.step}: Variant ${best.variation} (${(bestRate*100).toFixed(1)}%) outperforms Variant ${worst.variation} (${(worstRate*100).toFixed(1)}%) — consolidate around the winner`
      });
    }
  }
  return insights;
}

function parseApolloParams(name) {
  const match = (name || '').match(/https?:\/\/app\.apollo\.io[^\s]*/);
  if (!match) return null;
  try {
    const qPart = match[0].split('?')[1] || '';
    const p = new URLSearchParams(qPart);
    const get = key => p.getAll(key).map(v => decodeURIComponent(v).replace(/\+/g,' ').replace(/%2C/gi,',').trim());
    const sizeMap = {'1,10':'1-10','11,20':'11-20','21,50':'21-50','51,100':'51-100','101,200':'101-200','201,500':'201-500','501,1000':'501-1k','1001,5000':'1k-5k'};
    return {
      titles:    get('personTitles').slice(0,3),
      seniority: get('personSeniorities').slice(0,3),
      sizes:     get('organizationNumEmployeesRanges').map(s => sizeMap[s] || s),
      locations: [...new Set([...get('personLocations'), ...get('organizationLocations'), ...get('accounthqLocations')])].slice(0,4),
      inclKws:   get('qOrganizationKeywordTags').slice(0,5),
    };
  } catch { return null; }
}

function analyzeTargetingPatterns(workspaces) {
  const groups = {};
  for (const ws of workspaces) {
    for (const c of ws.campaigns) {
      if (c.sent < 200 || c.replyRate === 0) continue;
      const a = parseApolloParams(c.name);
      if (!a) continue;
      const titleKey  = (a.titles.length ? a.titles : a.seniority).slice(0,2).join(', ') || '';
      const sizeKey   = a.sizes.slice(0,2).join(', ') || '';
      const kwKey     = a.inclKws.slice(0,3).join(', ') || '';
      const key       = [titleKey, sizeKey, kwKey].filter(Boolean).join(' | ');
      if (!key) continue;
      if (!groups[key]) groups[key] = { label: key, titleKey, sizeKey, kwKey, campaigns: [], totalSent: 0, totalReplies: 0 };
      groups[key].campaigns.push({ wsName: ws.name, name: c.name.replace(/https?:\/\/\S+/g,'').trim().slice(0,50), replyRate: c.replyRate, sent: c.sent, tier: c.tier });
      groups[key].totalSent    += c.sent;
      groups[key].totalReplies += c.replies;
    }
  }
  return Object.values(groups)
    .filter(g => g.campaigns.length >= 2)
    .map(g => ({ ...g, avgReplyRate: g.totalSent > 0 ? g.totalReplies / g.totalSent : 0, count: g.campaigns.length }))
    .sort((a, b) => b.avgReplyRate - a.avgReplyRate);
}

function generateOptimisations(workspaces) {
  const opts = [];
  for (const ws of workspaces) {
    for (const c of ws.campaigns) {
      if (c.status !== 'ACTIVE') continue;
      for (const step of (c.variationSteps || [])) {
        const active = (step.variations || []).filter(v => v.is_active !== false && v.sent >= 50);
        if (active.length < 2) continue;
        active.sort((a, b) => (b.reply / b.sent) - (a.reply / a.sent));
        const winner = active[0];
        const winnerRate = winner.reply / winner.sent;
        const losers = active.slice(1).filter(v => {
          const lr = v.reply / v.sent;
          return winnerRate >= lr * 2 && winner.reply >= 5 && winner.sent >= 300;
        });
        if (!losers.length) continue;
        opts.push({
          wsId: ws.id, wsName: ws.name,
          campId: c.id, campName: c.name.replace(/https?:\/\/\S+/g,'').trim().slice(0,60) || c.name.slice(0,60),
          step: step.step,
          winner: { variation: winner.variation, sent: winner.sent, reply: winner.reply, rate: winnerRate },
          losers: losers.map(v => ({ variation: v.variation, sent: v.sent, reply: v.reply, rate: v.reply / v.sent })),
          confidence: winner.sent >= 500 && winner.reply >= 10 ? 'high' : 'medium',
          applied: false,
        });
      }
    }
  }
  return opts;
}

async function refreshCampaignCache() {
  try {
    const wsRaw = await pvFetch('/workspaces');
    const workspaces = Array.isArray(wsRaw) ? wsRaw : (wsRaw?.workspaces || []);

    // Only scan active clients — inactive ones are excluded from intelligence
    const clientRows = db.prepare(`SELECT workspace_id, client_status FROM clients`).all();
    const inactiveIds = new Set(clientRows.filter(r => r.client_status === 'inactive').map(r => r.workspace_id));

    const result = [];

    for (const ws of workspaces) {
      if (inactiveIds.has(ws.id)) continue;
      await new Promise(r => setTimeout(r, 1200)); // rate limit: 1.2s between workspaces (~25 ws = 30s total)
      try {
        var camp_raw = await bisonFetch('/api/campaigns', { wsId: ws.id || wsId || workspace_id });
        var campaigns = (camp_raw.data || []).map(function(c) { return { id: c.id, camp_name: c.name, status: c.status, sent_count: c.emails_sent || 0, replied_count: c.replied || 0, unique_opened_count: c.unique_opens || 0, bounced_count: c.bounced || 0, lead_count: c.total_leads || 0, lead_contacted_count: c.total_leads_contacted || 0, positive_reply_count: 0, sequences: [] }; });
        if (!Array.isArray(campaigns) || !campaigns.length) continue;
        const active = campaigns.filter(c => (c.sent_count || 0) >= 50);
        const wsAvgReplyRate = active.length
          ? active.reduce((s, c) => s + (c.replied_count || 0) / (c.sent_count || 1), 0) / active.length : 0;

        // Build actual lead counts per campaign from revenue cache (workspace-leads API)
        const revLeadsByCamp = {};
        (revenueCache.leads || [])
          .filter(l => l.workspace_id === ws.id && l.campaign)
          .forEach(l => { revLeadsByCamp[l.campaign] = (revLeadsByCamp[l.campaign] || 0) + 1; });

        const scored = [];
        for (const c of campaigns) {
          // Capture template content (subject/body per step+variant) for
          // decay detection. Runs inline because we already have the
          // campaign data; no extra PlusVibe API calls.
          captureCampaignTemplates(ws.id, c).catch(() => {});

          const metrics = scoreCampaign(c, wsAvgReplyRate);
          let variantInsights = [], variationSteps = [];
          if ((c.sent_count || 0) >= 300) {
            try {
              var vstats = { data: [], steps: [] }; // A/B variant stats not available in EmailBison
              if (Array.isArray(vstats)) { variationSteps = vstats; variantInsights = analyzeVariants(vstats); }
            } catch {}
          }
          const stepReplies = (variationSteps || []).map(st => ({
            step: st.step,
            sent:    st.variations.reduce((s, v) => s + (v.sent || 0), 0),
            replies: st.variations.reduce((s, v) => s + (v.reply || 0), 0),
          }));

          // actualLeads = contacts marked as LEAD from this campaign (from workspace-leads)
          // dataSize    = total contacts in the campaign list (for exhaustion calc only)
          const actualLeads = revLeadsByCamp[c.camp_name] || 0;
          const dataSize    = c.lead_count || 0;
          const sent        = c.sent_count || 0;
          const leadConvRate = sent > 0 ? actualLeads / sent : 0;

          scored.push({
            id: c.id, name: c.camp_name || 'Unnamed', status: c.status,
            sent, opens: c.unique_opened_count || c.opened_count || 0,
            replies: c.replied_count || 0, posReplies: c.positive_reply_count || 0,
            negReplies: c.negative_reply_count || 0, neutralReplies: c.neutral_reply_count || 0,
            bounces: c.bounced_count || 0,
            leads: actualLeads, dataSize, leadContacted: c.lead_contacted_count || 0,
            openRate: c.open_rate || 0, replyRate: metrics.replyRate,
            posReplyRate: metrics.posReplyRate,
            leadRate: leadConvRate,
            exhaustion: metrics.exhaustion, tier: metrics.tier, flags: metrics.flags,
            variantInsights, variationSteps, stepReplies,
            lastSent: c.last_lead_sent || null, lastReplied: c.last_lead_replied || null,
          });
        }
        scored.sort((a, b) => b.replyRate - a.replyRate);
        const wsEntry = {
          id: ws.id, name: ws.name || ws.workspace_name,
          avgReplyRate: wsAvgReplyRate, campaigns: scored,
          totalSent:    scored.reduce((s, c) => s + c.sent, 0),
          totalReplies: scored.reduce((s, c) => s + c.replies, 0),
          totalLeads:   scored.reduce((s, c) => s + c.leads, 0),
          activeCampaigns: scored.filter(c => c.status === 'ACTIVE').length,
        };
        result.push(wsEntry);
        // Live-update campaignCache so Total Sent appears as soon as each
        // workspace finishes — no need to wait for the full 5min walk.
        campaignCache = {
          workspaces: result.slice(),
          targetingPatterns: campaignCache.targetingPatterns || [],
          optimisations: campaignCache.optimisations || [],
          updatedAt: new Date().toISOString(),
        };
        // Persist after every workspace so a redeploy can hydrate even
        // partial progress instead of starting from zero.
        if (app.locals.pgDb) {
          app.locals.pgDb.setSetting('campaign_cache_snapshot', campaignCache)
            .catch(err => console.warn('[campaign cache] persist failed:', err.message));
        }
      } catch (e) { console.warn(`[campaign cache] ${ws.name} error:`, e.message); }
    }

    const targetingPatterns = analyzeTargetingPatterns(result);
    const optimisations     = generateOptimisations(result);

    campaignCache = { workspaces: result, targetingPatterns, optimisations, updatedAt: new Date().toISOString() };
    console.log(`[campaign cache] refreshed — ${result.length} ws, ${result.reduce((s,w)=>s+w.campaigns.length,0)} campaigns, ${optimisations.length} optimisations, ${targetingPatterns.length} targeting patterns`);

    // Persist the snapshot so a redeploy doesn't blank out Total Sent / past
    // campaign data for the 5+ minutes it takes to re-walk PlusVibe.
    if (app.locals.pgDb) {
      app.locals.pgDb.setSetting('campaign_cache_snapshot', campaignCache)
        .catch(err => console.warn('[campaign cache] persist failed:', err.message));
    }

    // campaignCache contributes lifetime sent counts to workspace_stats —
    // recompute stats whenever this cache refreshes so Capacity etc. stay in sync.
    if (typeof refreshAllWorkspaceStats === 'function') {
      refreshAllWorkspaceStats().catch(() => {});
    }

    // After the template sync above, attach newly-known content_hashes to
    // older email_events that arrived before we knew about them.
    backfillEmailEventHashes().catch(() => {});
  } catch (err) { console.error('[campaign cache] refresh failed:', err.message); }
}

// On boot, hydrate campaignCache from the last persisted snapshot so Total Sent
// and past-campaign data are available immediately. The 90s background refresh
// then updates it with fresh data.
let _hydratePromise = null;
async function hydrateCampaignCacheFromDisk() {
  if (!app.locals.pgDb) return;
  // De-dupe concurrent hydration attempts.
  if (_hydratePromise) return _hydratePromise;
  _hydratePromise = (async () => {
    try {
      const snap = await app.locals.pgDb.getSetting('campaign_cache_snapshot', null);
      if (snap && snap.workspaces && snap.workspaces.length) {
        campaignCache = snap;
        const ageMin = snap.updatedAt ? Math.round((Date.now() - new Date(snap.updatedAt)) / 60000) : '?';
        console.log(`[campaign cache] hydrated from disk — ${snap.workspaces.length} ws (snapshot ${ageMin} min old)`);
      }
    } catch (err) {
      console.warn('[campaign cache] hydrate failed:', err.message);
    } finally {
      _hydratePromise = null;
    }
  })();
  return _hydratePromise;
}

// On-demand: if a request hits an empty cache during the boot race, hydrate
// before serving. Resolves the "Total Sent shows 700 right after deploy" issue.
async function ensureCampaignCache() {
  if (campaignCache.workspaces && campaignCache.workspaces.length) return;
  await hydrateCampaignCacheFromDisk();
}

// Hydrate from disk quickly (cheap DB read) so the dashboard is useful right
// away; then do the heavy PlusVibe refresh after the other caches settle.
setTimeout(hydrateCampaignCacheFromDisk, 2000);
setTimeout(refreshCampaignCache, 90000); // after mailbox (20s) + performance (60s) settle
setInterval(refreshCampaignCache, 30 * 60 * 1000);

app.get('/api/campaigns/intelligence', (req, res) => res.json(campaignCache));

// ─────────────────────────────────────────────────────────────────────
// CENTRAL WORKSPACE STATS — single source of truth for every page
// ─────────────────────────────────────────────────────────────────────
// Aggregates lead counts, send counts, reply rates, bounce rates, mailbox
// counts, capacity gaps, etc. for one workspace into a single JSONB blob
// persisted to workspace_stats. All dashboards (Capacity, Audience, Health,
// Revenue, etc.) read from this so the numbers always agree.
//
// Source-of-truth rules:
//   - lead counts        ← contacts table (status='interested')
//   - reply counts       ← contacts table (status IN replied/interested/not_interested)
//   - send counts (recent) ← email_events (event_type='sent')
//   - send counts (lifetime) ← campaignCache.totalSent (PV-authoritative)
//   - bounce counts      ← email_events (event_type='bounce') — webhook handler
//                          already filters OOOs so this is more accurate than PV
//   - mailbox/domain     ← _mailboxCache (PV /account/email-accounts)
//   - capacity targets   ← clients.lead_target_monthly (SQLite)

async function computeWorkspaceStats(pgdb, workspaceId, workspaceName, clientRow) {
  // Fallback per-mailbox daily send rate for mailboxes that don't expose one.
  // Real capacity is summed from each mailbox's actual daily_limit field below.
  const FALLBACK_DAILY_PER_MAILBOX = 30;
  const WORKING_DAYS_PER_MONTH     = 21;

  // How many months this client has actually been generating leads. We use
  // the EARLIEST signal available so 'active since' reflects real history,
  // not when the client record was added to our admin:
  //   1. earliest LEAD date from revenueCache (most accurate)
  //   2. earliest 'sent' event from email_events
  //   3. clients.created_at (least accurate — when WE onboarded them)
  const clientCreatedTs = clientRow?.created_at ? new Date(clientRow.created_at).getTime() : null;
  // NOTE: wsRevenueLeads is computed below this block (chicken-and-egg).
  // We resolve activeSince after that array exists — see below.
  let activeSinceTs = clientCreatedTs;
  let daysSinceStart = activeSinceTs ? (Date.now() - activeSinceTs) / 86400000 : 90;
  let effectiveMonths = Math.max(daysSinceStart / 30, 1);

  // --- AUTHORITATIVE LEAD COUNTS from the Revenue cache.
  // revenueCache pulls every LEAD_LABELS-tagged contact directly from PlusVibe
  // and is the source of truth for billing — applying the same is_nonlead logic
  // here keeps Capacity/Audience/Health perfectly aligned with the Revenue page.
  const nonleadOverrides = db.prepare(`SELECT email, active FROM nonlead_overrides WHERE active = 1`).all();
  const nonleadEmails = new Set(nonleadOverrides.map(o => o.email.toLowerCase()));

  const wsRevenueLeads = (revenueCache.leads || []).filter(l => {
    if (l.workspace_id !== workspaceId) return false;
    if (isRevenueExcludedWorkspace(l)) return false;
    const isOverridden = nonleadEmails.has((l.lead_email || '').toLowerCase());
    const isPvNonLead = Boolean(l.pv_nonlead || isPvNonLeadLabel(l.label));
    return !(isOverridden || isPvNonLead);
  });

  const now = Date.now();
  const since = (days) => now - days * 24 * 60 * 60 * 1000;
  const inWindow = (lead, days) => {
    const t = lead.date ? new Date(lead.date).getTime() : NaN;
    return Number.isFinite(t) && t >= since(days);
  };
  const leads_30d  = wsRevenueLeads.filter(l => inWindow(l, 30)).length;
  const leads_90d  = wsRevenueLeads.filter(l => inWindow(l, 90)).length;
  const leads_365d = wsRevenueLeads.filter(l => inWindow(l, 365)).length;
  const leads_lifetime = wsRevenueLeads.length;
  const lastLeadAt = wsRevenueLeads.reduce((max, l) => {
    const t = l.date ? new Date(l.date).getTime() : 0;
    return t > max ? t : max;
  }, 0);
  // EARLIEST lead date — used to figure out how long this client has been
  // actually generating leads. clients.created_at is often newer than reality
  // (we added an old client to admin recently), so this is more accurate.
  const firstLeadAt = wsRevenueLeads.reduce((min, l) => {
    const t = l.date ? new Date(l.date).getTime() : Infinity;
    return t < min ? t : min;
  }, Infinity);
  // Resolve activeSince: use the earliest of clientCreated, firstLeadAt
  // (anything earlier = real history we should count toward 'time active').
  const candidates = [clientCreatedTs, firstLeadAt === Infinity ? null : firstLeadAt].filter(x => x && x > 0);
  if (candidates.length) {
    activeSinceTs   = Math.min(...candidates);
    daysSinceStart  = (Date.now() - activeSinceTs) / 86400000;
    effectiveMonths = Math.max(daysSinceStart / 30, 1);
  }

  // Windowed sends + bounces from performanceCache (PV-authoritative daily stats).
  // We DON'T use email_events for these windows because webhook coverage is
  // sparse — email_events gives wrong (low) numbers and breaks LPT_90d etc.
  const sumPerfWindow = (days) => {
    const out = { sent: 0, bounces: 0, replies: 0 };
    const today = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = serverDateString(d);
      const entry = performanceCache.dailyStats.get(`${workspaceId}|${dateStr}`);
      if (!entry?.data) continue;
      const agg = aggPvEmailStats(entry.data);
      out.sent    += agg.sent;
      out.bounces += agg.bounces;
      out.replies += agg.replies;
    }
    return out;
  };
  const perf30  = sumPerfWindow(30);
  const perf90  = sumPerfWindow(90);
  const perf365 = sumPerfWindow(365);

  // --- Reply / send / bounce aggregates from local Postgres (contacts + email_events)
  const [contactsAgg, sentAgg, bounceAgg, lastActivity] = await Promise.all([
    pgdb.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'new')::int            AS new,
        COUNT(*) FILTER (WHERE status = 'active')::int         AS active,
        COUNT(*) FILTER (WHERE status = 'interested')::int     AS interested_contacts,
        COUNT(*) FILTER (WHERE status = 'replied')::int        AS replied,
        COUNT(*) FILTER (WHERE status = 'not_interested')::int AS not_interested,
        COUNT(*) FILTER (WHERE status = 'bounced')::int        AS bounced,
        COUNT(*) FILTER (WHERE status IN ('replied','interested','not_interested') AND last_reply_at > NOW() - INTERVAL '30 days')::int  AS replied_30d,
        COUNT(*) FILTER (WHERE status IN ('replied','interested','not_interested') AND last_reply_at > NOW() - INTERVAL '90 days')::int  AS replied_90d,
        COUNT(*) FILTER (WHERE status IN ('replied','interested','not_interested') AND last_reply_at > NOW() - INTERVAL '365 days')::int AS replied_365d,
        COUNT(*) FILTER (WHERE status = 'not_interested' AND last_reply_at > NOW() - INTERVAL '90 days')::int  AS not_interested_90d
      FROM contacts WHERE workspace_id = $1
    `, [workspaceId]),
    pgdb.query(`
      SELECT
        COUNT(*) FILTER (WHERE event_at > NOW() - INTERVAL '30 days')::int  AS sent_30d,
        COUNT(*) FILTER (WHERE event_at > NOW() - INTERVAL '90 days')::int  AS sent_90d,
        COUNT(*) FILTER (WHERE event_at > NOW() - INTERVAL '365 days')::int AS sent_365d,
        COUNT(*)::int AS sent_event_lifetime
      FROM email_events
      WHERE workspace_id = $1 AND event_type = 'sent'
    `, [workspaceId]),
    pgdb.query(`
      SELECT
        COUNT(*) FILTER (WHERE event_at > NOW() - INTERVAL '30 days')::int AS bounces_30d,
        COUNT(*) FILTER (WHERE event_at > NOW() - INTERVAL '90 days')::int AS bounces_90d,
        COUNT(*)::int AS bounces_lifetime
      FROM email_events
      WHERE workspace_id = $1 AND event_type = 'bounce'
    `, [workspaceId]),
    pgdb.query(`
      SELECT
        MAX(CASE WHEN event_type='sent'  THEN event_at END) AS last_sent_at,
        MAX(CASE WHEN event_type='reply' THEN event_at END) AS last_reply_at
      FROM email_events WHERE workspace_id = $1
    `, [workspaceId]),
  ]);

  const c = contactsAgg.rows[0];
  const s = sentAgg.rows[0];
  const b = bounceAgg.rows[0];
  const la = lastActivity.rows[0];

  // Lifetime sent: PV-authoritative from campaignCache wins over email_events
  // (which is partial — webhook only has data from when it was set up).
  const wsCache = (campaignCache.workspaces || []).find(w => w.id === workspaceId);
  const sentLifetime = Math.max(wsCache?.totalSent || 0, s.sent_event_lifetime);

  // Mailbox / domain counts + REAL capacity from actual per-mailbox daily_limit.
  const mailboxList = (_mailboxCache.mailboxes || []).filter(m => m.workspace_id === workspaceId);
  const mailboxCount = mailboxList.length;
  const domainCount  = new Set(mailboxList.map(m => (m.email || '').split('@')[1]).filter(Boolean)).size;

  // Sum each mailbox's real daily_limit (PV value). Missing limits fall back
  // to FALLBACK_DAILY_PER_MAILBOX. Paused mailboxes (daily_limit === 0) get
  // dropped because they aren't sending.
  const dailyCapacitySum = mailboxList.reduce((sum, m) => {
    const lim = (typeof m.daily_limit === 'number' && m.daily_limit > 0)
      ? m.daily_limit
      : FALLBACK_DAILY_PER_MAILBOX;
    return sum + lim;
  }, 0);
  const mailboxMonthlyCapacity = dailyCapacitySum * WORKING_DAYS_PER_MONTH;
  const avgDailyPerMailbox     = mailboxCount > 0 ? Math.round(dailyCapacitySum / mailboxCount) : FALLBACK_DAILY_PER_MAILBOX;

  // Compute LPT and reply rate for each window. Requires meaningful send
  // volume in the window — otherwise a contact with 10 sends + 1 lead would
  // produce LPT=100 which is just noise. Lifetime LPT is the trustworthy one.
  const lpt = (leads, sent) => (sent >= 1000 && leads >= 1) ? +(leads * 1000 / sent).toFixed(2) : null;
  const rr  = (replied, total) => total > 0 ? +(replied / total * 100).toFixed(2) : null;
  const br  = (bounces, sent) => sent > 0 ? +(bounces / sent * 100).toFixed(2) : null;

  // LPT uses the Revenue-cache lead counts (authoritative) over send counts
  // from email_events. Lifetime LPT uses PV-authoritative totalSent.
  // LPT uses PV-authoritative sends (perf cache) over email_events.
  const lpt_30d  = lpt(leads_30d,  perf30.sent  || s.sent_30d);
  const lpt_90d  = lpt(leads_90d,  perf90.sent  || s.sent_90d);
  const lpt_365d = lpt(leads_365d, perf365.sent || s.sent_365d);
  const lpt_lifetime = lpt(leads_lifetime, sentLifetime);

  // Capacity math — based on 90-day LPT, fallback to lifetime
  const lptForCapacity = lpt_90d || lpt_lifetime;
  const target = clientRow?.lead_target_monthly || clientRow?.plan_leads || 0;
  const requiredMonthlySends = (target > 0 && lptForCapacity > 0) ? Math.round((target / lptForCapacity) * 1000) : null;
  // Gap = how many ADDITIONAL fresh mailboxes (at 30/day each) we'd need to
  // close the capacity shortfall. Comparing actual capacity (sum of real
  // daily_limits) to required sends, NOT comparing mailbox counts — those
  // counts would only be apples-to-apples if every existing mailbox already
  // ran at the fallback rate, which they often don't.
  const capacityShortfall = requiredMonthlySends != null
    ? requiredMonthlySends - mailboxMonthlyCapacity
    : null;
  const perMailboxMonthly = FALLBACK_DAILY_PER_MAILBOX * WORKING_DAYS_PER_MONTH; // 630
  const mailboxGap = capacityShortfall == null ? null
    : capacityShortfall > 0
      ? Math.ceil(capacityShortfall / perMailboxMonthly)        // need this many more
      : -Math.ceil(-capacityShortfall / perMailboxMonthly);     // can reduce this many
  // requiredMailboxes is now "what total mailbox count would cover the target
  // at fallback per-mailbox rate" — useful for display alongside the actual.
  const requiredMailboxes = requiredMonthlySends != null
    ? Math.ceil(requiredMonthlySends / perMailboxMonthly)
    : null;

  return {
    // identifiers
    workspace_id: workspaceId,
    workspace_name: workspaceName,
    client_status: clientRow?.client_status || 'active',

    // contact totals (raw status counts from contacts table — useful for audience)
    contacts_total: c.total,
    contacts_by_status: {
      new: c.new, active: c.active, interested: c.interested_contacts,
      replied: c.replied, not_interested: c.not_interested, bounced: c.bounced,
    },

    // LEADS — from Revenue cache (authoritative, applies non-lead overrides)
    leads_30d, leads_90d, leads_365d, leads_lifetime,
    // Monthly average = total lifetime leads × 30 ÷ days_active. Honest
    // rate over the client's entire history. Days floored at 30 so brand-new
    // clients don't over-project from a tiny sample.
    leads_monthly_avg_3mo: leads_lifetime > 0
      ? +((leads_lifetime / Math.max(daysSinceStart, 30)) * 30).toFixed(1)
      : 0,
    effective_months: +effectiveMonths.toFixed(2),
    days_since_start: Math.round(daysSinceStart),

    // replies (windowed) — includes positives + negatives (engagement signal)
    replied_30d: c.replied_30d, replied_90d: c.replied_90d, replied_365d: c.replied_365d,
    replied_lifetime: c.replied + c.interested_contacts + c.not_interested,
    not_interested_90d: c.not_interested_90d,

    // sends (windowed) — from performanceCache (PV daily stats, authoritative)
    sent_30d: perf30.sent || s.sent_30d,
    sent_90d: perf90.sent || s.sent_90d,
    sent_365d: perf365.sent || s.sent_365d,
    sent_lifetime: sentLifetime,
    // Sent/mo = actual last 90 days ÷ 3. True rolling 3-month average, not a
    // lifetime projection. If client has < 90 days of data, fall back to
    // lifetime ÷ days_active × 30.
    sent_monthly_avg_3mo: perf90.sent > 0
      ? Math.round(perf90.sent / 3)
      : (sentLifetime > 0
          ? Math.round((sentLifetime / Math.max(daysSinceStart, 30)) * 30)
          : 0),

    // bounces — from performanceCache (PV daily stats)
    bounces_30d: perf30.bounces || b.bounces_30d,
    bounces_90d: perf90.bounces || b.bounces_90d,
    bounces_lifetime: b.bounces_lifetime,
    bounce_rate_30d: br(perf30.bounces, perf30.sent),
    bounce_rate_90d: br(perf90.bounces, perf90.sent),

    // conversion / engagement
    lpt_30d, lpt_90d, lpt_365d, lpt_lifetime,
    reply_rate_30d:  rr(c.replied_30d,  s.sent_30d),
    reply_rate_90d:  rr(c.replied_90d,  s.sent_90d),

    // infrastructure — capacity is sum of actual per-mailbox daily_limits × 21 working days
    mailbox_count: mailboxCount,
    domain_count: domainCount,
    mailbox_monthly_capacity: mailboxMonthlyCapacity,
    avg_daily_per_mailbox: avgDailyPerMailbox,

    // capacity / targets
    lead_target_monthly: target,
    required_monthly_sends: requiredMonthlySends,
    required_mailboxes: requiredMailboxes,
    mailbox_gap: mailboxGap,

    // activity
    last_sent_at:  la.last_sent_at,
    last_reply_at: la.last_reply_at,
    last_lead_at:  lastLeadAt ? new Date(lastLeadAt).toISOString() : null,

    // meta
    computed_at: new Date().toISOString(),
  };
}

async function persistWorkspaceStats(pgdb, workspaceId, workspaceName, stats) {
  await pgdb.query(`
    INSERT INTO workspace_stats (workspace_id, workspace_name, stats, computed_at)
    VALUES ($1, $2, $3::jsonb, NOW())
    ON CONFLICT (workspace_id) DO UPDATE SET
      workspace_name = EXCLUDED.workspace_name,
      stats          = EXCLUDED.stats,
      computed_at    = EXCLUDED.computed_at
  `, [workspaceId, workspaceName, JSON.stringify(stats)]);
}

// Canonical reader — use this from any endpoint that needs workspace metrics.
async function getWorkspaceStats(pgdb, workspaceId) {
  if (!pgdb) return null;
  const r = await pgdb.query(
    `SELECT workspace_name, stats, computed_at FROM workspace_stats WHERE workspace_id = $1`,
    [workspaceId]
  );
  if (!r.rows.length) {
    // Not in cache yet — compute on-demand, persist, return.
    const client = db.prepare(
      `SELECT workspace_name, lead_target_monthly, plan_leads, client_status, created_at FROM clients WHERE workspace_id = ?`
    ).get(workspaceId);
    if (!client) return null;
    const stats = await computeWorkspaceStats(pgdb, workspaceId, client.workspace_name, client);
    await persistWorkspaceStats(pgdb, workspaceId, client.workspace_name, stats);
    return stats;
  }
  return { ...r.rows[0].stats, workspace_name: r.rows[0].workspace_name, computed_at: r.rows[0].computed_at };
}

async function getAllWorkspaceStats(pgdb) {
  if (!pgdb) return [];
  const r = await pgdb.query(
    `SELECT workspace_id, workspace_name, stats, computed_at FROM workspace_stats ORDER BY workspace_name`
  );
  return r.rows.map(row => ({
    ...row.stats,
    workspace_id: row.workspace_id,
    workspace_name: row.workspace_name,
    computed_at: row.computed_at,
  }));
}

async function refreshAllWorkspaceStats() {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return;
  // Guard: don't persist bad data. revenueCache is the source for leads,
  // so if it hasn't populated yet we'd write 0-lead stats and overwrite
  // good data from a previous run. Skip and wait for upstream to be ready.
  if (!revenueCache?.leads?.length) {
    console.log('[workspace-stats] skip — revenueCache not yet populated');
    return;
  }
  try {
    const clients = db.prepare(`
      SELECT workspace_id, workspace_name, lead_target_monthly, plan_leads, client_status, created_at
      FROM clients
      WHERE workspace_id IS NOT NULL AND workspace_id != ''
    `).all();
    let ok = 0, failed = 0;
    for (const c of clients) {
      try {
        const stats = await computeWorkspaceStats(pgdb, c.workspace_id, c.workspace_name, c);
        await persistWorkspaceStats(pgdb, c.workspace_id, c.workspace_name, stats);
        ok++;
      } catch (err) {
        console.warn(`[workspace-stats] ${c.workspace_name} failed:`, err.message);
        failed++;
      }
    }
    console.log(`[workspace-stats] refreshed ${ok}/${clients.length} workspaces${failed ? ` (${failed} failed)` : ''}`);
  } catch (err) {
    console.error('[workspace-stats] refresh failed:', err.message);
  }
}

// First refresh runs after upstream caches are ready. Subsequent refreshes
// are also triggered automatically when refreshRevenueCache or
// refreshCampaignCache complete, so this fixed schedule is just a safety net.
setTimeout(refreshAllWorkspaceStats, 3 * 60 * 1000);   // 3 min — after rev (~5s), mailbox (20s), campaign (~90s + walk)
setInterval(refreshAllWorkspaceStats, 15 * 60 * 1000); // every 15 minutes

// Manual refresh trigger. Renamed to /api/metrics/* to avoid collision with
// the pre-existing /api/stats client-facing endpoint at line ~986.
app.post('/api/metrics/refresh', requireSession, async (req, res) => {
  refreshAllWorkspaceStats().catch(() => {});
  res.json({ ok: true, message: 'Stats refresh started in background' });
});

// Read endpoints — canonical metric source for every dashboard.
app.get('/api/metrics', requireSession, async (req, res) => {
  try {
    const rows = await getAllWorkspaceStats(app.locals.pgDb);
    res.json({ ok: true, count: rows.length, workspaces: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/metrics/:workspaceId', requireSession, async (req, res) => {
  try {
    const stats = await getWorkspaceStats(app.locals.pgDb, req.params.workspaceId);
    if (!stats) return res.status(404).json({ error: 'Workspace not found' });
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Client Health — per-client daily snapshot + AI briefing
// ─────────────────────────────────────────────────────────────────────
// The mechanical score is built from numeric signals (reply trend, bounce
// rate, mailbox health %, open copy alerts). The AI briefing INTERPRETS
// those signals — it doesn't invent numbers, it explains them in plain
// English for the assigned campaign manager.
//
// Open rates are deliberately NOT used anywhere in this scoring. Apple Mail
// Privacy Protection makes them noise rather than signal.

// Minimal Claude API client. Returns null on failure / missing key so
// callers can fall back to a deterministic narrative.
// cacheSystem: true caches the system prompt — 90% cheaper on cache hits (5-min TTL).
async function callClaude({ system, user, maxTokens = 600, expectJson = false, cacheSystem = false }) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const systemPayload = cacheSystem && system
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        system: systemPayload,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.warn(`[Claude] ${r.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const j = await r.json();
    const text = j?.content?.[0]?.text || '';
    if (!expectJson) return text;
    // Strip code fences if the model wrapped JSON in ```json ... ```
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(cleaned); } catch { return null; }
  } catch (err) {
    console.warn('[Claude] call failed:', err.message);
    return null;
  }
}

// enrichment helpers moved before routes — see top of enrichment section

// Aggregate per-workspace signals over a date range. Source-of-truth here
// is email_events when available (provider-split, per-template granularity),
// falling back to the workspace-level perf cache for the volume totals (so
// the score still works on day 1, before email_events has accumulated).
async function aggregateWorkspaceSignals(workspaceId, days, endDate = new Date()) {
  const pgdb = app.locals.pgDb;
  const start = new Date(endDate);
  start.setDate(start.getDate() - days);
  const startIso = start.toISOString();
  const endIso = endDate.toISOString();

  // Try email_events first
  let sent = 0, replies = 0, posReplies = 0, ooo = 0, bounces = 0, leads = 0;
  let gmailSent = 0, gmailReplies = 0, outlookSent = 0, outlookReplies = 0;
  let hasEventData = false;

  if (pgdb) {
    try {
      const r = await pgdb.query(`
        SELECT event_type, provider_bucket, COUNT(*)::int AS n
          FROM email_events
         WHERE workspace_id=$1 AND event_at >= $2 AND event_at < $3
         GROUP BY event_type, provider_bucket
      `, [workspaceId, startIso, endIso]);
      for (const row of r.rows) {
        hasEventData = true;
        const n = row.n;
        switch (row.event_type) {
          case 'sent':           sent += n;       break;
          case 'reply':          replies += n;    break;
          case 'positive_reply': replies += n; posReplies += n; break;
          case 'ooo':            ooo += n;        break;
          case 'bounce':         bounces += n;    break;
          case 'lead':           leads += n;      break;
        }
        if (row.provider_bucket === 'gmail') {
          if (row.event_type === 'sent') gmailSent += n;
          if (row.event_type === 'reply' || row.event_type === 'positive_reply') gmailReplies += n;
        }
        if (row.provider_bucket === 'outlook' || row.provider_bucket === 'workspace') {
          if (row.event_type === 'sent') outlookSent += n;
          if (row.event_type === 'reply' || row.event_type === 'positive_reply') outlookReplies += n;
        }
      }
    } catch (err) {
      console.warn('[health] email_events query failed:', err.message);
    }
  }

  // Fallback / supplement: use perf cache daily totals. The cache holds
  // last 30 days warm. Older windows fall back to email_events only.
  if (!hasEventData || sent === 0) {
    const dates = [];
    const cur = new Date(start);
    while (cur < endDate) {
      dates.push(serverDateString(cur));
      cur.setDate(cur.getDate() + 1);
    }
    for (const date of dates) {
      const data = performanceCache.dailyStats.get(`${workspaceId}|${date}`)?.data;
      if (!data) continue;
      sent       += data.sent       || 0;
      replies    += data.replies    || 0;
      posReplies += data.posReplies || 0;
      ooo        += data.oooReplies || 0;
      bounces    += data.bounces    || 0;
    }
    // Leads come from labeled-leads cache (filtered to date range)
    const leadRows = (performanceCache.labeledLeads.get(workspaceId)?.data || []);
    const startStr = serverDateString(start), endStr = serverDateString(endDate);
    leads += leadRows.filter(l => {
      const d = (l._pv_lead_date || '').slice(0, 10);
      return d >= startStr && d < endStr && !l._pv_nonlead;
    }).length;
  }

  return {
    sent, replies, posReplies, ooo, bounces, leads,
    gmailSent, gmailReplies, outlookSent, outlookReplies,
    hasEventData,
  };
}

// Compute the mechanical 0-100 health score. Weights tuned so that a
// catastrophic single signal (e.g. bounce rate above 5%) can pull a
// client into the red on its own — managers shouldn't have to mentally
// combine signals to see something's wrong.
function computeHealthScore(s) {
  // Penalty model — start at 100, subtract for each problem signal.
  let score = 100;
  const reasons = [];

  // 1. Reply-rate decay vs 30-day baseline
  if (s.reply_rate_baseline > 0 && s.reply_rate_7d != null) {
    const ratio = s.reply_rate_7d / s.reply_rate_baseline;
    if (ratio < 0.5)      { score -= 35; reasons.push('reply_rate_dropped_50pct'); }
    else if (ratio < 0.7) { score -= 20; reasons.push('reply_rate_dropped_30pct'); }
    else if (ratio < 0.85){ score -= 8;  reasons.push('reply_rate_dropped_15pct'); }
  }

  // 2. Bounce rate — anything above 3% is reputation-damaging
  if (s.bounce_rate_7d != null) {
    if (s.bounce_rate_7d > 0.05)      { score -= 30; reasons.push('bounce_rate_critical'); }
    else if (s.bounce_rate_7d > 0.03) { score -= 15; reasons.push('bounce_rate_elevated'); }
    else if (s.bounce_rate_7d > 0.02) { score -= 5;  reasons.push('bounce_rate_warning'); }
  }

  // 3. Absolute reply rate floor — even if no baseline, < 0.5% is bad
  if (s.reply_rate_7d != null && s.sent_7d > 500) {
    if (s.reply_rate_7d < 0.005)      { score -= 20; reasons.push('reply_rate_floor'); }
    else if (s.reply_rate_7d < 0.01)  { score -= 8;  reasons.push('reply_rate_low'); }
  }

  // 4. Mailbox health
  if (s.mailbox_total > 0) {
    const unhealthyPct = s.mailbox_unhealthy / s.mailbox_total;
    if (unhealthyPct > 0.25)      { score -= 20; reasons.push('mailboxes_unhealthy'); }
    else if (unhealthyPct > 0.10) { score -= 8;  reasons.push('mailboxes_warning'); }
  }

  // 5. Domain health (SPF/DKIM/DMARC/blacklist failures)
  if (s.domain_unhealthy > 0) {
    score -= Math.min(15, s.domain_unhealthy * 5);
    reasons.push('domains_unhealthy');
  }

  // 6. Open copy alerts (decay/over-used templates) — each one weighs 5pts
  if (s.copy_alerts_open > 0) {
    score -= Math.min(15, s.copy_alerts_open * 5);
    reasons.push('copy_alerts_open');
  }

  // 7. Provider-specific filtering — Gmail tanked but Outlook held
  if (s.reply_rate_gmail_7d != null && s.reply_rate_outlook_7d != null
      && s.reply_rate_outlook_7d > 0.01
      && s.reply_rate_gmail_7d < s.reply_rate_outlook_7d * 0.3) {
    score -= 12;
    reasons.push('gmail_filtering');
  }

  // 8. Zero send volume on what should be an active client — info, not penalty
  if (s.sent_7d === 0 && s.sent_30d > 100) {
    score -= 25;
    reasons.push('sending_stopped');
  }

  // 9. Behind monthly lead target. pace_pct < 1.0 = behind expected pace
  // for this point in the month. We only score when a target is set
  // (lead_target_monthly > 0) and the month is far enough in to be
  // meaningful — < day 5 of the month, small samples create false alarms.
  if (s.lead_target_monthly > 0 && s.pace_pct != null && s.day_of_month >= 5) {
    if (s.pace_pct < 0.4)      { score -= 30; reasons.push('lead_pace_critical'); }
    else if (s.pace_pct < 0.65){ score -= 18; reasons.push('lead_pace_behind'); }
    else if (s.pace_pct < 0.85){ score -= 6;  reasons.push('lead_pace_warning'); }
  }

  score = Math.max(0, Math.min(100, score));
  const band = score >= 75 ? 'green' : score >= 50 ? 'yellow' : 'red';
  return { score, band, reasons };
}

// Run the template-decay detector for a workspace. Inserts alerts into
// template_alerts when a known template's reply rate has dropped sharply
// or its lifetime sends have crossed an over-use threshold. Closes
// previously-open alerts that no longer apply.
// Campaign-cache–based copy staleness. Uses reply rates already computed
// by refreshCampaignCache (runs every 30 min) — no extra PlusVibe calls.
//
// A campaign is "stale" when:
//   • status is ACTIVE and sent >= 300 (enough signal)
//   • replyRate < wsAvgReplyRate * 0.5  (underperforming at ≥ 50% below avg)
//
// This catches pattern-marked copy today, before email_events has filled
// up. Opens a template_alert of type 'copy_stale' so the dashboard's
// "Open Copy Alerts" counter is non-zero and the AI can name specific
// campaigns in refresh_copy actions.
async function detectCampaignCopyStaleness(workspaceId) {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return 0;

  const ws = (campaignCache.workspaces || []).find(w => w.id === workspaceId);
  if (!ws) return 0;

  const wsAvg = ws.avgReplyRate || 0;
  // Need at least a 0.3% workspace average to avoid false positives on
  // brand-new workspaces where every rate is near zero.
  if (wsAvg < 0.003) return 0;

  const threshold = wsAvg * 0.5;
  const staleCampaigns = (ws.campaigns || []).filter(c =>
    c.status === 'ACTIVE' &&
    c.sent >= 300 &&
    c.replyRate < threshold
  );

  let opened = 0;
  for (const c of staleCampaigns) {
    try {
      const exists = await pgdb.query(`
        SELECT id FROM template_alerts
         WHERE workspace_id=$1 AND campaign_name=$2
           AND alert_type='copy_stale'
           AND dismissed_at IS NULL AND resolved_at IS NULL
         LIMIT 1
      `, [workspaceId, c.name]);
      if (exists.rows.length) continue;

      await pgdb.query(`
        INSERT INTO template_alerts
          (workspace_id, campaign_id, campaign_name,
           alert_type, severity, reply_rate_baseline, reply_rate_current,
           lifetime_sends, details)
        VALUES ($1,$2,$3,'copy_stale',$4,$5,$6,$7,$8)
      `, [
        workspaceId, c.id || null, c.name,
        c.replyRate < wsAvg * 0.25 ? 'critical' : 'warning',
        wsAvg, c.replyRate, c.sent,
        JSON.stringify({ ws_avg_reply_rate: wsAvg, threshold, sent: c.sent }),
      ]);
      opened++;
    } catch (err) {
      console.warn('[health] copy_stale insert failed:', err.message);
    }
  }

  // Auto-resolve stale alerts for campaigns that have recovered or paused
  try {
    const activeNames = new Set((ws.campaigns || [])
      .filter(c => c.status === 'ACTIVE' && c.replyRate >= threshold)
      .map(c => c.name));
    const pausedNames = new Set((ws.campaigns || [])
      .filter(c => c.status !== 'ACTIVE')
      .map(c => c.name));

    await pgdb.query(`
      UPDATE template_alerts
         SET resolved_at = NOW(), outcome_notes = 'campaign recovered or paused'
       WHERE workspace_id=$1 AND alert_type='copy_stale'
         AND dismissed_at IS NULL AND resolved_at IS NULL
         AND (campaign_name = ANY($2::text[]) OR campaign_name = ANY($3::text[]))
    `, [workspaceId, [...activeNames], [...pausedNames]]);
  } catch { /* non-fatal */ }

  return opened;
}

// Open a copy_stale alert for any template the Copy page flags "Avoid", so
// Actions and Decaying Copy stay in sync. detectCampaignCopyStaleness only
// catches the campaign-grain case (active, 300+ sends, reply rate halved);
// this catches the template-grain profiled/bounce flags the copy page shows.
// Thresholds mirror the Decaying Copy SQL exactly (server.js §5):
//   A) profiled: 500+ sends, <0.5% reply rate, 0 leads
//   B) high bounce: 100+ sends, >=3% bounce rate
// (True-decay case C is already handled by detectCampaignCopyStaleness.)
async function detectFlaggedTemplateAlerts(workspaceId) {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return 0;

  let flagged;
  try {
    flagged = await pgdb.query(`
      WITH tpl AS (
        SELECT
          ct.content_hash,
          MAX(ct.campaign_name)                            AS campaign_name,
          MAX(ct.campaign_id)                              AS campaign_id,
          MIN(ct.step)                                     AS step,
          SUM(COALESCE(cvs.sent, 0))                       AS sent,
          SUM(COALESCE(cvs.reply, 0))                      AS replies,
          SUM(COALESCE(cvs.bounce, 0))                     AS bounces
        FROM campaign_templates ct
        LEFT JOIN campaign_variant_stats cvs
          ON cvs.workspace_id = ct.workspace_id AND cvs.campaign_id = ct.campaign_id
         AND cvs.step = ct.step AND cvs.variant = ct.variant
        WHERE ct.workspace_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM suppressed_templates st
            WHERE st.workspace_id = ct.workspace_id AND st.content_hash = ct.content_hash
          )
        GROUP BY ct.content_hash
      ),
      leads AS (
        SELECT content_hash, COUNT(*) FILTER (WHERE event_type = 'lead') AS leads
        FROM email_events WHERE workspace_id = $1 AND content_hash IS NOT NULL
        GROUP BY content_hash
      )
      SELECT tpl.content_hash, tpl.campaign_name, tpl.campaign_id, tpl.step,
             tpl.sent, tpl.replies, tpl.bounces, COALESCE(leads.leads, 0) AS leads
      FROM tpl LEFT JOIN leads USING (content_hash)
      WHERE (tpl.sent >= 500 AND tpl.replies::float / NULLIF(tpl.sent,0) < 0.005 AND COALESCE(leads.leads,0) = 0)
         OR (tpl.sent >= 100 AND tpl.bounces::float / NULLIF(tpl.sent,0) >= 0.03)
    `, [workspaceId]);
  } catch (err) {
    console.warn('[health] flagged-template query failed:', err.message);
    return 0;
  }

  let opened = 0;
  for (const t of flagged.rows) {
    const replyRate = t.sent > 0 ? t.replies / t.sent : 0;
    const bounceRate = t.sent > 0 ? t.bounces / t.sent : 0;
    const isBounce = bounceRate >= 0.03 && t.sent >= 100;
    try {
      // Dedup on content_hash so the same template doesn't re-alert each run.
      const exists = await pgdb.query(`
        SELECT id FROM template_alerts
         WHERE workspace_id=$1 AND content_hash=$2 AND alert_type='copy_stale'
           AND dismissed_at IS NULL AND resolved_at IS NULL
         LIMIT 1
      `, [workspaceId, t.content_hash]);
      if (exists.rows.length) continue;

      await pgdb.query(`
        INSERT INTO template_alerts
          (workspace_id, campaign_id, campaign_name, content_hash, step,
           alert_type, severity, reply_rate_current, lifetime_sends, details)
        VALUES ($1,$2,$3,$4,$5,'copy_stale',$6,$7,$8,$9)
      `, [
        workspaceId, t.campaign_id || null, t.campaign_name || null, t.content_hash, t.step || null,
        isBounce ? 'critical' : 'warning',
        replyRate, t.sent,
        JSON.stringify({ flag: isBounce ? 'high_bounce' : 'profiled', sent: t.sent, reply_rate: replyRate, bounce_rate: bounceRate, leads: t.leads }),
      ]);
      opened++;
    } catch (err) {
      console.warn('[health] flagged-template alert insert failed:', err.message);
    }
  }
  return opened;
}

async function detectTemplateAlerts(workspaceId) {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return 0;

  // Pull per-template stats over two windows: last 7d vs prior 7-28d
  // baseline. Limited to templates with meaningful send volume in BOTH
  // windows so we don't fire on samples too small to be reliable.
  let rows;
  try {
    const r = await pgdb.query(`
      WITH per_template AS (
        SELECT ee.content_hash,
               MIN(ct.campaign_id)   AS campaign_id,
               MIN(ct.campaign_name) AS campaign_name,
               MIN(ct.step)          AS step,
               MIN(ct.variant)       AS variant,
               COUNT(*) FILTER (WHERE ee.event_type='sent'
                                AND ee.event_at >= NOW() - INTERVAL '7 days')   AS sent_7d,
               COUNT(*) FILTER (WHERE ee.event_type IN ('reply','positive_reply')
                                AND ee.event_at >= NOW() - INTERVAL '7 days')   AS replies_7d,
               COUNT(*) FILTER (WHERE ee.event_type='sent'
                                AND ee.event_at >= NOW() - INTERVAL '28 days'
                                AND ee.event_at <  NOW() - INTERVAL '7 days')   AS sent_baseline,
               COUNT(*) FILTER (WHERE ee.event_type IN ('reply','positive_reply')
                                AND ee.event_at >= NOW() - INTERVAL '28 days'
                                AND ee.event_at <  NOW() - INTERVAL '7 days')   AS replies_baseline,
               COUNT(*) FILTER (WHERE ee.event_type='sent')                     AS lifetime_sends,
               COUNT(*) FILTER (WHERE ee.event_type='sent'
                                AND ee.provider_bucket='gmail'
                                AND ee.event_at >= NOW() - INTERVAL '14 days')  AS gmail_sent,
               COUNT(*) FILTER (WHERE ee.event_type IN ('reply','positive_reply')
                                AND ee.provider_bucket='gmail'
                                AND ee.event_at >= NOW() - INTERVAL '14 days')  AS gmail_replies,
               COUNT(*) FILTER (WHERE ee.event_type='sent'
                                AND ee.provider_bucket IN ('outlook','workspace')
                                AND ee.event_at >= NOW() - INTERVAL '14 days')  AS outlook_sent,
               COUNT(*) FILTER (WHERE ee.event_type IN ('reply','positive_reply')
                                AND ee.provider_bucket IN ('outlook','workspace')
                                AND ee.event_at >= NOW() - INTERVAL '14 days')  AS outlook_replies
          FROM email_events ee
          LEFT JOIN campaign_templates ct ON ct.content_hash = ee.content_hash
                                          AND ct.workspace_id = ee.workspace_id
         WHERE ee.workspace_id = $1
           AND ee.content_hash IS NOT NULL
         GROUP BY ee.content_hash
      )
      SELECT * FROM per_template WHERE sent_7d >= 100 OR lifetime_sends >= 10000
    `, [workspaceId]);
    rows = r.rows;
  } catch (err) {
    console.warn(`[health] template stats query failed for ${workspaceId}:`, err.message);
    return 0;
  }

  let opened = 0;
  for (const row of rows) {
    const replyRate7d   = row.sent_7d > 0       ? row.replies_7d / row.sent_7d : null;
    const replyRateBase = row.sent_baseline > 0 ? row.replies_baseline / row.sent_baseline : null;
    const alerts = [];

    // Decay: 7d reply rate < 60% of baseline, requires both windows >= 100 sends
    if (replyRate7d != null && replyRateBase != null
        && row.sent_7d >= 100 && row.sent_baseline >= 100
        && replyRate7d < replyRateBase * 0.6) {
      alerts.push({
        alert_type: 'decay',
        severity: replyRate7d < replyRateBase * 0.4 ? 'critical' : 'warning',
        details: { drop_pct: 1 - (replyRate7d / replyRateBase) },
      });
    }

    // Over-used: lifetime sends crossed fingerprint thresholds
    if (row.lifetime_sends >= 50000) {
      alerts.push({ alert_type: 'over_used', severity: 'critical', details: { threshold: 50000 } });
    } else if (row.lifetime_sends >= 25000) {
      alerts.push({ alert_type: 'over_used', severity: 'warning', details: { threshold: 25000 } });
    }

    // Provider-split: Gmail reply rate < 30% of Outlook's, both windows meaningful
    const gmailRate   = row.gmail_sent   > 0 ? row.gmail_replies   / row.gmail_sent   : null;
    const outlookRate = row.outlook_sent > 0 ? row.outlook_replies / row.outlook_sent : null;
    if (gmailRate != null && outlookRate != null
        && row.gmail_sent >= 50 && row.outlook_sent >= 50
        && outlookRate > 0.01
        && gmailRate < outlookRate * 0.3) {
      alerts.push({
        alert_type: 'provider_split',
        severity: 'warning',
        details: { gmail_rate: gmailRate, outlook_rate: outlookRate },
      });
    }

    for (const a of alerts) {
      // Skip if there's already an open alert of this type for this template
      try {
        const existing = await pgdb.query(`
          SELECT id FROM template_alerts
           WHERE workspace_id=$1 AND content_hash=$2 AND alert_type=$3
             AND dismissed_at IS NULL AND resolved_at IS NULL
           LIMIT 1
        `, [workspaceId, row.content_hash, a.alert_type]);
        if (existing.rows.length) continue;

        await pgdb.query(`
          INSERT INTO template_alerts
            (workspace_id, campaign_id, campaign_name, step, variant, content_hash,
             alert_type, severity, reply_rate_baseline, reply_rate_current,
             lifetime_sends, details)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `, [
          workspaceId, row.campaign_id, row.campaign_name, row.step, row.variant, row.content_hash,
          a.alert_type, a.severity, replyRateBase, replyRate7d,
          row.lifetime_sends, JSON.stringify(a.details),
        ]);
        opened++;
      } catch (err) {
        console.warn('[health] alert insert failed:', err.message);
      }
    }
  }

  // Auto-resolve decay alerts where the template has bounced back
  try {
    await pgdb.query(`
      UPDATE template_alerts ta
         SET resolved_at = NOW()
       WHERE ta.workspace_id = $1
         AND ta.dismissed_at IS NULL AND ta.resolved_at IS NULL
         AND ta.alert_type = 'decay'
         AND EXISTS (
           SELECT 1 FROM email_events ee
            WHERE ee.workspace_id = ta.workspace_id
              AND ee.content_hash = ta.content_hash
              AND ee.event_at >= NOW() - INTERVAL '7 days'
            GROUP BY ee.content_hash
            HAVING COUNT(*) FILTER (WHERE ee.event_type='sent') > 100
               AND (COUNT(*) FILTER (WHERE ee.event_type IN ('reply','positive_reply'))::numeric
                    / COUNT(*) FILTER (WHERE ee.event_type='sent')) > ta.reply_rate_baseline * 0.8
         )
    `, [workspaceId]);
  } catch { /* non-fatal */ }

  return opened;
}

// Generate per-client AI briefing — falls back to a deterministic template
// if the API call fails or the key is missing.
function deterministicBriefing(s) {
  const bits = [];
  // Lead-target pace gets top billing — it's what the manager is judged on.
  if (s.lead_target_monthly > 0 && s.pace_pct != null && s.day_of_month >= 5) {
    if (s.pace_pct < 0.65) {
      const behind = Math.round((1 - s.pace_pct) * 100);
      bits.push(`${behind}% behind monthly lead pace — ${s.leads_mtd}/${s.lead_target_monthly} target, ${(s.leads_expected_mtd || 0).toFixed(1)} expected by day ${s.day_of_month}.`);
    } else if (s.pace_pct < 0.85) {
      bits.push(`Slightly behind target — ${s.leads_mtd}/${s.lead_target_monthly} this month vs ${(s.leads_expected_mtd || 0).toFixed(1)} expected by today.`);
    }
  }
  if (s.sent_7d === 0 && s.sent_30d > 100) bits.push(`Sending stopped — 0 sends in the last 7d after ${s.sent_30d} in the prior 30.`);
  if (s.reply_rate_baseline > 0 && s.reply_rate_7d != null) {
    const drop = 1 - (s.reply_rate_7d / s.reply_rate_baseline);
    if (drop > 0.3) bits.push(`Reply rate has dropped ${Math.round(drop*100)}% vs 30-day baseline (${(s.reply_rate_7d*100).toFixed(2)}% now vs ${(s.reply_rate_baseline*100).toFixed(2)}%).`);
  }
  if (s.bounce_rate_7d > 0.03) bits.push(`Bounce rate is ${(s.bounce_rate_7d*100).toFixed(1)}% — above the 3% reputation threshold.`);
  if (s.mailbox_total > 0 && s.mailbox_unhealthy / s.mailbox_total > 0.1) {
    bits.push(`${s.mailbox_unhealthy} of ${s.mailbox_total} mailboxes are flagged unhealthy.`);
  }
  if (s.copy_alerts_open > 0) bits.push(`${s.copy_alerts_open} copy alert${s.copy_alerts_open > 1 ? 's' : ''} open — templates may be profiled and need a refresh.`);
  if (s.reply_rate_gmail_7d != null && s.reply_rate_outlook_7d > 0.01
      && s.reply_rate_gmail_7d < s.reply_rate_outlook_7d * 0.3) {
    bits.push(`Gmail reply rate (${(s.reply_rate_gmail_7d*100).toFixed(2)}%) is far below Outlook's (${(s.reply_rate_outlook_7d*100).toFixed(2)}%) — likely Gmail-specific filtering.`);
  }
  if (!bits.length) return 'All key signals are within healthy ranges. No action needed today.';
  return bits.join(' ');
}

// Columns on client_health_snapshots that an action can name as its
// target_metric. Used both to safely substitute the column name into SQL
// (preventing injection — never inline an action.target_metric without
// passing through this set) and to skip evaluating actions whose target
// doesn't map to a real snapshot field.
const VALID_TARGET_METRICS = new Set([
  'reply_rate_7d', 'reply_rate_30d', 'reply_rate_baseline',
  'bounce_rate_7d',
  'sent_7d', 'sent_30d',
  'replies_7d', 'replies_30d',
  'leads_7d', 'leads_30d',
  'reply_rate_gmail_7d', 'reply_rate_outlook_7d',
  'mailbox_unhealthy', 'domain_unhealthy', 'copy_alerts_open',
  'pace_pct',
]);

// Phase 2 — the learning loop. For every completed action with no outcome
// yet, read the latest snapshot's target_metric value and compare against
// the baseline that was captured at completion. If the metric moved in the
// desired direction (≥10%), the action 'helped'. If it moved against,
// 'worse'. Within ±10% → 'no_change'. Actions that stay outcome-less for
// 14 days get marked 'inconclusive' so they stop blocking the queue.
async function evaluateActionOutcomes() {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return { evaluated: 0, expired: 0 };

  // Mark long-stale actions inconclusive so we don't keep checking them
  let expired = 0;
  try {
    const r = await pgdb.query(`
      UPDATE health_actions
         SET outcome       = 'inconclusive',
             outcome_at    = CURRENT_TIMESTAMP,
             outcome_notes = 'no follow-up snapshot within 14 days'
       WHERE outcome IS NULL
         AND completed_at IS NOT NULL
         AND completed_at <= NOW() - INTERVAL '14 days'
    `);
    expired = r.rowCount || 0;
  } catch (err) {
    console.warn('[health] outcome expiry sweep failed:', err.message);
  }

  // Actions ready for evaluation: completed ≥24h ago, target_metric set,
  // baseline known, and a fresh snapshot exists dated AFTER completion
  // (otherwise we'd be comparing a metric against itself).
  let rows = [];
  try {
    const r = await pgdb.query(`
      SELECT ha.id, ha.workspace_id, ha.target_metric, ha.target_direction,
             ha.baseline_value, ha.completed_at
        FROM health_actions ha
       WHERE ha.outcome IS NULL
         AND ha.completed_at IS NOT NULL
         AND ha.completed_at <= NOW() - INTERVAL '24 hours'
         AND ha.target_metric IS NOT NULL
         AND ha.baseline_value IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM client_health_snapshots s
            WHERE s.workspace_id = ha.workspace_id
              AND s.snapshot_date > DATE(ha.completed_at)
         )
       ORDER BY ha.completed_at ASC
       LIMIT 500
    `);
    rows = r.rows;
  } catch (err) {
    console.warn('[health] action evaluation query failed:', err.message);
    return { evaluated: 0, expired };
  }

  let evaluated = 0;
  for (const a of rows) {
    if (!VALID_TARGET_METRICS.has(a.target_metric)) continue;
    try {
      const sRes = await pgdb.query(
        `SELECT ${a.target_metric} AS v
           FROM client_health_snapshots
          WHERE workspace_id = $1
          ORDER BY snapshot_date DESC LIMIT 1`,
        [a.workspace_id]
      );
      const followup = sRes.rows[0]?.v;
      if (followup == null) continue;

      const baseline = Number(a.baseline_value);
      const follow   = Number(followup);
      const direction = a.target_direction === 'up' ? 1 : -1; // up means we want higher

      let outcome, notes;
      if (baseline === 0 && follow === 0) {
        outcome = 'no_change';
        notes = 'baseline and follow-up both 0';
      } else if (baseline === 0) {
        // Avoid div-by-zero. Any non-zero movement counts.
        const signed = direction * (follow > 0 ? 1 : -1);
        outcome = signed > 0 ? 'helped' : 'worse';
        notes = `baseline 0 → ${follow}`;
      } else {
        const change = (follow - baseline) / Math.abs(baseline); // signed
        const signed = change * direction; // positive = moved the way we wanted
        if      (signed >  0.10) outcome = 'helped';
        else if (signed < -0.10) outcome = 'worse';
        else                      outcome = 'no_change';
        const pct = (Math.abs(change) * 100).toFixed(1);
        const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
        notes = `${formatMetric(baseline)} → ${formatMetric(follow)} (${arrow}${pct}%)`;
      }

      await pgdb.query(`
        UPDATE health_actions
           SET followup_value = $1,
               outcome        = $2,
               outcome_at     = CURRENT_TIMESTAMP,
               outcome_notes  = $3
         WHERE id = $4
      `, [follow, outcome, notes, a.id]);
      evaluated++;
    } catch (err) {
      console.warn(`[health] evaluate action ${a.id} failed:`, err.message);
    }
  }

  if (evaluated || expired) {
    console.log(`[health] outcomes — ${evaluated} evaluated, ${expired} marked inconclusive`);
  }
  return { evaluated, expired };
}

// Compact display of a metric value — rates as %, integers as raw.
function formatMetric(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.abs(n) > 0 && Math.abs(n) < 1) return (n * 100).toFixed(2) + '%';
  return n.toLocaleString();
}

// Roll up completed action outcomes for a workspace into per-kind
// frequencies that Claude can reason over. Used as evidence in the next
// briefing's prompt — "kinds with high helped/total are more likely to
// work again on this client".
async function fetchActionHistory(workspaceId) {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return [];
  try {
    const r = await pgdb.query(`
      SELECT kind, outcome, COUNT(*)::int AS n
        FROM health_actions
       WHERE workspace_id = $1
         AND outcome IS NOT NULL
         AND completed_at >= NOW() - INTERVAL '90 days'
       GROUP BY kind, outcome
    `, [workspaceId]);

    const byKind = {};
    for (const row of r.rows) {
      const k = row.kind;
      if (!byKind[k]) byKind[k] = { kind: k, total: 0, helped: 0, no_change: 0, worse: 0, inconclusive: 0 };
      byKind[k].total += row.n;
      byKind[k][row.outcome] = (byKind[k][row.outcome] || 0) + row.n;
    }
    return Object.values(byKind).map(k => ({
      ...k,
      helped_rate: k.total > 0 ? Number((k.helped / k.total).toFixed(2)) : 0,
    }));
  } catch (err) {
    console.warn('[health] action history fetch failed:', err.message);
    return [];
  }
}

async function generateClientBriefing(workspaceName, signals, actionHistory = []) {
  const fallback = {
    briefing: deterministicBriefing(signals),
    actions: [],
    source: ANTHROPIC_API_KEY ? 'fallback_api_failed' : 'fallback_no_key',
  };
  if (!ANTHROPIC_API_KEY) return fallback;

  const system = `You are an analyst for Ottaly, a cold-email lead-gen agency. You write one short paragraph (3-5 sentences) of diagnostic briefing for the campaign manager assigned to a client, then propose 1-3 SPECIFIC actions they will tick off when done. Plain professional English, no marketing tone, no fluff, no headers. Cite specific numbers from the signals you're given — never invent numbers.

ABSOLUTE BAN — never use these words or any synonym in the briefing or actions:
"monitor", "watch", "keep an eye", "observe", "track", "review", "look into", "check on", "look at", "see how it goes", "stay on top of", "check back", "investigate", "consider", "evaluate", "assess", "give it time", "let it run", "wait", "patience", "be patient", "hold off", "more data needed", "let it play out", "see what happens", "soon", "in the meantime", "for now", "as needed", "if needed", "potentially", "may want to", "might want to", "could", "perhaps"

The word "check" without a fix attached is also banned — "check the domain" is observation, not action. Use "Fix SPF on …", "Submit … to MXToolbox blacklist removal", "Audit and remove unverified contacts from list X", etc.

Every action MUST:
- Start with a strong DOING verb from this list (case insensitive): Pause, Add, Replace, Lower, Increase, Send, Launch, Generate, Swap, Fix, Audit, Remove, Disable, Enable, Rotate, Split-test, Submit, Warm, Reduce, Cut, Move, Push, Build
- Include the SPECIFIC TARGET (named mailbox, named campaign + step, named domain, named audience). NEVER "the mailbox / a campaign / the domain" — name it. If the signals don't give you the specific name, DO NOT propose that kind — choose a different action kind you CAN be specific about.
- Be something the manager will literally do in the next 24-72h and tick off when done
- Tie to a metric the system can verify moved (target_metric + target_direction)

The rationale field MUST cite at least one specific number from the signals (e.g. "bounce rate 11.2% across 3,675 sends" or "reply rate dropped 41% vs 1.11% baseline"). Generic phrases like "to improve engagement" or "to boost deliverability" are forbidden.

LOW-DATA CLIENTS (new client, sent_30d < 500): do NOT say "wait for more data" or "give it time". Propose a DATA-GENERATING action instead: "Send 200 contacts from audience X to Campaign Y" or "Launch a 100-contact A/B test of subject 'foo' vs 'bar' on Campaign Y step 1". This produces the data the next briefing needs.

Diagnostic rules:
- NEVER use open rate as a signal. We do not track opens. Apple MPP makes them noise.
- If 'lead_target_monthly' > 0 and 'pace_pct' < 0.85, this client is BEHIND target. Lead with this — it's what the manager is paid to fix. Cite leads_mtd vs lead_target_monthly and how many leads behind expected they are. Don't mention pace if null or > 0.95.
- If 'reply_rate_gmail_7d' far below 'reply_rate_outlook_7d', diagnose as provider-specific Gmail filtering and act on Gmail.
- If 'reply_rate_baseline' > 'reply_rate_7d' significantly, frame as decay vs baseline.
- If 'copy_alerts_open' > 0, the content has been flagged by the decay detector as pattern-marked (providers have fingerprinted it — reply rate dropped without a matching bounce/mailbox/domain cause). Use 'active_campaigns' to name the SPECIFIC worst-performing campaign in your refresh_copy action. Pattern-marking is silent: no hard bounce, no spam complaint, just disappearing replies. The fix is always new subject lines AND new body structure (not just wording changes — the paragraph shape matters too).
- If 'copy_alerts_open' == 0 but 'active_campaigns' shows any campaign with reply_rate < (ws_avg_reply_rate * 0.5), treat it the same as a copy alert. That campaign's content has almost certainly been seen too many times by provider filters.
- 'active_campaigns' is sorted worst performer first. Always use the campaign name from this list in refresh_copy actions — never say "the campaign" or "your campaigns".
- If 'mailbox_unhealthy' / 'mailbox_total' > 10%, flag mailbox health as the likely cause before content.
- If 'bounce_rate_7d' > 0.03, this is reputation damage — prioritize list quality / domain / mailbox pause actions over content.
- Skip null/healthy signals — don't pad with "everything else looks fine".
- For HEALTHY clients (score >= 75 and no flags): propose a SPECIFIC experiment with a stated hypothesis and predicted lift. Examples of acceptable healthy-client actions:
   - "Add a 5th follow-up step to Campaign 'May Outbound' using offer angle 'free audit' — hypothesis: lifts reply rate from 4.2% to ≥5.0%"
   - "Split-test subject 'Quick question about {company}' vs 'Question about {company}'s {industry} setup' on Campaign 'Q2 UK' step 1 — hypothesis: shorter+industry merge lifts reply rate ≥15%"
   - "Add 10 more mailboxes from Maildoso to scale Campaign 'Q2 UK' from 80/day to 120/day"
   Vague suggestions like "test a new vertical" or "expand audience" are forbidden — name the vertical, name the audience criteria.
- If 'past_action_outcomes' is provided, use it as evidence. Each entry shows how many times that action kind has been tried for THIS client and how often it 'helped'. Prefer kinds with higher helped_rate. Avoid kinds where multiple recent attempts didn't help on this client unless the diagnostic case is materially different now (e.g. don't keep suggesting refresh_copy if 0/3 previous refreshes helped — try lower_send_volume or check_dns instead).

Allowed action 'kind' values (use exactly these strings) — each has a target_metric the outcome evaluator will check after 24-72h:

| kind                 | payload shape                              | target_metric         | target_direction |
|----------------------|--------------------------------------------|-----------------------|-----------------|
| pause_mailbox        | {"mailbox":"email@..."}                    | bounce_rate_7d        | down            |
| add_mailboxes        | {"count":N,"reason":"..."}                 | sent_7d               | up              |
| refresh_copy         | {"campaign_name":"...","step":N,"variant":"A"} | reply_rate_7d     | up              |
| pause_campaign       | {"campaign_name":"...","reason":"..."}     | bounce_rate_7d        | down            |
| split_test_subject   | {"campaign_name":"...","hypothesis":"..."} | reply_rate_7d         | up              |
| narrow_audience      | {"campaign_name":"...","criteria":"..."}   | reply_rate_7d         | up              |
| add_warmup           | {"mailboxes":[...]}                         | sent_7d               | up              |
| lower_send_volume    | {"campaign_name":"...","new_daily_cap":N}  | bounce_rate_7d        | down            |
| check_dns            | {"domain":"..."}                            | bounce_rate_7d        | down            |
| segment_rotation     | {"campaign_name":"..."}                     | reply_rate_7d         | up              |
| add_followup_step    | {"campaign_name":"...","step_number":N}    | reply_rate_7d         | up              |
| review_bounces       | {"scope":"workspace"}                       | bounce_rate_7d        | down            |
| swap_offer           | {"campaign_name":"...","new_angle":"..."}  | reply_rate_7d         | up              |

Payload specificity rules — if you cannot fill these you must choose a different action kind:
- pause_mailbox → "mailbox" must be a real email address, never "a mailbox" or empty
- refresh_copy  → "campaign_name" must come from active_campaigns in the signals, step must be an integer
- check_dns / fix_dns → "domain" must be a specific domain string (e.g. "auraadesign.com"), never "the domain"
- pause_campaign / split_test_subject / lower_send_volume / segment_rotation / add_followup_step / swap_offer → "campaign_name" must come from active_campaigns
- add_mailboxes → "count" must be an integer, "reason" must explain the specific bottleneck
- add_warmup → "mailboxes" must be a non-empty array (use generic labels like ["new-mailbox-1", "new-mailbox-2"] if you don't have real addresses)

Priority: 1 = do FIRST (highest-leverage, do within 24h), 2 = do today, 3 = improvement test this week.

Output STRICT JSON only (no prose, no code fences):
{
  "briefing": "<single 3-5 sentence paragraph, never vague>",
  "actions": [
    {
      "label": "<imperative doing-verb + specific named target, max 100 chars>",
      "kind": "pause_mailbox",
      "payload": { "mailbox": "john@example.com" },
      "rationale": "<must cite a specific number from signals, max 120 chars>",
      "priority": 1,
      "target_metric": "bounce_rate_7d",
      "target_direction": "down"
    }
  ]
}

Always return 1-3 actions — never empty, never "no action needed".`;

  const user = JSON.stringify({
    client: workspaceName,
    signals,
    past_action_outcomes: actionHistory.length ? actionHistory : null,
  });

  if (process.env.DISABLE_AI_FEATURES === '1') return fallback;
  const out = await callClaude({ system, user, maxTokens: 800, expectJson: true });
  if (!out || !out.briefing) return fallback;

  // Server-side action quality gate — strip any action that:
  //   • contains banned soft-language in its label or rationale
  //   • is missing a label or kind
  //   • has a known kind that requires a payload field but the field is empty
  const BANNED_PHRASES = [
    'monitor', 'keep an eye', 'watch ', 'review ', 'look into', 'check back',
    'give it time', 'let it run', 'wait ', 'patience', 'more data',
    'let it play', 'see what happens', 'hold off', 'may want', 'might want',
    'could ', 'perhaps', 'potentially', 'investigate', 'assess', 'evaluate',
    'no action needed', 'in the meantime',
  ];
  const PAYLOAD_REQUIRED = {
    pause_mailbox:     a => a.payload?.mailbox,
    refresh_copy:      a => a.payload?.campaign_name,
    pause_campaign:    a => a.payload?.campaign_name,
    split_test_subject:a => a.payload?.campaign_name,
    lower_send_volume: a => a.payload?.campaign_name,
    check_dns:         a => a.payload?.domain,
    add_followup_step: a => a.payload?.campaign_name,
    segment_rotation:  a => a.payload?.campaign_name,
    swap_offer:        a => a.payload?.campaign_name,
    add_mailboxes:     a => a.payload?.count,
  };

  const rawActions = Array.isArray(out.actions) ? out.actions : [];
  const cleanActions = rawActions.filter(a => {
    if (!a?.label || !a?.kind) return false;
    const text = `${a.label} ${a.rationale || ''}`.toLowerCase();
    if (BANNED_PHRASES.some(p => text.includes(p))) {
      console.warn(`[health] stripped vague action "${a.label.slice(0, 60)}"`);
      return false;
    }
    const check = PAYLOAD_REQUIRED[a.kind];
    if (check && !check(a)) {
      console.warn(`[health] stripped under-specified action kind="${a.kind}" label="${a.label.slice(0,60)}"`);
      return false;
    }
    return true;
  });

  // If Claude's actions all got stripped (rare, means the prompt constraints
  // weren't followed), build one concrete fallback action from the signals
  // so the manager never sees an empty panel.
  if (!cleanActions.length) {
    const s = signals || {};
    if (s.bounce_rate_7d > 0.03) {
      cleanActions.push({ label: 'Audit and remove contacts with invalid emails from the main send list', kind: 'review_bounces', payload: { scope: 'workspace' }, rationale: `Bounce rate ${(s.bounce_rate_7d * 100).toFixed(1)}% — above 3% reputation threshold`, priority: 1, target_metric: 'bounce_rate_7d', target_direction: 'down' });
    } else if ((s.active_campaigns || []).length > 0 && s.reply_rate_7d != null && s.reply_rate_baseline != null && s.reply_rate_7d < s.reply_rate_baseline * 0.6) {
      const worst = s.active_campaigns[0];
      cleanActions.push({ label: `Replace subject and opening line on Campaign "${worst.name}" step 1`, kind: 'refresh_copy', payload: { campaign_name: worst.name, step: 1, variant: 'A' }, rationale: `Reply rate ${(s.reply_rate_7d * 100).toFixed(2)}% vs ${(s.reply_rate_baseline * 100).toFixed(2)}% baseline — content likely pattern-marked`, priority: 1, target_metric: 'reply_rate_7d', target_direction: 'up' });
    } else {
      cleanActions.push({ label: `Split-test a new subject line on ${(s.active_campaigns || [])[0]?.name || 'the most-sent campaign'} step 1`, kind: 'split_test_subject', payload: { campaign_name: (s.active_campaigns || [])[0]?.name || 'primary campaign', hypothesis: 'new structural pattern lifts reply rate ≥15%' }, rationale: 'Ongoing healthy campaigns still benefit from continuous A/B testing', priority: 3, target_metric: 'reply_rate_7d', target_direction: 'up' });
    }
  }

  return {
    briefing: out.briefing,
    actions: cleanActions,
    source: 'ai',
  };
}

// Build today's snapshot for a single workspace. Runs the decay detector
// first so the snapshot's copy_alerts_open count is current.
async function buildHealthSnapshot(workspaceId, workspaceName) {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return null;

  // 1a. Campaign-cache–based copy staleness detection. Works TODAY with
  // existing PlusVibe data. Flags active campaigns whose reply rate has
  // fallen below 50% of the workspace average — the most reliable proxy
  // for "this content has been pattern-marked" while email_events is still
  // filling up (< 2 weeks old).
  await detectCampaignCopyStaleness(workspaceId).catch(() => {});
  await detectFlaggedTemplateAlerts(workspaceId).catch(() => {});

  // 1b. Email-events–based template alerts (higher-precision, needs ~2
  // weeks of email_events data before it fires meaningfully).
  await detectTemplateAlerts(workspaceId).catch(() => {});

  // 2. Aggregate signals over 7d and 30d
  const today = new Date();
  const sig7  = await aggregateWorkspaceSignals(workspaceId, 7,  today);
  const sig30 = await aggregateWorkspaceSignals(workspaceId, 30, today);

  // Baseline: prior 30d EXCLUDING the last 7d, so a sharp recent drop
  // doesn't get smoothed away by being included in its own baseline.
  const baselineEnd = new Date(today);
  baselineEnd.setDate(baselineEnd.getDate() - 7);
  const sigBase = await aggregateWorkspaceSignals(workspaceId, 23, baselineEnd);

  // 3. Mailbox + domain health from existing caches/tables. _mailboxCache
  // stores a flat list with workspace_id on each row; filter to this ws.
  let mailboxTotal = 0, mailboxUnhealthy = 0;
  try {
    const list = (_mailboxCache?.mailboxes || []).filter(m => m.workspace_id === workspaceId);
    mailboxTotal = list.length;
    mailboxUnhealthy = list.filter(m => {
      const s = String(m.status || m.health_status || m.connection_status || '').toLowerCase();
      return s.includes('unhealth') || s.includes('error') || s.includes('disconnected') || s.includes('failed') || s.includes('paused');
    }).length;
  } catch { /* mailbox cache not ready */ }

  let domainUnhealthy = 0;
  try {
    const r = await pgdb.query(
      `SELECT COUNT(*)::int AS n FROM domain_health
        WHERE workspace_id=$1 AND status IN ('critical','warning')
          AND ignored_at IS NULL`,
      [workspaceId]
    );
    domainUnhealthy = r.rows[0]?.n || 0;
  } catch { /* table not ready */ }

  let copyAlertsOpen = 0;
  try {
    const r = await pgdb.query(
      `SELECT COUNT(*)::int AS n FROM template_alerts
        WHERE workspace_id=$1 AND dismissed_at IS NULL AND resolved_at IS NULL`,
      [workspaceId]
    );
    copyAlertsOpen = r.rows[0]?.n || 0;
  } catch {}

  // 3b. Lead target & month-to-date pace. Uses revenueCache as the
  // source-of-truth (same lead-counting rules as the Revenue page —
  // excludes manual non-lead overrides and PlusVibe "Non Lead" labels).
  // pace_pct < 1.0 means behind expected pace for this point in the month.
  let leadTargetMonthly = 0;
  try {
    const row = db.prepare('SELECT lead_target_monthly FROM clients WHERE workspace_id=?').get(workspaceId);
    leadTargetMonthly = row?.lead_target_monthly || 0;
  } catch {}

  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const startOfMonthStr = serverDateString(startOfMonth);
  const todayStr = serverDateString(today);
  const manualNonleadEmails = new Set(
    db.prepare(`SELECT email FROM nonlead_overrides WHERE active = 1`).all()
      .map(r => String(r.email || '').toLowerCase())
  );
  const leadsMtd = (revenueCache.leads || []).filter(l => {
    if (l.workspace_id !== workspaceId) return false;
    if (l.pv_nonlead || isPvNonLeadLabel(l.label)) return false;
    if (manualNonleadEmails.has(String(l.lead_email || '').toLowerCase())) return false;
    const d = (l.date || '').slice(0, 10);
    return d >= startOfMonthStr && d <= todayStr;
  }).length;

  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const dayOfMonth = today.getDate();
  const expectedMtd = leadTargetMonthly > 0
    ? leadTargetMonthly * (dayOfMonth / daysInMonth)
    : 0;
  const pacePct = expectedMtd > 0 ? leadsMtd / expectedMtd : null;

  // 4. Derive rates
  const replyRate7d    = sig7.sent  > 0 ? sig7.replies   / sig7.sent  : null;
  const replyRate30d   = sig30.sent > 0 ? sig30.replies  / sig30.sent : null;
  const replyRateBase  = sigBase.sent > 0 ? sigBase.replies / sigBase.sent : null;
  const bounceRate7d   = sig7.sent  > 0 ? sig7.bounces   / sig7.sent  : null;
  const gmailRate7d    = sig7.gmailSent   > 0 ? sig7.gmailReplies   / sig7.gmailSent   : null;
  const outlookRate7d  = sig7.outlookSent > 0 ? sig7.outlookReplies / sig7.outlookSent : null;

  const signals = {
    sent_7d: sig7.sent, sent_30d: sig30.sent,
    replies_7d: sig7.replies, replies_30d: sig30.replies,
    pos_replies_7d: sig7.posReplies, pos_replies_30d: sig30.posReplies,
    bounces_7d: sig7.bounces, bounces_30d: sig30.bounces,
    leads_7d: sig7.leads, leads_30d: sig30.leads,
    reply_rate_7d: replyRate7d, reply_rate_30d: replyRate30d, reply_rate_baseline: replyRateBase,
    bounce_rate_7d: bounceRate7d,
    reply_rate_gmail_7d: gmailRate7d, reply_rate_outlook_7d: outlookRate7d,
    gmail_sent_7d: sig7.gmailSent, outlook_sent_7d: sig7.outlookSent,
    mailbox_total: mailboxTotal, mailbox_unhealthy: mailboxUnhealthy,
    domain_unhealthy: domainUnhealthy,
    copy_alerts_open: copyAlertsOpen,
    lead_target_monthly: leadTargetMonthly,
    leads_mtd: leadsMtd,
    leads_expected_mtd: expectedMtd ? Number(expectedMtd.toFixed(2)) : null,
    pace_pct: pacePct,
    day_of_month: dayOfMonth,
    days_in_month: daysInMonth,
    // Active campaigns with their reply rates — gives Claude the specific
    // campaign names it needs for refresh_copy actions instead of speaking
    // vaguely about "the campaigns". Sorted worst performer first.
    active_campaigns: (() => {
      const ws = (campaignCache.workspaces || []).find(w => w.id === workspaceId);
      if (!ws) return [];
      return (ws.campaigns || [])
        .filter(c => c.status === 'ACTIVE' && c.sent >= 100)
        .sort((a, b) => a.replyRate - b.replyRate)
        .slice(0, 8)
        .map(c => ({
          name: c.name,
          sent: c.sent,
          reply_rate: Number((c.replyRate * 100).toFixed(2)),
          leads: c.leads || 0,
          ws_avg_reply_rate: Number(((ws.avgReplyRate || 0) * 100).toFixed(2)),
        }));
    })(),
  };

  const { score, band, reasons } = computeHealthScore(signals);
  signals.score_reasons = reasons;

  // 5. AI briefing — pass past-action-outcome rollups so Claude can reason
  // from evidence of what has/hasn't worked on THIS client before.
  const actionHistory = await fetchActionHistory(workspaceId);
  const { briefing, actions, source: briefingSource } = await generateClientBriefing(workspaceName, signals, actionHistory);

  // 6. Persist
  const snapshotDate = serverDateString(today);
  try {
    await pgdb.query(`
      INSERT INTO client_health_snapshots
        (workspace_id, snapshot_date, health_score, health_band,
         sent_7d, sent_30d, replies_7d, replies_30d,
         bounces_7d, bounces_30d, leads_7d, leads_30d,
         reply_rate_7d, reply_rate_30d, reply_rate_baseline,
         bounce_rate_7d, reply_rate_gmail_7d, reply_rate_outlook_7d,
         mailbox_total, mailbox_unhealthy, domain_unhealthy, copy_alerts_open,
         lead_target_monthly, leads_mtd, leads_expected_mtd, pace_pct,
         ai_briefing, ai_briefing_source, ai_actions, signals)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
      ON CONFLICT (workspace_id, snapshot_date) DO UPDATE SET
        health_score = EXCLUDED.health_score,
        health_band  = EXCLUDED.health_band,
        sent_7d = EXCLUDED.sent_7d, sent_30d = EXCLUDED.sent_30d,
        replies_7d = EXCLUDED.replies_7d, replies_30d = EXCLUDED.replies_30d,
        bounces_7d = EXCLUDED.bounces_7d, bounces_30d = EXCLUDED.bounces_30d,
        leads_7d = EXCLUDED.leads_7d, leads_30d = EXCLUDED.leads_30d,
        reply_rate_7d = EXCLUDED.reply_rate_7d, reply_rate_30d = EXCLUDED.reply_rate_30d,
        reply_rate_baseline = EXCLUDED.reply_rate_baseline,
        bounce_rate_7d = EXCLUDED.bounce_rate_7d,
        reply_rate_gmail_7d = EXCLUDED.reply_rate_gmail_7d,
        reply_rate_outlook_7d = EXCLUDED.reply_rate_outlook_7d,
        mailbox_total = EXCLUDED.mailbox_total, mailbox_unhealthy = EXCLUDED.mailbox_unhealthy,
        domain_unhealthy = EXCLUDED.domain_unhealthy, copy_alerts_open = EXCLUDED.copy_alerts_open,
        lead_target_monthly = EXCLUDED.lead_target_monthly,
        leads_mtd = EXCLUDED.leads_mtd,
        leads_expected_mtd = EXCLUDED.leads_expected_mtd,
        pace_pct = EXCLUDED.pace_pct,
        ai_briefing = EXCLUDED.ai_briefing,
        ai_briefing_source = EXCLUDED.ai_briefing_source,
        ai_actions = EXCLUDED.ai_actions,
        signals = EXCLUDED.signals
    `, [
      workspaceId, snapshotDate, score, band,
      sig7.sent, sig30.sent, sig7.replies, sig30.replies,
      sig7.bounces, sig30.bounces, sig7.leads, sig30.leads,
      replyRate7d, replyRate30d, replyRateBase,
      bounceRate7d, gmailRate7d, outlookRate7d,
      mailboxTotal, mailboxUnhealthy, domainUnhealthy, copyAlertsOpen,
      leadTargetMonthly, leadsMtd, expectedMtd || null, pacePct,
      briefing, briefingSource || 'fallback_no_key', JSON.stringify(actions || []), JSON.stringify(signals),
    ]);
  } catch (err) {
    console.warn(`[health] snapshot upsert failed for ${workspaceName}:`, err.message);
    return null;
  }

  // 7. Persist each action as a checkable row in health_actions. We wipe
  // any uncompleted/undismissed rows from THIS snapshot date first so a
  // rebuild doesn't duplicate them — completed/dismissed rows stay for
  // history.
  try {
    await pgdb.query(`
      DELETE FROM health_actions
       WHERE workspace_id=$1 AND snapshot_date=$2
         AND completed_at IS NULL AND dismissed_at IS NULL
    `, [workspaceId, snapshotDate]);

    for (const a of (actions || [])) {
      if (!a?.label || !a?.kind) continue;
      await pgdb.query(`
        INSERT INTO health_actions
          (workspace_id, snapshot_date, label, kind, payload, rationale, priority,
           target_metric, target_direction)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [
        workspaceId, snapshotDate,
        String(a.label).slice(0, 200),
        String(a.kind).slice(0, 40),
        JSON.stringify(a.payload || {}),
        a.rationale ? String(a.rationale).slice(0, 300) : null,
        Number.isFinite(+a.priority) ? Math.max(1, Math.min(3, +a.priority)) : 2,
        a.target_metric ? String(a.target_metric).slice(0, 60) : null,
        a.target_direction === 'up' || a.target_direction === 'down' ? a.target_direction : null,
      ]);
    }
  } catch (err) {
    console.warn(`[health] action persist failed for ${workspaceName}:`, err.message);
  }

  return { workspace_id: workspaceId, score, band, briefing };
}

// Run snapshots for every active client. Stops early if the perf cache
// hasn't warmed yet — first run after restart waits for it.
async function refreshAllClientHealth() {
  if (!db || !app.locals.pgDb) return;
  if (performanceCache.version === 0) {
    console.log('[health] skipping — performance cache not warm yet');
    return;
  }
  // Phase 2 — evaluate yesterday's completed actions BEFORE building today's
  // briefings so Claude sees the latest helped/no_change/worse history.
  await evaluateActionOutcomes().catch(err => console.warn('[health] evaluator:', err.message));

  const clients = db.prepare(`
    SELECT workspace_id, workspace_name FROM clients
     WHERE COALESCE(client_status,'active') = 'active'
       AND workspace_id NOT IN ('690ee665bcb253de4fb44538','69ce40f616a9cc965746b1a6')
  `).all();
  console.log(`[health] building snapshots for ${clients.length} active clients...`);
  let ok = 0, fail = 0;
  for (const c of clients) {
    try {
      await buildHealthSnapshot(c.workspace_id, c.workspace_name);
      ok++;
    } catch (err) {
      console.warn(`[health] ${c.workspace_name} failed:`, err.message);
      fail++;
    }
  }
  console.log(`[health] snapshots done — ${ok} ok, ${fail} failed`);
}

// First run shortly after perf cache settles, then daily at 7am server time
setTimeout(refreshAllClientHealth, 2 * 60 * 1000);
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 7 && now.getMinutes() < 5) refreshAllClientHealth();
}, 5 * 60 * 1000);

// ── Manager scoping helper ────────────────────────────────────────────
// Returns the list of workspace_ids this session is allowed to see. Admin
// sees everything (except revenue-excluded sandboxes); manager only sees
// clients where clients.campaign_manager = their name.
function visibleWorkspaceIds(req) {
  if (!db) return null;
  const s = decodeSession(req);
  const isAdmin = s?.role === 'admin' || req.headers['x-admin-key'] === ADMIN_KEY;
  const rows = db.prepare(`
    SELECT workspace_id, workspace_name, campaign_manager
      FROM clients
     WHERE COALESCE(client_status,'active') = 'active'
       AND workspace_id NOT IN ('690ee665bcb253de4fb44538','69ce40f616a9cc965746b1a6')
  `).all();
  if (isAdmin) return rows;
  // Manager — scope to assigned clients (case-insensitive match)
  const mgrName = (s?.name || '').trim().toLowerCase();
  return rows.filter(r => (r.campaign_manager || '').trim().toLowerCase() === mgrName);
}

// ── Client Health API endpoints ───────────────────────────────────────

// ── Diagnostics: infrastructure health snapshot ────────────────────────────
app.get('/api/diagnostics/health', requireSession, (req, res) => {
  const mem = process.memoryUsage();
  const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);

  try {
    const { logSignal } = require('./api-diagnostics');
    logSignal({ signal_type: 'infrastructure', metric_key: 'memory_heap_used_mb',
      metric_value: Math.round(mem.heapUsed / 1024 / 1024), unit: 'MB' });
    logSignal({ signal_type: 'infrastructure', metric_key: 'memory_heap_used_pct',
      metric_value: heapPct, unit: '%' });
  } catch(_) {}

  res.json({
    timestamp: new Date(),
    memory: {
      heap_used_mb:  Math.round(mem.heapUsed  / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      rss_mb:        Math.round(mem.rss       / 1024 / 1024),
      heap_pct:      heapPct,
    },
    uptime_s: Math.round(process.uptime()),
    status: heapPct > 85 ? 'critical' : heapPct > 70 ? 'warning' : 'ok',
  });
});

// ── Diagnostics: manually trigger UK external factor scan ─────────────────
app.post('/api/diagnostics/scan-factors', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  try {
    await autoDetectUKExternalFactors(pgdb);
    const today = new Date().toISOString().split('T')[0];
    const r = await pgdb.query(
      `SELECT * FROM diagnostic_external_factors WHERE date = $1 ORDER BY created_at DESC`, [today]
    );
    res.json({ ok: true, factors: r.rows, date: today });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Diagnostics: list external factors ────────────────────────────────────
app.get('/api/diagnostics/external-factors', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  const { days = 30 } = req.query;
  try {
    const r = await pgdb.query(
      `SELECT id, date::text, workspace_id, factor_type, description, severity, created_by, created_at
       FROM diagnostic_external_factors
       WHERE date > CURRENT_DATE - ($1 || ' days')::INTERVAL
       ORDER BY date DESC`,
      [days]
    );
    res.json({ factors: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Diagnostics: log an external factor ───────────────────────────────────
app.post('/api/diagnostics/log-external-factor', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  const { date, factor_type, description, severity = 'medium', regions_affected, expected_impact } = req.body;
  if (!date || !factor_type) return res.status(400).json({ error: 'date and factor_type are required' });
  try {
    const r = await pgdb.query(
      `INSERT INTO diagnostic_external_factors
         (date, factor_type, description, severity, regions_affected, expected_impact, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, date::text, factor_type, description, severity`,
      [date, factor_type, description || '', severity,
       regions_affected || null, expected_impact || null,
       req.session?.username || req.user?.username || 'operator']
    );
    res.json({ factor: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Diagnostics: recent signals for a workspace or global ─────────────────
app.get('/api/diagnostics/signals', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  const { workspace_id, days = 30, signal_type } = req.query;
  try {
    const conditions = ['timestamp > NOW() - ($1 || \' days\')::INTERVAL'];
    const params = [days];
    if (workspace_id) { conditions.push(`workspace_id = $${params.length + 1}`); params.push(workspace_id); }
    if (signal_type)  { conditions.push(`signal_type = $${params.length + 1}`);  params.push(signal_type);  }
    const rows = await pgdb.query(`
      SELECT DATE(timestamp)::text AS date, signal_type, metric_key,
             ROUND(AVG(metric_value)::numeric, 2) AS avg_value,
             MAX(metric_value) AS max_value, MIN(metric_value) AS min_value,
             COUNT(*) AS sample_count,
             MAX(status) AS status
      FROM diagnostic_signals
      WHERE ${conditions.join(' AND ')}
      GROUP BY DATE(timestamp), signal_type, metric_key
      ORDER BY date DESC, signal_type, metric_key
    `, params);
    res.json({ signals: rows.rows, days: Number(days) });
  } catch (err) {
    console.error('[diagnostics] signals query failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Intelligence: daily logs + tier distribution ───────────────────────────
app.get('/api/intelligence/logs', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  const { days = 90 } = req.query;
  try {
    const r = await pgdb.query(`
      SELECT date::text, performance_tier, reply_rate, bounce_rate, warmup_pct,
             api_health, key_signals, correlated_patterns, intelligence_notes
      FROM daily_intelligence_logs
      WHERE date > CURRENT_DATE - ($1 || ' days')::INTERVAL
      ORDER BY date DESC
    `, [days]);
    res.json({ logs: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Intelligence: pattern library ──────────────────────────────────────────
app.get('/api/intelligence/patterns', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  try {
    const r = await pgdb.query(`
      SELECT pattern_type, pattern_value, avg_reply_rate, sample_size,
             correlation_strength, last_updated::text
      FROM performance_patterns
      WHERE sample_size >= 3
      ORDER BY ABS(correlation_strength) DESC, sample_size DESC
    `);
    res.json({ patterns: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Intelligence: manual run for today ────────────────────────────────────
// ── Intelligence: force-clean corrupt data and re-backfill ────────────────
app.get('/api/intelligence/ws-stats', requireAdmin, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  try {
    const r = await pgdb.query(`
      SELECT workspace_id, workspace_name,
        (stats->>'reply_rate_30d')::numeric  AS rr_30d,
        (stats->>'bounce_rate_30d')::numeric AS br_30d,
        (stats->>'sent_30d')::numeric        AS sent_30d,
        (stats->>'replied_30d')::numeric     AS replied_30d
      FROM workspace_stats
      WHERE stats IS NOT NULL
      ORDER BY (stats->>'sent_30d')::numeric DESC NULLS LAST
    `);
    res.json({ workspaces: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/intelligence/perf-sample', requireAdmin, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  try {
    // Show a sample row so we can see the exact JSON structure
    const sample = await pgdb.query(`
      SELECT ws_id, date, data FROM perf_cache_daily
      WHERE COALESCE((data->>'sent')::numeric, 0) > 0
      ORDER BY date DESC LIMIT 3
    `);
    // Also show the aggregate per day so we can see if the field names are right
    const agg = await pgdb.query(`
      SELECT date,
        SUM((data->>'sent')::numeric)    AS sent,
        SUM((data->>'replies')::numeric) AS replies,
        SUM((data->>'bounces')::numeric) AS bounces,
        jsonb_object_keys(data) AS keys
      FROM perf_cache_daily
      WHERE date = (SELECT MAX(date) FROM perf_cache_daily)
      GROUP BY date, jsonb_object_keys(data)
      LIMIT 20
    `);
    res.json({ sample: sample.rows, field_keys: agg.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/intelligence/debug', requireAdmin, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  try {
    // Per workspace per day — to see if the problem is cross-workspace duplication
    const ee = await pgdb.query(`
      SELECT workspace_id, DATE(event_at)::text as date,
        COUNT(*) FILTER (WHERE event_type='sent')   as sends,
        COUNT(*) FILTER (WHERE event_type='reply')  as replies,
        ROUND(100.0 * COUNT(*) FILTER (WHERE event_type='reply') /
          NULLIF(COUNT(*) FILTER (WHERE event_type='sent'),0), 1) as rr_pct
      FROM email_events
      WHERE event_at > NOW() - INTERVAL '7 days'
      GROUP BY workspace_id, DATE(event_at)
      ORDER BY date DESC, sends DESC
      LIMIT 40
    `);
    const logs = await pgdb.query(`
      SELECT date::text, performance_tier, reply_rate
      FROM daily_intelligence_logs ORDER BY date DESC LIMIT 10
    `);
    res.json({ email_events: ee.rows, intelligence_logs: logs.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Deep history backfill — fetch FULL history from PlusVibe per workspace ──
// Fetches each active workspace's daily email-stats over a wide range in one
// call, aggregates per day across workspaces, and seeds daily_intelligence_logs.
app.post('/api/intelligence/deep-backfill', requireAdmin, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  const daysBack = Math.min(parseInt(req.body?.days || 365, 10), 730);
  try {
    const { ensureUniqueConstraint, classifyTier } = require('./api-intelligence');
    await ensureUniqueConstraint(pgdb);

    const end   = serverDateString(new Date());
    const start = serverDateString(new Date(Date.now() - daysBack * 86400000));

    const workspaces = await activePerformanceWorkspaces();
    const wsIds = workspaces.map(w => w.id);

    // Aggregate per-day totals across all workspaces
    const byDate = {}; // date -> { sent, replies, bounces }
    let fetched = 0;
    const CONC = 6;
    for (let i = 0; i < wsIds.length; i += CONC) {
      await Promise.allSettled(wsIds.slice(i, i + CONC).map(async wsId => {
        try {
          // Pass wsId so the per-workspace token (or switch) targets THIS workspace
          // — without it the call hit whatever workspace was active and returned
          // wrong/zero stats.
          var bStats = await bisonFetch('/api/workspaces/v1.1/line-area-chart-stats', { wsId: wsId, params: { start_date: start, end_date: end } });
          var raw = Object.values(pivotBisonStats((bStats.data || bStats) || []));
          const chart = Array.isArray(raw) ? raw : (raw?.chart || []);
          for (const row of chart) {
            const date = (row.date || row.day || '').slice(0, 10);
            if (!date) continue;
            if (!byDate[date]) byDate[date] = { sent: 0, replies: 0, bounces: 0 };
            byDate[date].sent    += row.total_sent_count   || 0;
            byDate[date].replies += row.total_reply_count  || 0;
            byDate[date].bounces += row.total_bounce_count || 0;
          }
          fetched++;
        } catch (e) { /* skip failed workspace */ }
      }));
    }

    // Wipe + reseed intelligence logs from the full history
    await pgdb.query(`TRUNCATE daily_intelligence_logs`);
    await pgdb.query(`TRUNCATE performance_patterns`);
    const { runDailyIntelligence, updatePerformancePatterns } = require('./api-intelligence');

    let seeded = 0;
    const dates = Object.keys(byDate).sort();
    for (const date of dates) {
      const d = byDate[date];
      if (d.sent < 200) continue; // skip low-volume / holiday noise
      const rr = Math.round((d.replies / d.sent) * 10000) / 100;
      const br = Math.round((d.bounces / d.sent) * 10000) / 100;
      const tier = classifyTier(rr, br, null, d.sent);
      const dow = new Date(date + 'T12:00:00Z').getDay();
      const dayName = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][dow];
      const signals = { rr_tier: tier, bounce_health: br < 3 ? 'clean' : br < 6 ? 'ok' : br < 10 ? 'elevated' : 'high',
        send_volume: d.sent >= 1000 ? 'high' : d.sent >= 300 ? 'medium' : 'low', day_of_week: dayName, has_external_factor: false };
      const notes = `${tier === 'excellent' ? 'Strong' : tier === 'good' ? 'Good' : tier === 'fair' ? 'Average' : 'Poor'} day — ${rr}% reply rate (${d.sent} sends).`;
      try {
        await pgdb.query(`
          INSERT INTO daily_intelligence_logs
            (date, workspace_id, performance_tier, reply_rate, bounce_rate, key_signals, correlated_patterns, intelligence_notes)
          VALUES ($1,'global',$2,$3,$4,$5,$6,$7)
          ON CONFLICT (date, workspace_id) DO UPDATE SET
            performance_tier=EXCLUDED.performance_tier, reply_rate=EXCLUDED.reply_rate,
            bounce_rate=EXCLUDED.bounce_rate, key_signals=EXCLUDED.key_signals,
            correlated_patterns=EXCLUDED.correlated_patterns, intelligence_notes=EXCLUDED.intelligence_notes
        `, [date, tier, rr, br, JSON.stringify(signals),
            Object.values(signals).filter(v => typeof v === 'string').slice(0,8), notes]);
        seeded++;
      } catch (e) { /* skip */ }
    }
    await updatePerformancePatterns(pgdb);

    const range = dates.length ? `${dates[0]} → ${dates[dates.length-1]}` : 'none';
    res.json({ ok: true, workspaces_fetched: fetched, days_in_range: dates.length, days_seeded: seeded, date_range: range });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/intelligence/reset', requireAdmin, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  try {
    // Wipe intelligence data and re-backfill from perf_cache_daily
    await pgdb.query(`TRUNCATE daily_intelligence_logs`);
    await pgdb.query(`TRUNCATE performance_patterns`);
    const { ensureUniqueConstraint, backfillIntelligenceLogs, updatePerformancePatterns } = require('./api-intelligence');
    await ensureUniqueConstraint(pgdb);
    await backfillIntelligenceLogs(pgdb);
    await updatePerformancePatterns(pgdb);

    // Also clear + re-seed the diagnostics campaign/bounce signals (Diagnostics page)
    // so both pages read the same perf_cache_daily-derived numbers.
    await pgdb.query(`DELETE FROM diagnostic_signals WHERE signal_type IN ('campaign_metrics','bounce_analysis')`);
    const diagnostics = require('./api-diagnostics');
    diagnostics.init(pgdb);
    const diagRows = await pgdb.query(`
      SELECT date,
        SUM(COALESCE((data->>'sent')::numeric, 0))    AS sends,
        SUM(COALESCE((data->>'replies')::numeric, 0)) AS replies,
        SUM(COALESCE((data->>'bounces')::numeric, 0)) AS bounces
      FROM perf_cache_daily
      WHERE date >= TO_CHAR(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')
      GROUP BY date
      HAVING SUM(COALESCE((data->>'sent')::numeric, 0)) >= 200
      ORDER BY date
    `);
    for (const r of diagRows.rows) {
      const ts = new Date(r.date + 'T23:30:00Z');
      const sends   = parseInt(r.sends)   || 0;
      const replies = parseInt(r.replies) || 0;
      const bounces = parseInt(r.bounces) || 0;
      const rr = sends > 0 ? Math.round((replies / sends) * 10000) / 100 : 0;
      const br = sends > 0 ? Math.round((bounces / sends) * 10000) / 100 : 0;
      diagnostics.logSignal({ timestamp: ts, signal_type: 'campaign_metrics', metric_key: 'daily_sends',          metric_value: sends,   unit: 'count' });
      diagnostics.logSignal({ timestamp: ts, signal_type: 'campaign_metrics', metric_key: 'daily_replies',        metric_value: replies, unit: 'count' });
      diagnostics.logSignal({ timestamp: ts, signal_type: 'campaign_metrics', metric_key: 'daily_reply_rate_pct', metric_value: rr,      unit: '%' });
      diagnostics.logSignal({ timestamp: ts, signal_type: 'bounce_analysis',  metric_key: 'bounce_rate_pct',      metric_value: br,      unit: '%' });
      diagnostics.logSignal({ timestamp: ts, signal_type: 'bounce_analysis',  metric_key: 'bounce_count',         metric_value: bounces, unit: 'count' });
    }
    await diagnostics._flush();

    const check = await pgdb.query(`
      SELECT date::text, performance_tier, reply_rate FROM daily_intelligence_logs
      ORDER BY date DESC LIMIT 7
    `);
    res.json({ ok: true, diag_days: diagRows.rows.length, sample: check.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/intelligence/run-today', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  try {
    const { ensureUniqueConstraint, runDailyIntelligence, updatePerformancePatterns } = require('./api-intelligence');
    await ensureUniqueConstraint(pgdb);
    const today = new Date().toISOString().split('T')[0];
    const result = await runDailyIntelligence(pgdb, today);
    await updatePerformancePatterns(pgdb);
    res.json({ ok: true, result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List clients (scoped) with their latest snapshot. Sorted critical → green
// so the manager sees what needs attention first.
app.get('/api/health/clients', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  const visible = visibleWorkspaceIds(req);
  if (!visible?.length) return res.json({ clients: [], generated_at: null });
  const wsIds = visible.map(v => v.workspace_id);

  try {
    // Latest snapshot per workspace (DISTINCT ON)
    const r = await pgdb.query(`
      SELECT DISTINCT ON (workspace_id)
             workspace_id, snapshot_date, health_score, health_band,
             sent_7d, replies_7d, bounces_7d, leads_7d,
             reply_rate_7d, reply_rate_baseline, bounce_rate_7d,
             reply_rate_gmail_7d, reply_rate_outlook_7d,
             mailbox_total, mailbox_unhealthy, domain_unhealthy, copy_alerts_open,
             lead_target_monthly, leads_mtd, leads_expected_mtd, pace_pct,
             ai_briefing, ai_briefing_source, ai_actions, signals
        FROM client_health_snapshots
       WHERE workspace_id = ANY($1::text[])
       ORDER BY workspace_id, snapshot_date DESC
    `, [wsIds]);

    const byWs = Object.fromEntries(r.rows.map(row => [row.workspace_id, row]));

    // Fetch open (uncompleted, undismissed) actions for each visible client
    // from the latest snapshot only — completed history is shown in detail.
    const actsRes = await pgdb.query(`
      SELECT id, workspace_id, snapshot_date, label, kind, payload, rationale,
             priority, target_metric, target_direction, completed_at, completed_by,
             outcome, outcome_notes, outcome_at, baseline_value, followup_value
        FROM health_actions
       WHERE workspace_id = ANY($1::text[])
         AND dismissed_at IS NULL
         AND snapshot_date = (
           SELECT MAX(snapshot_date) FROM health_actions ha2
            WHERE ha2.workspace_id = health_actions.workspace_id
         )
       ORDER BY priority ASC, id ASC
    `, [wsIds]);
    const actionsByWs = {};
    for (const a of actsRes.rows) {
      (actionsByWs[a.workspace_id] = actionsByWs[a.workspace_id] || []).push(a);
    }

    const clients = visible.map(v => {
      const snap = byWs[v.workspace_id] || null;
      return {
        workspace_id: v.workspace_id,
        workspace_name: v.workspace_name,
        campaign_manager: v.campaign_manager,
        snapshot: snap,
        actions: actionsByWs[v.workspace_id] || [],
        has_data: !!snap,
      };
    });

    // Sort: red → yellow → green → no_data; within band by score asc (lowest first)
    const bandOrder = { red: 0, yellow: 1, green: 2 };
    clients.sort((a, b) => {
      const ba = a.snapshot ? bandOrder[a.snapshot.health_band] ?? 3 : 4;
      const bb = b.snapshot ? bandOrder[b.snapshot.health_band] ?? 3 : 4;
      if (ba !== bb) return ba - bb;
      const sa = a.snapshot?.health_score ?? 100;
      const sb = b.snapshot?.health_score ?? 100;
      return sa - sb;
    });

    res.json({
      clients,
      generated_at: r.rows[0]?.snapshot_date || null,
      ai_enabled: !!ANTHROPIC_API_KEY,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-client detail: today's snapshot + 14-day score trend + open alerts
app.get('/api/health/clients/:wsId', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  const visible = visibleWorkspaceIds(req);
  const wsId = req.params.wsId;
  const meta = (visible || []).find(v => v.workspace_id === wsId);
  if (!meta) return res.status(404).json({ error: 'Not found or not authorized' });

  try {
    const [latest, history, alerts] = await Promise.all([
      pgdb.query(`
        SELECT * FROM client_health_snapshots
         WHERE workspace_id=$1 ORDER BY snapshot_date DESC LIMIT 1
      `, [wsId]),
      pgdb.query(`
        SELECT snapshot_date, health_score, reply_rate_7d, bounce_rate_7d
          FROM client_health_snapshots
         WHERE workspace_id=$1
         ORDER BY snapshot_date DESC LIMIT 14
      `, [wsId]),
      pgdb.query(`
        SELECT ta.*,
               t.subject AS template_subject,
               t.body_excerpt AS template_excerpt
          FROM template_alerts ta
          LEFT JOIN templates t ON t.content_hash = ta.content_hash
         WHERE ta.workspace_id=$1
           AND ta.dismissed_at IS NULL
           AND ta.resolved_at IS NULL
         ORDER BY
           CASE ta.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
           ta.created_at DESC
      `, [wsId]),
    ]);

    res.json({
      workspace_id: wsId,
      workspace_name: meta.workspace_name,
      campaign_manager: meta.campaign_manager,
      snapshot: latest.rows[0] || null,
      history: history.rows.reverse(),
      alerts: alerts.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All open copy alerts for the manager's scope — feeds the page-level
// "Needs fresh copy" panel.
app.get('/api/health/copy-alerts', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  const visible = visibleWorkspaceIds(req);
  if (!visible?.length) return res.json({ alerts: [] });
  const wsIds = visible.map(v => v.workspace_id);
  const wsName = Object.fromEntries(visible.map(v => [v.workspace_id, v.workspace_name]));

  try {
    const r = await pgdb.query(`
      SELECT ta.*,
             t.subject AS template_subject,
             t.body_excerpt AS template_excerpt
        FROM template_alerts ta
        LEFT JOIN templates t ON t.content_hash = ta.content_hash
       WHERE ta.workspace_id = ANY($1::text[])
         AND ta.dismissed_at IS NULL
         AND ta.resolved_at IS NULL
       ORDER BY
         CASE ta.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
         ta.created_at DESC
       LIMIT 100
    `, [wsIds]);

    const alerts = r.rows.map(a => ({
      ...a,
      workspace_name: wsName[a.workspace_id] || a.workspace_id,
    }));
    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss an alert (manual override — useful when the manager intentionally
// keeps using a template the detector flagged as decayed)
app.post('/api/health/copy-alerts/:id/dismiss', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  const visible = visibleWorkspaceIds(req);
  const wsIds = (visible || []).map(v => v.workspace_id);
  try {
    const r = await pgdb.query(`
      UPDATE template_alerts SET dismissed_at = NOW()
       WHERE id=$1 AND workspace_id = ANY($2::text[])
       RETURNING id
    `, [req.params.id, wsIds]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found or not authorized' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI-powered subject-line variant generator. Given a flagged template +
// its current performance, asks Claude for N alternative subject lines
// that preserve the underlying intent but vary the structural pattern.
app.post('/api/health/generate-variants', requireSession, async (req, res) => {
  const { alert_id, count } = req.body || {};
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI features not configured — set ANTHROPIC_API_KEY' });
  const visible = visibleWorkspaceIds(req);
  const wsIds = (visible || []).map(v => v.workspace_id);

  try {
    const r = await pgdb.query(`
      SELECT ta.*, t.subject AS template_subject, t.body AS template_body
        FROM template_alerts ta
        LEFT JOIN templates t ON t.content_hash = ta.content_hash
       WHERE ta.id=$1 AND ta.workspace_id = ANY($2::text[])
       LIMIT 1
    `, [alert_id, wsIds]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Alert not found' });

    // Pull recent top-performing subjects from the SAME workspace as exemplars
    const exemplars = await pgdb.query(`
      SELECT t.subject, COUNT(*) FILTER (WHERE ee.event_type IN ('reply','positive_reply'))::int AS replies,
             COUNT(*) FILTER (WHERE ee.event_type='sent')::int AS sent
        FROM email_events ee
        JOIN templates t ON t.content_hash = ee.content_hash
       WHERE ee.workspace_id=$1
         AND ee.event_at >= NOW() - INTERVAL '60 days'
         AND t.subject IS NOT NULL AND t.subject <> ''
       GROUP BY t.subject
      HAVING COUNT(*) FILTER (WHERE ee.event_type='sent') >= 200
       ORDER BY (COUNT(*) FILTER (WHERE ee.event_type IN ('reply','positive_reply')))::numeric
              / NULLIF(COUNT(*) FILTER (WHERE ee.event_type='sent'),0) DESC
       LIMIT 5
    `, [row.workspace_id]);

    const system = `You are an expert cold-email copywriter. The user gives you ONE subject line that has decayed (provider profiling, fatigue, or over-use). You rewrite it ${count || 5} ways. Each rewrite must:
- Preserve the underlying ask / intent of the original
- Use a DIFFERENT structural pattern (not just word swaps — change the shape: question vs statement, length, opening word, presence/absence of merge tags)
- Stay under 60 characters
- Avoid sounding like marketing (no exclamation points, no "Quick", no "Just", no "I noticed", no power words)
- Be plausible coming from a human one-to-one email

Output STRICT JSON only:
{"variants": ["subject 1", "subject 2", ...]}`;

    const user = JSON.stringify({
      decayed_subject: row.template_subject || '(unknown — only the body is decayed)',
      current_body_excerpt: String(row.template_body || '').slice(0, 600),
      alert_type: row.alert_type,
      lifetime_sends: row.lifetime_sends,
      reply_rate_now: row.reply_rate_current,
      reply_rate_was: row.reply_rate_baseline,
      top_performing_subjects_this_client: exemplars.rows.map(e => e.subject),
    });

    if (process.env.DISABLE_AI_FEATURES === '1') return res.status(503).json({ error: 'AI features temporarily disabled' });
    const out = await callClaude({ system, user, maxTokens: 600, expectJson: true });
    if (!out?.variants) return res.status(502).json({ error: 'AI returned no variants' });
    res.json({ variants: out.variants, alert: {
      campaign_name: row.campaign_name, step: row.step, variant: row.variant,
    } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: diagnose Claude API connectivity. Returns the raw status/body
// from a minimal call so 401/wrong-key/wrong-model show up immediately
// instead of being silently swallowed by the briefing fallback.
app.get('/api/health/ai-test', requireAdmin, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.json({ ok: false, reason: 'no_key', message: 'ANTHROPIC_API_KEY is not set on the server' });
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the single word "ok".' }],
      }),
    });
    const body = await r.text();
    if (r.ok) {
      let parsed = null; try { parsed = JSON.parse(body); } catch {}
      return res.json({
        ok: true,
        model: ANTHROPIC_MODEL,
        reply: parsed?.content?.[0]?.text?.trim() || '(empty)',
        key_preview: ANTHROPIC_API_KEY.slice(0, 18) + '…' + ANTHROPIC_API_KEY.slice(-6),
      });
    }
    res.json({
      ok: false,
      status: r.status,
      model: ANTHROPIC_MODEL,
      key_preview: ANTHROPIC_API_KEY.slice(0, 18) + '…' + ANTHROPIC_API_KEY.slice(-6),
      body: body.slice(0, 500),
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Admin: force a snapshot rebuild for everyone (or one workspace). Useful
// during development and after large config changes.
// Diagnostic: confirms whether the Claude API key is configured and works.
// Returns key_present, key_first/key_last (for visual sanity-check that the
// right value reached the server), and the raw status/error from a 1-token
// hello call. Admin-only — exposes the trailing chars of a secret.
app.get('/api/health/ai-test', requireAdmin, async (req, res) => {
  const key = ANTHROPIC_API_KEY;
  if (!key) return res.json({
    key_present: false,
    model: ANTHROPIC_MODEL,
    status: 'no_key',
    hint: 'Set ANTHROPIC_API_KEY in your env / Easypanel and restart.',
  });
  // Show only enough of the key to spot copy-paste corruption (like the
  // 'conitnue' tail we saw on the first key). Never log the middle.
  const masked = { first: key.slice(0, 14), last: key.slice(-8), length: key.length };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4,
        messages: [{ role: 'user', content: 'Say "ok".' }],
      }),
    });
    const body = await r.text();
    if (r.ok) {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      return res.json({
        key_present: true,
        masked,
        model: ANTHROPIC_MODEL,
        status: 'ok',
        sample_response: parsed?.content?.[0]?.text || '(empty)',
      });
    }
    let error = body.slice(0, 300);
    try { error = JSON.parse(body)?.error?.message || error; } catch {}
    res.json({
      key_present: true,
      masked,
      model: ANTHROPIC_MODEL,
      status: 'api_error',
      http_status: r.status,
      error,
      hint: r.status === 401
        ? 'The key Anthropic received was rejected. Check for copy-paste corruption (extra characters at the end), wrong workspace, or a revoked key.'
        : r.status === 404
          ? `Model "${ANTHROPIC_MODEL}" not available to this key. Try a different ANTHROPIC_MODEL.`
          : 'Inspect "error" above for details.',
    });
  } catch (err) {
    res.json({
      key_present: true,
      masked,
      model: ANTHROPIC_MODEL,
      status: 'network_error',
      error: err.message,
    });
  }
});

app.post('/api/health/refresh', requireAdmin, async (req, res) => {
  const { workspace_id } = req.body || {};
  try {
    if (workspace_id) {
      const c = db.prepare('SELECT workspace_id, workspace_name FROM clients WHERE workspace_id=?').get(workspace_id);
      if (!c) return res.status(404).json({ error: 'Workspace not found' });
      // Run outcome evaluator first so today's briefing sees latest history
      await evaluateActionOutcomes().catch(() => {});
      const out = await buildHealthSnapshot(c.workspace_id, c.workspace_name);
      return res.json({ ok: true, snapshot: out });
    }
    // Fire-and-forget for everyone — refreshAllClientHealth runs the
    // evaluator at the top of its run.
    refreshAllClientHealth().catch(err => console.error('[health] manual refresh:', err));
    res.json({ ok: true, started: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual: run just the outcome evaluator (no snapshot rebuild). Useful when
// testing or after a manual baseline correction.
app.post('/api/health/evaluate-outcomes', requireAdmin, async (req, res) => {
  try {
    const out = await evaluateActionOutcomes();
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark a single action as done. Records who did it + when, plus a snapshot
// of the action's target metric as the baseline so the outcome evaluator
// (next phase) can decide 24-72h later whether the action moved it.
app.post('/api/health/actions/:id/complete', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  const s = decodeSession(req);
  const who = s?.name || 'Admin';
  const visible = visibleWorkspaceIds(req);
  const wsIds = (visible || []).map(v => v.workspace_id);

  try {
    // Look up the action + its target metric current value from the latest
    // snapshot. Same query also enforces manager-scope.
    const aRes = await pgdb.query(`
      SELECT a.id, a.workspace_id, a.target_metric, a.snapshot_date
        FROM health_actions a
       WHERE a.id = $1 AND a.workspace_id = ANY($2::text[])
         AND a.completed_at IS NULL AND a.dismissed_at IS NULL
       LIMIT 1
    `, [req.params.id, wsIds]);
    const act = aRes.rows[0];
    if (!act) return res.status(404).json({ error: 'Action not found, already done, or not authorized' });

    let baseline = null;
    if (act.target_metric) {
      // Read the metric value from the most recent snapshot (= the state
      // BEFORE the action took effect). The outcome evaluator will compare
      // a future snapshot's value of the same metric against this.
      const sRes = await pgdb.query(
        `SELECT ${act.target_metric.replace(/[^a-z0-9_]/gi,'')} AS v
           FROM client_health_snapshots
          WHERE workspace_id=$1 ORDER BY snapshot_date DESC LIMIT 1`,
        [act.workspace_id]
      );
      baseline = sRes.rows[0]?.v ?? null;
    }

    await pgdb.query(`
      UPDATE health_actions
         SET completed_at = CURRENT_TIMESTAMP,
             completed_by = $1,
             baseline_value = $2
       WHERE id = $3
    `, [who, baseline, req.params.id]);

    res.json({ ok: true, completed_by: who, baseline_value: baseline });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Undo a completed action — lets the manager untick if they ticked the
// wrong box. Wipes outcome data too since the baseline is no longer valid.
app.post('/api/health/actions/:id/uncomplete', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  const visible = visibleWorkspaceIds(req);
  const wsIds = (visible || []).map(v => v.workspace_id);
  try {
    const r = await pgdb.query(`
      UPDATE health_actions
         SET completed_at = NULL, completed_by = NULL, baseline_value = NULL,
             followup_value = NULL, outcome = NULL, outcome_at = NULL,
             outcome_notes = NULL
       WHERE id=$1 AND workspace_id = ANY($2::text[]) AND completed_at IS NOT NULL
      RETURNING id
    `, [req.params.id, wsIds]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found or not completed' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss an action — manager decided not to do it. Optional reason.
app.post('/api/health/actions/:id/dismiss', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database not available' });
  const s = decodeSession(req);
  const who = s?.name || 'Admin';
  const reason = String(req.body?.reason || '').slice(0, 200);
  const visible = visibleWorkspaceIds(req);
  const wsIds = (visible || []).map(v => v.workspace_id);
  try {
    const r = await pgdb.query(`
      UPDATE health_actions
         SET dismissed_at = CURRENT_TIMESTAMP,
             dismissed_by = $1,
             dismissed_reason = $2
       WHERE id=$3 AND workspace_id = ANY($4::text[])
         AND completed_at IS NULL AND dismissed_at IS NULL
      RETURNING id
    `, [who, reason || null, req.params.id, wsIds]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found or already actioned' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─────────────────────────────────────────────────────────────────────
// Domain Health — free per-domain reputation snapshot
// (SPF / DKIM / DMARC / MX / DNS blacklists). No Google Postmaster account
// needed; runs nightly and persists in Postgres so the page loads instantly.
// ─────────────────────────────────────────────────────────────────────
const dnsPromises = require('dns').promises;

// Domain-based blacklists (DBLs) — query the domain itself, not its IPs.
// MX IPs are the *inbound* mail servers (usually Outlook 365 / Google), not
// the domain's sending IPs, so IP-blacklist checks against MX records are
// irrelevant for sending reputation. Domain-level DBLs are the right signal.
const DOMAIN_BLACKLISTS = [
  { name: 'Spamhaus DBL', host: 'dbl.spamhaus.org' },
  { name: 'SURBL',        host: 'multi.surbl.org' },
  { name: 'URIBL Black',  host: 'black.uribl.com' },
];

// Valid "listed" response range for most DNSBLs: 127.0.0.2-127.0.0.99.
// Codes outside this (e.g. 127.255.255.x) are query-rate-limit / "you are
// not allowed to query us" replies and MUST NOT be counted as hits.
function isRealDnsblHit(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  if (parts[0] !== 127 || parts[1] !== 0 || parts[2] !== 0) return false;
  return parts[3] >= 2 && parts[3] <= 99;
}

async function dnsTxtSafe(name) {
  try { return await dnsPromises.resolveTxt(name); } catch { return null; }
}

async function checkSpf(domain) {
  const records = await dnsTxtSafe(domain);
  if (!records) return { present: false, raw: null, valid: false };
  const spf = records.map(r => r.join('')).find(r => /^v=spf1/i.test(r));
  if (!spf) return { present: false, raw: null, valid: false };
  // Basic validity: must end with -all, ~all, ?all, or +all
  const valid = /(-all|~all|\?all|\+all)$/i.test(spf.trim());
  const strict = /-all\s*$/i.test(spf.trim());
  return { present: true, raw: spf, valid, strict };
}

async function checkDmarc(domain) {
  const records = await dnsTxtSafe(`_dmarc.${domain}`);
  if (!records) return { present: false, raw: null, valid: false, policy: null };
  const dmarc = records.map(r => r.join('')).find(r => /^v=DMARC1/i.test(r));
  if (!dmarc) return { present: false, raw: null, valid: false, policy: null };
  const m = dmarc.match(/p=(none|quarantine|reject)/i);
  const policy = m ? m[1].toLowerCase() : null;
  return { present: true, raw: dmarc, valid: true, policy };
}

async function checkDkim(domain) {
  // DKIM selectors vary by provider; check the common ones. A "present"
  // result means at least one well-known selector exists.
  const selectors = ['google', 'selector1', 'selector2', 'k1', 's1', 's2', 'default', 'mail', 'dkim', 'hostingermail-a', 'hostingermail-b', 'zoho', 'pm', 'protonmail', 'cloudflare1', 'cloudflare2'];
  for (const sel of selectors) {
    const r = await dnsTxtSafe(`${sel}._domainkey.${domain}`);
    if (r && r.length) {
      const raw = r.map(x => x.join('')).find(x => /v=DKIM1|p=/i.test(x));
      if (raw) return { present: true, selector: sel, raw };
    }
  }
  return { present: false, selector: null, raw: null };
}

async function checkMx(domain) {
  try {
    const mxs = await dnsPromises.resolveMx(domain);
    if (!mxs?.length) return { present: false, hosts: [], ips: [] };
    mxs.sort((a, b) => a.priority - b.priority);
    const top = mxs[0].exchange;
    let ips = [];
    try { ips = await dnsPromises.resolve4(top); } catch {}
    return { present: true, hosts: mxs.map(m => `${m.priority} ${m.exchange}`), top, ips };
  } catch {
    return { present: false, hosts: [], ips: [] };
  }
}

async function checkBlacklists(domain) {
  const hits = [];
  if (!domain) return hits;
  for (const bl of DOMAIN_BLACKLISTS) {
    try {
      const r = await dnsPromises.resolve4(`${domain}.${bl.host}`);
      // Only count standard listing codes (127.0.0.2-127.0.0.99). Codes
      // like 127.255.255.x mean "rate-limited / not authorised to query"
      // — not a real listing. MXToolbox-style false positives we saw
      // came from treating ANY A response as a hit.
      const real = (r || []).find(isRealDnsblHit);
      if (real) hits.push({ target: domain, list: bl.name, response: real });
    } catch { /* NXDOMAIN = not listed */ }
  }
  return hits;
}

function scoreDomain({ spf, dkim, dmarc, mx, blacklists }) {
  let score = 100;
  const notes = [];
  if (!spf.present)       { score -= 25; notes.push('Missing SPF'); }
  else if (!spf.valid)    { score -= 10; notes.push('SPF invalid'); }
  else if (!spf.strict)   { score -= 5;  notes.push('SPF not strict (-all)'); }
  if (!dkim.present)      { score -= 25; notes.push('No DKIM record found'); }
  if (!dmarc.present)     { score -= 25; notes.push('Missing DMARC'); }
  else if (dmarc.policy === 'none') { score -= 10; notes.push('DMARC p=none'); }
  if (!mx.present)        { score -= 20; notes.push('No MX records'); }
  if (blacklists.length)  { score -= 15 * blacklists.length; notes.push(`Blacklisted on ${blacklists.length}`); }
  score = Math.max(0, score);
  const status = score >= 80 ? 'good' : score >= 50 ? 'warning' : 'critical';
  return { score, status, notes };
}

async function checkDomain(domain, ws) {
  const [spf, dkim, dmarc, mx] = await Promise.all([
    checkSpf(domain),
    checkDkim(domain),
    checkDmarc(domain),
    checkMx(domain),
  ]);
  // Check the DOMAIN against domain-blacklists (DBLs), not MX IPs.
  // MX IPs point to the inbound mail provider (Outlook/Google) — they
  // don't reflect this domain's sending reputation.
  const blacklists = await checkBlacklists(domain);
  const { score, status, notes } = scoreDomain({ spf, dkim, dmarc, mx, blacklists });
  return {
    domain,
    workspace_id:   ws?.id || null,
    workspace_name: ws?.name || null,
    spf, dkim, dmarc, mx, blacklists,
    score, status,
    notes: notes.join('; ') || null,
  };
}

// Pull the list of sending mailboxes from PlusVibe across all workspaces.
// We try a small matrix of (method, path) candidates on the FIRST workspace
// then cache the winner and use it for the rest. This avoids guessing the
// path 50× and is robust to PlusVibe docs being out of date.
const ACCOUNT_LIST_CANDIDATES = [
  { method: 'POST', path: '/account/list',          body: ws => ({ workspace_id: ws.id, limit: 500, skip: 0 }) },
  { method: 'GET',  path: ws => `/account/list?workspace_id=${ws.id}&limit=500` },
  { method: 'GET',  path: ws => `/account?workspace_id=${ws.id}&limit=500` },
  { method: 'GET',  path: ws => `/account/list-all?workspace_id=${ws.id}&limit=500` },
  { method: 'POST', path: '/email-account/list',    body: ws => ({ workspace_id: ws.id, limit: 500, skip: 0 }) },
  { method: 'GET',  path: ws => `/email-account/list?workspace_id=${ws.id}&limit=500` },
  { method: 'POST', path: '/account',                body: ws => ({ workspace_id: ws.id, limit: 500, skip: 0 }) },
];

async function callAccountList(candidate, ws) {
  if (candidate.method === 'POST') {
    return pvFetch(candidate.path, 5, { method: 'POST', body: candidate.body(ws) });
  }
  return pvFetch(candidate.path(ws));
}

// Inactive clients (set on the Clients page) shouldn't appear on the
// Domains or Mailboxes dashboards — they aren't sending, and showing
// their old infra muddies the per-supplier/per-type comparisons.
function inactiveWorkspaceIds() {
  try {
    const rows = db.prepare(`SELECT workspace_id, client_status FROM clients`).all();
    return new Set(rows.filter(r => r.client_status === 'inactive').map(r => r.workspace_id));
  } catch { return new Set(); }
}

async function listSendingMailboxes() {
  // Source sending mailboxes from EmailBison (the PlusVibe API key is deprecated).
  // Iterate ALL Bison workspaces (live from /api/workspaces/v1.1) — not just the
  // hardcoded BISON_TEAMS — so every client's mailboxes appear, including new
  // workspaces not yet added to the map. Each Bison team is tagged with its
  // canonical PV id (from BISON_TEAMS) when known, so client-status filtering and
  // joins keep matching; unmapped teams fall back to the Bison id.
  const mailboxes = [];
  const seenEmails = new Set();
  const PER_PAGE = 200;

  const pvByTeamId = new Map(BISON_TEAMS.map(t => [String(t.team_id), t]));
  let teams = [];
  try {
    const wsRaw = listBisonWorkspaces();
    const list = Array.isArray(wsRaw) ? wsRaw : (wsRaw?.data || []);
    teams = list.map(w => {
      const mapped = pvByTeamId.get(String(w.id));
      return {
        team_id: String(w.id),
        name: mapped ? mapped.name : (w.name || `Workspace ${w.id}`),
        pv: mapped ? mapped.pv : String(w.id), // unmapped → key by Bison id
      };
    });
  } catch (err) {
    console.warn('[mailboxes] live workspace list failed, falling back to BISON_TEAMS:', err.message);
    teams = BISON_TEAMS;
  }

  // Prior cache, keyed by team, so a workspace that FAILS to fetch this run keeps
  // its last-known mailboxes instead of silently vanishing from the view. A
  // transient auth blip (e.g. an expired Bison key) must never shrink the count
  // without warning — that is how Winnr's 655 quietly became 605.
  const prevByTeam = new Map();
  for (const m of (_mailboxCache.mailboxes || [])) {
    const k = String(m.bison_team_id ?? m.workspace_id);
    if (!prevByTeam.has(k)) prevByTeam.set(k, []);
    prevByTeam.get(k).push(m);
  }
  const failedTeams = [];

  for (const team of teams) {
    try {
      let found = 0;
      let prevSig = '';
      // Bison /api/sender-emails is paginated and IGNORES per_page — it returns a
      // fixed ~15 rows/page. So we must page until a page comes back EMPTY (not
      // "shorter than per_page", which would stop after page 1). We dedup emails
      // GLOBALLY across workspaces, so "no new emails this page" is NOT a safe stop
      // signal — instead detect Bison repeating a page by its row-id signature.
      // Cap pages high enough for the biggest workspace (15/page × ~1000 ≈ 70).
      for (let page = 1; page <= 300; page++) {
        const resp = await bisonReq('/api/sender-emails', { wsId: team.team_id, params: { per_page: PER_PAGE, page } });
        const list = Array.isArray(resp) ? resp : (resp?.data ?? []);
        if (!list.length) break; // no more rows for this workspace
        const sig = list.map(a => a.id ?? a.email ?? '').join(',');
        if (sig === prevSig) break; // Bison repeated the same page → reached the end
        prevSig = sig;
        for (const a of list) {
          const email = (a.email || a.email_address || a.name || '').toString().trim().toLowerCase();
          if (!email.includes('@') || seenEmails.has(email)) continue;
          seenEmails.add(email);
          mailboxes.push({
          email,
          account_id: a.id != null ? String(a.id) : null,
          domain: email.split('@')[1],
          workspace_id: team.pv,          // canonical client id (PV workspace_id)
          workspace_name: team.name,
          bison_team_id: team.team_id,
          status: a.status === 'connected' ? 'active' : (a.status || (a.is_connected === false ? 'inactive' : 'active')),
          warmup_status: (a.warmup_enabled ?? a.warmup?.enabled) ? 'ACTIVE' : 'PAUSED',
          provider: a.type || a.provider || a.smtp_host || null,
          name: a.name || [a.first_name, a.last_name].filter(Boolean).join(' ') || null,
          daily_limit: typeof a.daily_limit === 'number' ? a.daily_limit : null,
          sending_gap: null,
          warmup_limit: a.warmup?.daily_limit ?? null,
          warmup_reply_rate: null,
          warmup_enabled_at: null,
          campaigns_count: 0,
          campaign_ids: [],
          created_at: a.created_at || null,
          updated_at: a.updated_at || null,
          });
          found++;
        }
      }
      if (found) console.log(`[mailboxes] ${team.name}: ${found} mailbox(es)`);
      await new Promise(r => setTimeout(r, 250)); // pace between workspaces
    } catch (err) {
      console.warn(`[mailboxes] sender-emails failed for ${team.name} (team ${team.team_id}):`, err.message);
      // Fail-safe: keep this workspace's previously-cached mailboxes so a transient
      // fetch failure doesn't drop them from the count. Dedup against what we have.
      const prev = prevByTeam.get(String(team.team_id)) || [];
      let kept = 0;
      for (const m of prev) {
        const email = (m.email || '').toString().trim().toLowerCase();
        if (!email.includes('@') || seenEmails.has(email)) continue;
        seenEmails.add(email);
        mailboxes.push(m);
        kept++;
      }
      failedTeams.push({ name: team.name, team_id: team.team_id, kept, error: err.message });
      if (kept) console.warn(`[mailboxes] ${team.name}: retained ${kept} prior-cached mailbox(es) after fetch failure`);
    }
  }
  if (failedTeams.length) {
    console.warn(`[mailboxes] ${failedTeams.length} workspace(s) failed this refresh (kept prior data): ` +
      failedTeams.map(f => `${f.name}(${f.kept})`).join(', '));
  }
  _mailboxCache.failedTeams = failedTeams; // surfaced via /api/mailboxes/refresh status
  console.log(`[mailboxes] total ${mailboxes.length} across ${teams.length} workspaces` +
    (failedTeams.length ? ` (${failedTeams.length} ws failed, prior data retained)` : ''));
  return mailboxes;
}

// Group mailboxes into a unique domain list with first-seen workspace
// (used for the per-domain DNS + blacklist scan).
function mailboxesToDomains(mailboxes) {
  const map = new Map();
  for (const m of mailboxes) {
    if (!map.has(m.domain)) map.set(m.domain, { id: m.workspace_id, name: m.workspace_name });
  }
  return Array.from(map, ([domain, ws]) => ({ domain, ws }));
}

// Backwards-compat alias for the refresh loop below.
async function listSendingDomains() {
  return mailboxesToDomains(await listSendingMailboxes());
}

let _domainHealthRunning = false;
async function refreshDomainHealth() {
  if (_domainHealthRunning) return;
  _domainHealthRunning = true;
  const t0 = Date.now();
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return;
    const allDomains = await listSendingDomains();
    // Skip ignored (soft-deleted) domains so a user-removed row doesn't
    // come back on the next refresh.
    const ignored = new Set(await pgdb.listIgnoredDomains());
    const domains = allDomains.filter(d => !ignored.has(d.domain));
    console.log(`[domain-health] checking ${domains.length} domains (${ignored.size} ignored)…`);
    // Process in parallel batches to keep DNS load reasonable.
    const CONCURRENCY = 8;
    let done = 0;
    for (let i = 0; i < domains.length; i += CONCURRENCY) {
      const batch = domains.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async ({ domain, ws }) => {
        try {
          const row = await checkDomain(domain, ws);
          await pgdb.upsertDomainHealth(row);
          done++;
        } catch (err) {
          console.warn(`[domain-health] ${domain} failed:`, err.message);
        }
      }));
    }
    console.log(`[domain-health] done ${done}/${domains.length} in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (err) {
    console.error('[domain-health] refresh error:', err.message);
  } finally {
    _domainHealthRunning = false;
  }
}

// First run 60s after startup, then every 6 hours.
setTimeout(refreshDomainHealth, 120000); // last to start — DNS checks are slow and shouldn't compete
setInterval(refreshDomainHealth, 6 * 60 * 60 * 1000);

app.get('/api/domains/health', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.json({ rows: [], lastRun: null });
    const rows = await pgdb.listDomainHealth();
    res.json({ rows, lastRun: rows[0]?.last_checked || null, running: _domainHealthRunning });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/domains/refresh', requireSession, async (req, res) => {
  if (_domainHealthRunning) return res.json({ ok: true, message: 'Refresh already running' });
  refreshDomainHealth().catch(() => {});
  res.json({ ok: true, message: 'Domain health refresh started' });
});

// Single-domain on-demand check (useful when adding a new client)
app.post('/api/domains/check', requireSession, async (req, res) => {
  try {
    const domain = (req.body?.domain || '').toString().trim().toLowerCase();
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain' });
    }
    const row = await checkDomain(domain, null);
    const pgdb = app.locals.pgDb;
    if (pgdb) await pgdb.upsertDomainHealth(row);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Soft-delete a domain from the dashboard. The row is kept (so we can
// restore later) but the auto-refresh won't re-add it from PlusVibe.
app.delete('/api/domains/:domain', requireSession, async (req, res) => {
  try {
    const domain = (req.params.domain || '').toLowerCase();
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain' });
    }
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
    const r = await pgdb.setDomainIgnored(domain, true);
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore (un-ignore) a domain so the next refresh picks it back up.
app.post('/api/domains/:domain/restore', requireSession, async (req, res) => {
  try {
    const domain = (req.params.domain || '').toLowerCase();
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
    const r = await pgdb.setDomainIgnored(domain, false);
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/domains', (req, res) => res.sendFile(path.join(__dirname, 'domains.html')));
app.get('/domains.html', (req, res) => res.sendFile(path.join(__dirname, 'domains.html')));

// ─────────────────────────────────────────────────────────────────────
// Gateway deliverability — reply/lead/bounce per inbound email gateway
// (Mimecast, Proofpoint, Barracuda, Cisco, Google, Microsoft, ...).
//
// The gateway is NOT stored: contacts.mx_provider only buckets to
// google/outlook/other. scripts/gateway-analysis.js re-resolves MX into the
// gateway_mx_cache table; this endpoint joins that cache to live contact facts.
//   - sent  = contacts.emailed_workspaces <> '{}'  (NOT email_events 'sent',
//             whose webhook coverage is incomplete)
//   - reply = email_events by lead_email, counted DISTINCT (rows are dup'd)
//   - OOO   = email_events.raw->>'label' OUT_OF_OFFICE/AUTOMATIC_REPLY
app.get('/api/gateway-analysis', requireSession, async (req, res) => {
  try {
    const { rows } = await pgdb.query(`
      WITH sent AS (
        SELECT c.id,
               lower(split_part(c.email,'@',2)) AS domain,
               lower(c.email)                   AS email,
               c.bounced_at
        FROM contacts c
        WHERE COALESCE(c.emailed_workspaces,'{}'::jsonb) <> '{}'::jsonb
          AND c.email LIKE '%@%'
      ),
      ev AS (
        SELECT lower(lead_email) AS email,
               bool_or(event_type IN ('reply','positive_reply','all_email_replies')) AS replied,
               bool_or(event_type IN ('reply','positive_reply','all_email_replies')
                       AND COALESCE(raw->>'label','') NOT IN ('OUT_OF_OFFICE','AUTOMATIC_REPLY')) AS replied_substantive,
               bool_or(event_type = 'lead'
                       OR raw->>'label' IN ('LEAD','INTERESTED_NONLEAD'))            AS is_lead,
               -- Bounce class from the SMTP reason in raw.msg (no stored type).
               -- 3-way, NOT naive 5xx=hard: a 5xx can be a reputation/policy
               -- BLOCK (gateway rejecting the sender), which must not count as a
               -- dead address. Order: block > hard > soft.
               bool_or(event_type = 'bounce' AND lower(raw->>'msg') ~ '5\.[01]\.[0-9]|55[04]|no such user|user unknown|does not exist|recipientnotfound|recipient not found|mailbox unavailable|address rejected|unknown recipient|invalid recipient|mailbox disabled|no mailbox|account.*disabled|unable to verify user|account or domain|no longer|not found'
                       AND NOT lower(raw->>'msg') ~ 'spam|blacklist|black list|spamhaus|dbl|surbl|reputation|polic|open relay|rate|unsolicited|rejected by organization|denylist|rbl|access denied|not allowed to send|barracuda|blocked|block list|5\.7\.|not authorized|sender denied|sendernotauth|denied|mail loop|hop count') AS bounce_hard,
               bool_or(event_type = 'bounce' AND lower(raw->>'msg') ~ 'spam|blacklist|black list|spamhaus|dbl|surbl|reputation|polic|open relay|rate|unsolicited|rejected by organization|denylist|rbl|access denied|not allowed to send|barracuda|blocked|block list|5\.7\.|not authorized|sender denied|sendernotauth|denied|mail loop|hop count') AS bounce_block,
               bool_or(event_type = 'bounce' AND lower(raw->>'msg') ~ '4\.[0-9]\.[0-9]|45[0-9]|temporar|try again|greylist|grey list|deferred|quota|mailbox full|out of storage|over quota|too many|server.*busy|timeout|throttl|retry'
                       AND NOT lower(raw->>'msg') ~ 'spam|blacklist|spamhaus|dbl|surbl|reputation|polic|open relay|unsolicited|rejected by organization|denylist|rbl|access denied|not allowed to send|barracuda|blocked|block list|5\.7\.|not authorized|sender denied|sendernotauth|denied|mail loop|hop count') AS bounce_soft
        FROM email_events
        GROUP BY 1
      ),
      per_contact AS (
        SELECT COALESCE(g.gateway,'NO MX / unresolved') AS gateway,
               s.domain,
               e.replied,
               e.replied_substantive,
               e.is_lead,
               e.bounce_hard,
               (e.bounce_block AND NOT e.bounce_hard)                       AS bounce_block,
               (e.bounce_soft AND NOT e.bounce_hard AND NOT e.bounce_block) AS bounce_soft
        FROM sent s
        JOIN gateway_mx_cache g ON g.domain = s.domain
        LEFT JOIN ev e ON e.email = s.email
      )
      SELECT gateway,
             count(DISTINCT domain)                  AS domains,
             count(*)                                 AS sent,
             count(*) FILTER (WHERE replied)          AS replied,
             count(*) FILTER (WHERE replied_substantive) AS replied_no_ooo,
             count(*) FILTER (WHERE is_lead)          AS leads,
             count(*) FILTER (WHERE bounce_hard)      AS bounced_hard,
             count(*) FILTER (WHERE bounce_block)     AS bounced_block,
             count(*) FILTER (WHERE bounce_soft)      AS bounced_soft
      FROM per_contact
      GROUP BY gateway
      ORDER BY sent DESC`);

    const gateways = rows.map(r => {
      const sent = Number(r.sent);
      const replied = Number(r.replied);
      const repliedNoOoo = Number(r.replied_no_ooo);
      const leads = Number(r.leads);
      const hard = Number(r.bounced_hard);
      const block = Number(r.bounced_block);
      const soft = Number(r.bounced_soft);
      return {
        gateway: r.gateway,
        domains: Number(r.domains),
        sent,
        replyRate:      sent ? (100 * replied) / sent : 0,
        replyRateNoOoo: sent ? (100 * repliedNoOoo) / sent : 0,
        leadRate:       sent ? (100 * leads) / sent : 0,
        rtl:            sent ? (1000 * leads) / sent : 0,  // leads per 1,000 sent
        // 3-way bounce split: hard=dead address, block=gateway rejected sender, soft=temporary
        hardRate:       sent ? (100 * hard) / sent : 0,
        blockRate:      sent ? (100 * block) / sent : 0,
        softRate:       sent ? (100 * soft) / sent : 0,
        replied, leads,
      };
    });

    // Coverage = of the domains we've SENT to, how many are resolved. (The cache
    // also holds never-emailed domains from the full-DB scan, so counting the
    // whole cache would exceed 100%.)
    const cov = await pgdb.query(`
      WITH sent_domains AS (
        SELECT DISTINCT lower(split_part(email,'@',2)) AS domain
        FROM contacts
        WHERE COALESCE(emailed_workspaces,'{}'::jsonb) <> '{}'::jsonb
          AND email LIKE '%@%'
      )
      SELECT
        (SELECT count(*) FROM sent_domains s JOIN gateway_mx_cache g ON g.domain = s.domain) AS resolved,
        (SELECT count(*) FROM sent_domains) AS total`);

    res.json({
      gateways,
      coverage: {
        resolved: Number(cov.rows[0] && cov.rows[0].resolved || 0),
        total:    Number(cov.rows[0] && cov.rows[0].total || 0),
      },
    });
  } catch (err) {
    console.error('[gateway-analysis]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/gateway-analysis',      (req, res) => res.sendFile(path.join(__dirname, 'gateway-analysis.html')));
app.get('/gateway-analysis.html', (req, res) => res.sendFile(path.join(__dirname, 'gateway-analysis.html')));

// ─────────────────────────────────────────────────────────────────────
// Google Postmaster Tools — daily domain + IP reputation, spam rate
// ─────────────────────────────────────────────────────────────────────
// Set GOOGLE_POSTMASTER_KEY_JSON (inline JSON) or GOOGLE_POSTMASTER_KEY_FILE
// (path to a service account key file) to enable. The service account must
// be added as a user in Postmaster Tools (postmaster.google.com → Settings).

let _postmasterRunning = false;
let _postmasterLastRun = null;

function getPostmasterAuth() {
  const keyJson = process.env.GOOGLE_POSTMASTER_KEY_JSON;
  const keyFile = process.env.GOOGLE_POSTMASTER_KEY_FILE;
  if (!keyJson && !keyFile) return null;
  const opts = { scopes: ['https://www.googleapis.com/auth/postmaster.readonly'] };
  try {
    if (keyJson) opts.credentials = JSON.parse(keyJson);
    else opts.keyFile = keyFile;
  } catch (e) {
    console.error('[postmaster] Failed to parse credentials:', e.message);
    return null;
  }
  return new google.auth.GoogleAuth(opts);
}

// Returns the worst (lowest) reputation tier present in the ipReputations array.
// Ordering: BAD < LOW < MEDIUM < HIGH.
function _worstIpRep(ipReputations) {
  if (!Array.isArray(ipReputations) || !ipReputations.length) return null;
  for (const rep of ['BAD', 'LOW', 'MEDIUM', 'HIGH']) {
    if (ipReputations.some(r => r.reputation === rep && parseInt(r.numIps || 0) > 0)) return rep;
  }
  return ipReputations[0]?.reputation || null;
}

async function _postmasterGet(auth, path) {
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const url = `https://gmailpostmastertools.googleapis.com/v1/${path}`;
  const r = await new Promise((resolve, reject) => {
    const https = require('https');
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { Authorization: `Bearer ${token.token}` },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${parsed.error?.message || body}`));
          else resolve(parsed);
        } catch (e) { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
  return r;
}

async function refreshPostmasterData() {
  if (_postmasterRunning) return;
  _postmasterRunning = true;
  const t0 = Date.now();
  try {
    const auth = getPostmasterAuth();
    if (!auth) {
      console.log('[postmaster] No credentials — set GOOGLE_POSTMASTER_KEY_JSON or GOOGLE_POSTMASTER_KEY_FILE');
      return;
    }
    const pgdb = app.locals.pgDb;
    if (!pgdb) return;

    const { domains = [] } = await _postmasterGet(auth, 'domains');
    console.log(`[postmaster] ${domains.length} domain(s) registered in Postmaster Tools`);

    for (const d of domains) {
      const domName = (d.name || '').replace(/^domains\//, '');
      if (!domName) continue;
      try {
        // Fetch last 7 days of stats; pageSize=7 is enough for daily alerting
        const { trafficStats = [] } = await _postmasterGet(auth, `${d.name}/trafficStats?pageSize=7`);
        for (const stat of trafficStats) {
          // stat.name = "domains/example.com/trafficStats/2024/01/15"
          const parts = (stat.name || '').split('/');
          const date = parts.slice(-3).join('-'); // "2024-01-15"
          const spamRate = stat.userReportedSpamRatio ?? null;
          await pgdb.upsertPostmasterData(domName, date, {
            domain_reputation: stat.domainReputation === 'REPUTATION_CATEGORY_UNSPECIFIED' ? null : (stat.domainReputation || null),
            ip_reputation: _worstIpRep(stat.ipReputations),
            spam_rate: spamRate,
            spf_pass_rate: stat.spfSuccessRatio ?? null,
            dkim_pass_rate: stat.dkimSuccessRatio ?? null,
            dmarc_pass_rate: stat.dmarcSuccessRatio ?? null,
            ip_reputations: stat.ipReputations || [],
            raw_data: stat,
          });
        }
        if (trafficStats.length) console.log(`[postmaster] ${domName}: ${trafficStats.length} day(s) stored`);
      } catch (err) {
        console.warn(`[postmaster] ${domName} failed:`, err.message);
      }
    }
    _postmasterLastRun = new Date().toISOString();
    console.log(`[postmaster] done in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (err) {
    console.error('[postmaster] refresh error:', err.message);
  } finally {
    _postmasterRunning = false;
  }
}

// Run once at startup (after 2 min) then every 24 h.
setTimeout(() => { if (getPostmasterAuth()) refreshPostmasterData().catch(() => {}); }, 2 * 60 * 1000);
setInterval(() => { if (getPostmasterAuth()) refreshPostmasterData().catch(() => {}); }, 24 * 60 * 60 * 1000);

app.get('/api/postmaster/status', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.json({ rows: [], lastRun: null, configured: false });
    const rows = await pgdb.listPostmasterLatest();
    const configured = !!(process.env.GOOGLE_POSTMASTER_KEY_JSON || process.env.GOOGLE_POSTMASTER_KEY_FILE);
    const winnr_configured = !!process.env.WINNR_API_TOKEN;
    res.json({ rows, lastRun: _postmasterLastRun, running: _postmasterRunning, configured, winnr_configured });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/postmaster/refresh', requireSession, async (req, res) => {
  if (_postmasterRunning) return res.json({ ok: true, message: 'Refresh already running' });
  if (!getPostmasterAuth()) return res.status(400).json({ error: 'Postmaster credentials not configured. Set GOOGLE_POSTMASTER_KEY_JSON or GOOGLE_POSTMASTER_KEY_FILE in your .env.' });
  refreshPostmasterData().catch(() => {});
  res.json({ ok: true, message: 'Postmaster refresh started' });
});

app.get('/api/postmaster/history/:domain', requireSession, async (req, res) => {
  try {
    const domain = (req.params.domain || '').toLowerCase();
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.json({ rows: [] });
    const rows = await pgdb.listPostmasterHistory(domain, 30);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/postmaster', (req, res) => res.sendFile(path.join(__dirname, 'postmaster.html')));
app.get('/postmaster.html', (req, res) => res.sendFile(path.join(__dirname, 'postmaster.html')));

// ─────────────────────────────────────────────────────────────────────
// Winnr DNS + Google Site Verification — bulk domain registration
// ─────────────────────────────────────────────────────────────────────
// Flow: register-winnr adds a google-site-verification TXT to each
// domain via the Winnr DNS API, then verify-winnr calls Google Site
// Verification API to confirm ownership so the service account can
// read Postmaster data for those domains.

const WINNR_BASE = 'https://api.winnr.app';

function _winnrRequest(method, path, body) {
  const token = process.env.WINNR_API_TOKEN;
  if (!token) return Promise.reject(new Error('WINNR_API_TOKEN not configured'));
  const https = require('https');
  const bodyStr = body ? JSON.stringify(body) : null;
  const urlObj = new URL(WINNR_BASE + path);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) reject(new Error(`Winnr ${res.statusCode}: ${parsed.error?.message || data.slice(0, 200)}`));
          else resolve(parsed);
        } catch { reject(new Error('Winnr: unexpected non-JSON response')); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function _listAllWinnrDomains() {
  const all = [];
  let cursor = null;
  do {
    const qs = '/v1/domains?limit=100' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await _winnrRequest('GET', qs);
    all.push(...(r.data || []));
    cursor = r.pagination?.has_more ? r.pagination.cursor : null;
  } while (cursor);
  return all;
}

// Generic Google API POST (used for Site Verification token + confirm calls).
function _googleApiPost(auth, url, body) {
  const https = require('https');
  const bodyStr = JSON.stringify(body);
  const urlObj = new URL(url);
  return auth.getClient().then(client => client.getAccessToken()).then(tok =>
    new Promise((resolve, reject) => {
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tok.token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      }, res => {
        let data = '';
        res.on('data', d => { data += d; });
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${parsed.error?.message || data.slice(0, 200)}`));
            else resolve(parsed);
          } catch { reject(new Error('Google API: unexpected non-JSON response')); }
        });
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    })
  );
}

// Auth object that includes the Site Verification scope alongside Postmaster.
function getGoogleVerificationAuth() {
  const keyJson = process.env.GOOGLE_POSTMASTER_KEY_JSON;
  const keyFile = process.env.GOOGLE_POSTMASTER_KEY_FILE;
  if (!keyJson && !keyFile) return null;
  const opts = {
    scopes: [
      'https://www.googleapis.com/auth/postmaster.readonly',
      'https://www.googleapis.com/auth/siteverification',
    ],
  };
  try {
    if (keyJson) opts.credentials = JSON.parse(keyJson);
    else opts.keyFile = keyFile;
  } catch { return null; }
  return new google.auth.GoogleAuth(opts);
}

// GET /siteVerification/v1/token — returns { token: "google-site-verification=XXX" }
function _getSiteVerifyToken(auth, domain) {
  return _googleApiPost(auth, 'https://www.googleapis.com/siteVerification/v1/token', {
    site: { type: 'INET_DOMAIN', identifier: domain },
    verificationMethod: 'DNS_TXT',
  });
}

// POST /siteVerification/v1/webResource — checks DNS and confirms ownership.
function _verifySiteDomain(auth, domain) {
  return _googleApiPost(auth,
    'https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=DNS_TXT',
    { site: { type: 'INET_DOMAIN', identifier: domain } }
  );
}

// List all Winnr domains with their Postmaster registration state.
app.get('/api/postmaster/winnr-domains', requireSession, async (req, res) => {
  try {
    if (!process.env.WINNR_API_TOKEN) return res.status(400).json({ error: 'WINNR_API_TOKEN not configured' });
    const pgdb = app.locals.pgDb;
    const [winnrDomains, tracked] = await Promise.all([
      _listAllWinnrDomains(),
      pgdb ? pgdb.listDomainPostmasterTracking() : [],
    ]);
    const trackMap = Object.fromEntries(tracked.map(r => [r.domain, r]));
    const rows = winnrDomains.map(d => ({
      winnr_id: d.id,
      domain: d.name,
      status: d.status,
      dns_provider: d.dns_provider,
      pm_txt_added_at: trackMap[d.name]?.pm_txt_added_at || null,
      pm_verified_at: trackMap[d.name]?.pm_verified_at || null,
    }));
    res.json({ rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 1: get a google-site-verification TXT token per domain and write to
// Winnr DNS. Skips domains already done. Sequential with 7s delay to stay
// under Google Site Verification API quota (10 req/min on new projects).
app.post('/api/postmaster/register-winnr', requireSession, async (req, res) => {
  const auth = getGoogleVerificationAuth();
  if (!auth) return res.status(400).json({ error: 'Google credentials not configured (GOOGLE_POSTMASTER_KEY_JSON / GOOGLE_POSTMASTER_KEY_FILE)' });
  if (!process.env.WINNR_API_TOKEN) return res.status(400).json({ error: 'WINNR_API_TOKEN not configured' });

  const pgdb = app.locals.pgDb;
  const results = [];

  try {
    const [winnrDomains, tracked] = await Promise.all([
      _listAllWinnrDomains(),
      pgdb ? pgdb.listDomainPostmasterTracking() : [],
    ]);
    const trackMap = Object.fromEntries(tracked.map(r => [r.domain, r]));
    const todo = winnrDomains.filter(d => !trackMap[d.name]?.pm_txt_added_at);
    const alreadyDone = winnrDomains.length - todo.length;

    for (let i = 0; i < todo.length; i++) {
      const d = todo[i];
      const r = { domain: d.name, ok: false, error: null };
      try {
        const tokenRes = await _getSiteVerifyToken(auth, d.name);
        r.txt_value = tokenRes.token;
        await _winnrRequest('POST', `/v1/domains/${d.id}/custom-dns-records`, {
          name: '@', type: 'TXT', value: tokenRes.token, ttl: 300,
        });
        if (pgdb) await pgdb.setDomainPostmasterTracking(d.name, { pm_txt_token: tokenRes.token, pm_txt_added_at: new Date() });
        r.ok = true;
      } catch (err) {
        r.ok = err.message.includes('409'); // 409 = already in Winnr DNS
        r.error = r.ok ? null : err.message;
        if (r.ok && r.txt_value && pgdb) {
          await pgdb.setDomainPostmasterTracking(d.name, { pm_txt_token: r.txt_value, pm_txt_added_at: new Date() }).catch(() => {});
        }
      }
      results.push(r);
      if (i < todo.length - 1) await new Promise(resolve => setTimeout(resolve, 7000));
    }

    const ok = results.filter(r => r.ok).length;
    res.json({
      ok: true,
      message: `${alreadyDone + ok}/${winnrDomains.length} domains have TXT records.${todo.length - ok > 0 ? ` ${todo.length - ok} failed — re-run to retry.` : ' Wait ~5 min for DNS, then run Step 2.'}`,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, partial: results });
  }
});

// Step 2 background state — 69 domains × 7s ≈ 8 min, so runs async.
let _winnrVerifyRunning = false;
const _winnrVerifyProgress = { done: 0, total: 0, ok: 0, results: [], finished: true };

async function _runWinnrVerify() {
  if (_winnrVerifyRunning) return;
  _winnrVerifyRunning = true;
  const auth = getGoogleVerificationAuth();
  const pgdb = app.locals.pgDb;
  try {
    const [winnrDomains, tracked] = await Promise.all([
      _listAllWinnrDomains(),
      pgdb ? pgdb.listDomainPostmasterTracking() : [],
    ]);
    const trackMap = Object.fromEntries(tracked.map(r => [r.domain, r]));
    const pending = winnrDomains.filter(d => trackMap[d.name]?.pm_txt_token && !trackMap[d.name]?.pm_verified_at);
    Object.assign(_winnrVerifyProgress, { done: 0, total: pending.length, ok: 0, results: [], finished: false });

    for (let i = 0; i < pending.length; i++) {
      const d = pending[i];
      const r = { domain: d.name, ok: false, error: null };
      try {
        await _verifySiteDomain(auth, d.name);
        if (pgdb) await pgdb.setDomainPostmasterTracking(d.name, { pm_verified_at: new Date() });
        r.ok = true;
        _winnrVerifyProgress.ok++;
      } catch (err) {
        r.error = err.message;
      }
      _winnrVerifyProgress.done++;
      _winnrVerifyProgress.results.push(r);
      if (i < pending.length - 1) await new Promise(resolve => setTimeout(resolve, 7000));
    }
    _winnrVerifyProgress.finished = true;
    console.log(`[winnr-verify] ${_winnrVerifyProgress.ok}/${_winnrVerifyProgress.total} verified`);
  } catch (err) {
    console.error('[winnr-verify]', err.message);
    _winnrVerifyProgress.finished = true;
  } finally {
    _winnrVerifyRunning = false;
  }
}

app.post('/api/postmaster/verify-winnr', requireSession, async (req, res) => {
  const auth = getGoogleVerificationAuth();
  if (!auth) return res.status(400).json({ error: 'Google credentials not configured' });
  if (_winnrVerifyRunning) {
    return res.json({ ok: true, running: true, message: `Running — ${_winnrVerifyProgress.done}/${_winnrVerifyProgress.total} done so far.`, progress: _winnrVerifyProgress });
  }
  const pgdb = app.locals.pgDb;
  const tracked = pgdb ? await pgdb.listDomainPostmasterTracking() : [];
  const pending = tracked.filter(r => r.pm_txt_token && !r.pm_verified_at).length;
  if (!pending) return res.json({ ok: true, message: 'All domains already verified.', progress: _winnrVerifyProgress });
  _runWinnrVerify().catch(() => {});
  res.json({ ok: true, started: true, message: `Verifying ${pending} domains in background (~7s each). Watch the counter update.`, progress: _winnrVerifyProgress });
});

app.get('/api/postmaster/verify-winnr/progress', requireSession, (req, res) => {
  res.json({ running: _winnrVerifyRunning, ..._winnrVerifyProgress });
});

// ─────────────────────────────────────────────────────────────────────
// Mailboxes — supplier + type tagging and comparison
// ─────────────────────────────────────────────────────────────────────

// Map PlusVibe's `provider` field to one of the three high-level types
// the user wants to compare against. Anything we don't recognise as a
// Google or Microsoft signal is treated as raw SMTP.
function detectMailboxType(provider) {
  const p = (provider || '').toString().toUpperCase();
  if (/GOOGLE|GMAIL|GWORKSPACE|GSUITE/.test(p)) return 'google';
  if (/MICROSOFT|MS365|MS_365|OUTLOOK|OFFICE/.test(p)) return 'microsoft';
  if (p) return 'smtp';
  return null;
}

const SUPPLIERS_ALLOWED = ['Maildoso', 'Mithun', 'Winnr', 'Inboxing'];
const TYPES_ALLOWED     = ['google', 'microsoft', 'smtp'];

// In-memory cache. PlusVibe data refreshes every 30 minutes; on each
// request we merge the latest mailbox_meta overrides from Postgres.
let _mailboxCache = { mailboxes: [], lastRun: null, running: false };
async function refreshMailboxCache() {
  if (_mailboxCache.running) return;
  _mailboxCache.running = true;
  try {
    const list = await listSendingMailboxes();
    _mailboxCache.mailboxes = list;
    _mailboxCache.lastRun = new Date().toISOString();
    console.log(`[mailboxes] cache refreshed — ${list.length} mailbox(es)`);

    // Persist the PlusVibe-detected provider type into mailbox_meta so SQL
    // consumers (combo analysis) classify senders correctly. Without this,
    // untagged Google/MS mailboxes fall through to 'smtp' in the combo query
    // even though the Mailboxes page detects them live. Fills NULLs only —
    // manual type overrides are preserved.
    const pgdb = app.locals.pgDb;
    if (pgdb?.backfillMailboxTypes) {
      const typed = list.map(m => ({ email: m.email, mailbox_type: detectMailboxType(m.provider) }));
      try {
        const n = await pgdb.backfillMailboxTypes(typed);
        if (n) console.log(`[mailboxes] backfilled provider type for ${n} mailbox(es)`);
      } catch (err) {
        console.warn('[mailboxes] type backfill failed:', err.message);
      }
    }
  } catch (err) {
    console.error('[mailboxes] refresh failed:', err.message);
  } finally {
    _mailboxCache.running = false;
  }
}
// First run 30s after startup, then every 30 minutes.
setTimeout(refreshMailboxCache, 20000); // after revenue cache (5s), before performance (60s)
setInterval(refreshMailboxCache, 30 * 60 * 1000);

function mergeMailboxesWithMeta(mailboxes, metaByEmail) {
  return mailboxes.map(m => {
    const meta = metaByEmail.get(m.email) || {};
    return {
      ...m,
      // Auto-detected type from PlusVibe, overridden by manual tag if set.
      type_auto: detectMailboxType(m.provider),
      type:      meta.mailbox_type || detectMailboxType(m.provider) || 'smtp',
      supplier:           meta.supplier || null,
      notes:              meta.notes || null,
      billing_start_date: meta.billing_start_date || null,
      billing_day:        meta.billing_day || null,
      ignored_at:         meta.ignored_at || null,
    };
  });
}

// Build a campaign-id → aggregated stats map from the existing campaign
// cache. We use it to *attribute* a share of each campaign's sent/replies/
// bounces back to each mailbox attached to that campaign (PlusVibe rotates
// load across attached mailboxes, so an even share is a fair approximation).
// dbBounceByCampaign: optional Map<campaign_id, number> from our email_events
// table. Where present these override PlusVibe's bounced_count, which
// misclassifies OOO auto-replies as bounces.
function buildCampaignIndex(dbBounceByCampaign) {
  const idx = new Map(); // campaign_id → { sent, replies, bounces, mailbox_count }
  for (const ws of (campaignCache.workspaces || [])) {
    for (const c of (ws.campaigns || [])) {
      if (!c.id) continue;
      const dbBounces = dbBounceByCampaign?.get(c.id);
      idx.set(c.id, {
        sent: c.sent || 0,
        replies: c.replies || 0,
        bounces: dbBounces != null ? dbBounces : (c.bounces || 0),
        mailbox_count: 0,
      });
    }
  }
  return idx;
}

// Query email_events for actual per-mailbox sent/reply/bounce counts.
// Returns Map<sender_email, {sent, replies, bounces}>.
// Query email_events for per-mailbox sent and bounce counts.
// Real per-mailbox HUMAN reply counts from the client-portal's classified
// unibox_replies. mailbox_email = the address that received the reply (our sending
// mailbox, from Bison's primary_to_email_address). This gives a TRUE per-mailbox
// reply count instead of the old campaign-rate × mailbox-sent estimate. Human =
// interested/not_interested/question/unsubscribe (excludes warm-up + OOO). Returns
// Map(lower(mailbox_email) -> count). Best-effort: returns empty Map on any error
// (e.g. column not present yet) so the mailbox page never breaks.
async function buildPortalRepliesByMailbox(pgdb) {
  if (!pgdb) return new Map();
  try {
    const { rows } = await pgdb.query(`
      SELECT lower(mailbox_email) AS mbx, COUNT(*)::int AS replies
      FROM unibox_replies
      WHERE mailbox_email IS NOT NULL
        AND COALESCE(admin_label, category)
            IN ('interested','not_interested','question','unsubscribe')
      GROUP BY lower(mailbox_email)
    `);
    return new Map(rows.map(r => [r.mbx, parseInt(r.replies, 10) || 0]));
  } catch (e) {
    console.warn('[mailboxes] portal reply count query failed:', e.message);
    return new Map();
  }
}

// PlusVibe reply webhooks never include sender_email so replies are excluded —
// reply rates are computed by scaling the campaign reply rate to the mailbox's
// actual send volume instead.
async function buildMailboxStatsFromEvents(pgdb) {
  if (!pgdb) return new Map();
  try {
    const { rows } = await pgdb.query(`
      SELECT
        sender_email,
        COUNT(*) FILTER (WHERE event_type = 'sent')    AS sent,
        COUNT(*) FILTER (WHERE event_type = 'bounce')  AS bounces
      FROM email_events
      WHERE sender_email IS NOT NULL
      GROUP BY sender_email
    `);
    return new Map(rows.map(r => [r.sender_email, {
      sent:    parseInt(r.sent,    10) || 0,
      bounces: parseInt(r.bounces, 10) || 0,
    }]));
  } catch {
    return new Map();
  }
}

// Walk the mailboxes and attach per-mailbox performance stats.
// Uses real sent/bounce counts from email_events where available.
// Reply rate is computed as (campaign reply rate × mailbox sent count) because
// PlusVibe reply webhooks don't include the sending mailbox.
// Falls back to even-split for mailboxes with no webhook history.
function attachMailboxStats(mailboxes, campIndex, eventsByMailbox = new Map(), portalRepliesByMailbox = new Map()) {
  // First pass: count mailboxes per campaign (for even-split fallback) and
  // accumulate campaign-level totals needed for reply-rate scaling.
  for (const m of mailboxes) {
    for (const cid of (m.campaign_ids || [])) {
      const c = campIndex.get(cid);
      if (c) c.mailbox_count++;
    }
  }

  // Second pass: assign sent/bounce from email_events where available,
  // then derive replies — preferring the portal's REAL per-mailbox reply count,
  // falling back to the campaign-rate × sent estimate only when the portal has none.
  for (const m of mailboxes) {
    const ev = eventsByMailbox.get(m.email);
    // Real human replies for THIS mailbox from the classified portal data.
    const portalReplies = portalRepliesByMailbox.get((m.email || '').toLowerCase());
    if (ev && ev.sent > 0) {
      // Real sent + bounce counts from webhooks.
      m.attributed_sent    = ev.sent;
      m.attributed_bounces = ev.bounces;
      if (portalReplies != null) {
        // TRUE per-mailbox reply count from the portal (best source).
        m.attributed_replies = portalReplies;
      } else {
        // Fallback: scale campaign reply rate to this mailbox's actual send volume.
        let campSent = 0, campReplies = 0;
        for (const cid of (m.campaign_ids || [])) {
          const c = campIndex.get(cid);
          if (!c) continue;
          campSent    += c.sent;
          campReplies += c.replies;
        }
        const campReplyRate = campSent > 0 ? campReplies / campSent : 0;
        m.attributed_replies = Math.round(ev.sent * campReplyRate);
      }
    } else {
      // No webhook data — fall back to even-split across campaign mailboxes.
      let sent = 0, replies = 0, bounces = 0;
      for (const cid of (m.campaign_ids || [])) {
        const c = campIndex.get(cid);
        if (!c || !c.mailbox_count) continue;
        sent    += c.sent    / c.mailbox_count;
        replies += c.replies / c.mailbox_count;
        bounces += c.bounces / c.mailbox_count;
      }
      m.attributed_sent    = Math.round(sent);
      m.attributed_replies = Math.round(replies);
      m.attributed_bounces = Math.round(bounces);
    }
    const s = m.attributed_sent;
    const r = m.attributed_replies;
    const b = m.attributed_bounces;
    m.reply_rate  = s > 0 ? r / s : 0;
    m.bounce_rate = s > 0 ? b / s : 0;
  }
}

// Pull auth + blacklist data from the domain_health table.
async function attachDomainHealth(pgdb, mailboxes) {
  if (!pgdb) return;
  const domains = Array.from(new Set(mailboxes.map(m => m.domain).filter(Boolean)));
  if (!domains.length) return;
  const r = await pgdb.query(
    `SELECT domain, spf, dkim, dmarc, blacklists, score, status FROM domain_health WHERE domain = ANY($1::text[])`,
    [domains]
  );
  const byDom = new Map();
  for (const row of r.rows) byDom.set(row.domain, row);
  for (const m of mailboxes) {
    const dh = byDom.get(m.domain);
    if (!dh) continue;
    const parseJsonb = v => (typeof v === 'string' ? JSON.parse(v || 'null') : v);
    const spf   = parseJsonb(dh.spf)   || {};
    const dkim  = parseJsonb(dh.dkim)  || {};
    const dmarc = parseJsonb(dh.dmarc) || {};
    const bl    = parseJsonb(dh.blacklists) || [];
    m.auth = {
      spf_present:   !!spf.present,
      spf_strict:    !!spf.strict,
      spf_raw:       spf.raw || null,
      dkim_present:  !!dkim.present,
      dkim_selector: dkim.selector || null,
      dkim_raw:      dkim.raw || null,
      dmarc_present: !!dmarc.present,
      dmarc_policy:  dmarc.policy || null,
      dmarc_raw:     dmarc.raw || null,
    };
    m.blacklist_count = Array.isArray(bl) ? bl.length : 0;
    m.domain_score    = typeof dh.score === 'number' ? dh.score : null;
    m.domain_notes    = dh.notes || null;
    m.domain_status   = dh.status || null;
  }
}

// Decide which mailboxes need attention — surface them in the UI so the
// team has a single triage list instead of skimming the full table.
function computeAttentionFlags(m) {
  const flags = [];
  const status  = (m.status || '').toUpperCase();
  const warmup  = (m.warmup_status || '').toUpperCase();
  if (status && status !== 'ACTIVE' && status !== 'PAUSED') flags.push({ level: 'critical', msg: `Disconnected (${status.toLowerCase()})` });
  if (m.auth && !m.auth.spf_present)        flags.push({ level: 'critical', msg: 'Missing SPF' });
  if (m.auth && !m.auth.dkim_present)       flags.push({ level: 'critical', msg: 'Missing DKIM' });
  if (m.auth && !m.auth.dmarc_present)      flags.push({ level: 'warning',  msg: 'Missing DMARC' });
  // p=none is the recommended policy for cold outreach — not an attention item.
  if (m.blacklist_count)                    flags.push({ level: 'critical', msg: `Blacklisted on ${m.blacklist_count}` });
  if (warmup !== 'ACTIVE' && status === 'ACTIVE') flags.push({ level: 'warning', msg: 'Warmup not running' });
  if (m.attributed_sent >= 100) {
    if (m.bounce_rate > 0.05) flags.push({ level: 'critical', msg: `High bounce rate ${(m.bounce_rate*100).toFixed(1)}%` });
    if (m.reply_rate  < 0.01) flags.push({ level: 'warning',  msg: `Low reply rate ${(m.reply_rate*100).toFixed(2)}%` });
  }
  return flags;
}

// Compute aggregate stats grouped by an arbitrary key function. The
// per-mailbox attribution (attributed_sent etc.) must already be on each
// row — attachMailboxStats() does that before we call this.
function groupMailboxStats(mailboxes, keyFn) {
  const groups = {};
  for (const m of mailboxes) {
    const k = keyFn(m);
    if (!k) continue;
    if (!groups[k]) groups[k] = {
      key: k, count: 0,
      active: 0, paused: 0, disconnected: 0,
      warmup_active: 0,
      total_daily_limit: 0,
      avg_daily_limit: 0,
      total_campaigns: 0,
      // Performance rollups
      total_sent: 0, total_replies: 0, total_bounces: 0,
      reply_rate: 0, bounce_rate: 0,
      // Health rollups
      auth_clean: 0, blacklist_listed: 0,
      attention_count: 0,
      // Cost rollups
      total_monthly_cost: 0,
    };
    const g = groups[k];
    g.count++;
    const status = (m.status || '').toUpperCase();
    if (status === 'ACTIVE')        g.active++;
    else if (status === 'PAUSED')   g.paused++;
    else if (status)                g.disconnected++;
    if ((m.warmup_status || '').toUpperCase() === 'ACTIVE') g.warmup_active++;
    if (typeof m.daily_limit === 'number') g.total_daily_limit += m.daily_limit;
    g.total_campaigns += m.campaigns_count || 0;
    g.total_sent    += m.attributed_sent    || 0;
    g.total_replies += m.attributed_replies || 0;
    g.total_bounces += m.attributed_bounces || 0;
    if (m.auth && m.auth.spf_present && m.auth.dkim_present && m.auth.dmarc_present) g.auth_clean++;
    if (m.blacklist_count) g.blacklist_listed++;
    if (Array.isArray(m.attention) && m.attention.length) g.attention_count++;
    g.total_monthly_cost += m.unit_cost || 0;
  }
  for (const k of Object.keys(groups)) {
    const g = groups[k];
    g.avg_daily_limit = g.count ? Math.round(g.total_daily_limit / g.count) : 0;
    g.active_pct = g.count ? Math.round((g.active / g.count) * 100) : 0;
    g.warmup_pct = g.count ? Math.round((g.warmup_active / g.count) * 100) : 0;
    g.reply_rate  = g.total_sent > 0 ? g.total_replies / g.total_sent : 0;
    g.bounce_rate = g.total_sent > 0 ? g.total_bounces / g.total_sent : 0;
    g.auth_clean_pct       = g.count ? Math.round((g.auth_clean / g.count) * 100) : 0;
    g.blacklist_listed_pct = g.count ? Math.round((g.blacklist_listed / g.count) * 100) : 0;
  }
  return Object.values(groups).sort((a, b) => b.count - a.count);
}

app.get('/api/mailboxes', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    const meta = pgdb ? await pgdb.listMailboxMeta() : [];
    const metaByEmail = new Map(meta.map(m => [m.email, m]));
    const merged = mergeMailboxesWithMeta(_mailboxCache.mailboxes, metaByEmail)
      .filter(m => !m.ignored_at);

    // Attach per-mailbox monthly unit cost so the dashboard can show $/mo
    // and so the Finance page totals stay consistent with what's visible
    // here.
    const pricingRows = pgdb ? await pgdb.listMailboxPricing() : [];
    const prices = pricingMap(pricingRows);
    for (const m of merged) m.unit_cost = mailboxUnitCost(m, prices);

    // Query per-mailbox stats from webhook events and per-campaign bounce
    // corrections in parallel — both queries are independent.
    const [eventsByMailbox, dbBounceByCampaign, portalRepliesByMailbox] = await Promise.all([
      buildMailboxStatsFromEvents(pgdb),
      pgdb ? pgdb.query(`
        SELECT campaign_id, COUNT(*)::int AS bounces
        FROM email_events
        WHERE event_type = 'bounce'
          AND campaign_id IS NOT NULL
        GROUP BY campaign_id
      `).then(r => new Map(r.rows.map(row => [row.campaign_id, row.bounces])))
        .catch(() => new Map())
        : Promise.resolve(new Map()),
      buildPortalRepliesByMailbox(pgdb),
    ]);

    // Attribute per-mailbox sent/replies/bounces — prefers the portal's REAL
    // per-mailbox reply count, then real webhook sent/bounce, then even-split.
    attachMailboxStats(merged, buildCampaignIndex(dbBounceByCampaign), eventsByMailbox, portalRepliesByMailbox);

    // Inherit SPF/DKIM/DMARC + blacklist status from the domain_health table.
    await attachDomainHealth(pgdb, merged);

    // Compute per-mailbox attention flags from the combined data.
    for (const m of merged) m.attention = computeAttentionFlags(m);

    // Stats grouped by supplier (user-assigned), by type (auto/manual), and
    // by supplier × type so the user can compare "Maildoso Google" vs
    // "Mithun Google" vs "Maildoso Microsoft" etc. at a glance.
    const bySupplier   = groupMailboxStats(merged, m => m.supplier || 'Unassigned');
    const byType       = groupMailboxStats(merged, m => m.type);
    const byClient     = groupMailboxStats(merged, m => m.workspace_name || 'Unassigned');
    const bySupplierType = groupMailboxStats(merged, m =>
      `${m.supplier || 'Unassigned'} · ${m.type || 'smtp'}`
    );

    const needs_attention = merged.filter(m => Array.isArray(m.attention) && m.attention.length).length;

    res.json({
      mailboxes: merged,
      stats: { bySupplier, byType, byClient, bySupplierType },
      summary: {
        total: merged.length,
        needs_attention,
      },
      suppliers: SUPPLIERS_ALLOWED,
      types: TYPES_ALLOWED,
      lastRun: _mailboxCache.lastRun,
      running: _mailboxCache.running,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/mailboxes/refresh', requireSession, (req, res) => {
  if (_mailboxCache.running) return res.json({ ok: true, message: 'Already refreshing' });
  refreshMailboxCache().catch(() => {});
  res.json({ ok: true, message: 'Mailbox refresh started' });
});

// Diagnostic: per-workspace mailbox counts from the last cache refresh + which
// workspaces FAILED to fetch (e.g. auth/401) so the total is short. Answers
// "Bison shows N but admin shows fewer — which workspaces are missing?".
app.get('/api/mailboxes/refresh-status', requireSession, (req, res) => {
  const byTeam = {};
  for (const m of (_mailboxCache.mailboxes || [])) {
    const k = (m.workspace_name || m.bison_team_id || m.workspace_id || '?');
    byTeam[k] = (byTeam[k] || 0) + 1;
  }
  res.json({
    total: (_mailboxCache.mailboxes || []).length,
    lastRun: _mailboxCache.lastRun,
    running: _mailboxCache.running,
    perWorkspace: byTeam,
    failedTeams: _mailboxCache.failedTeams || [],
  });
});

// Assign supplier / type to a single mailbox.
app.put('/api/mailboxes/:email', requireSession, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email || '').toLowerCase();
    if (!email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
    const { supplier, mailbox_type, notes } = req.body || {};
    if (supplier && !SUPPLIERS_ALLOWED.includes(supplier)) return res.status(400).json({ error: 'Invalid supplier' });
    if (mailbox_type && !TYPES_ALLOWED.includes(mailbox_type)) return res.status(400).json({ error: 'Invalid type' });
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
    const row = await pgdb.upsertMailboxMeta(email, { supplier, mailbox_type, notes });
    res.json({ ok: true, row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk-assign supplier or type across many mailboxes at once.
app.post('/api/mailboxes/bulk-tag', requireSession, async (req, res) => {
  try {
    const { emails, field, value } = req.body || {};
    if (!Array.isArray(emails) || !emails.length) return res.status(400).json({ error: 'No emails' });
    if (!['supplier', 'mailbox_type'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
    if (field === 'supplier' && value && !SUPPLIERS_ALLOWED.includes(value)) return res.status(400).json({ error: 'Invalid supplier' });
    if (field === 'mailbox_type' && value && !TYPES_ALLOWED.includes(value)) return res.status(400).json({ error: 'Invalid type' });
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
    const r = await pgdb.bulkSetMailboxField(emails.map(e => e.toLowerCase()), field, value || null);
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk-assign by domain — accepts a list of domains and tags every mailbox
// on any of those domains. Used when you know "everything @winnr-domain is
// Winnr" and don't want to click through individual rows.
app.post('/api/mailboxes/bulk-tag-by-domain', requireSession, async (req, res) => {
  try {
    const { domains, field, value } = req.body || {};
    if (!Array.isArray(domains) || !domains.length) return res.status(400).json({ error: 'No domains' });
    if (!['supplier', 'mailbox_type'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
    if (field === 'supplier' && value && !SUPPLIERS_ALLOWED.includes(value)) return res.status(400).json({ error: 'Invalid supplier' });
    if (field === 'mailbox_type' && value && !TYPES_ALLOWED.includes(value)) return res.status(400).json({ error: 'Invalid type' });
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });

    const wanted = new Set(domains.map(d => d.toLowerCase().trim()));
    const emails = (_mailboxCache.mailboxes || [])
      .filter(m => wanted.has(m.domain))
      .map(m => m.email);
    if (!emails.length) return res.json({ ok: true, changed: 0, matched: 0, message: 'No mailboxes match those domains in the current cache.' });
    const r = await pgdb.bulkSetMailboxField(emails, field, value || null);
    res.json({ ok: true, matched: emails.length, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-shot supplier assignment from a structured payload. Use this to
// import a big block of "these domains are Winnr, these emails are
// Maildoso, default is Mithun" assignments in a single round-trip.
// Body shape:
// {
//   supplierDomains: { Winnr: ["x.co.uk", ...], Inboxing: [...] },
//   supplierEmails:  { Maildoso: ["james@x", ...] },
//   defaultSupplier: "Mithun"   // applied to every remaining mailbox that
//                               // isn't already tagged
// }
app.post('/api/mailboxes/assign-suppliers', requireSession, async (req, res) => {
  try {
    const { supplierDomains = {}, supplierEmails = {}, defaultSupplier = null } = req.body || {};
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });

    const allMailboxes = _mailboxCache.mailboxes || [];
    const assigned = new Map();   // email → supplier (first-match wins, in priority order)

    // 1) Explicit email assignments — highest precedence.
    for (const [supplier, emails] of Object.entries(supplierEmails)) {
      for (const e of (emails || [])) {
        const k = e.toLowerCase().trim();
        if (k && !assigned.has(k)) assigned.set(k, supplier);
      }
    }
    // 2) Domain assignments — fill in anything not already explicit.
    for (const [supplier, domains] of Object.entries(supplierDomains)) {
      const wanted = new Set((domains || []).map(d => d.toLowerCase().trim()));
      for (const m of allMailboxes) {
        if (wanted.has(m.domain) && !assigned.has(m.email)) assigned.set(m.email, supplier);
      }
    }
    // 3) Default supplier — every untagged mailbox in the cache.
    if (defaultSupplier) {
      for (const m of allMailboxes) {
        if (!assigned.has(m.email)) assigned.set(m.email, defaultSupplier);
      }
    }

    // 4) Clear supplier for any mailbox not assigned and no default set.
    // Always clear from DB (don't rely on cache having supplier field).
    const toClear = [];
    if (!defaultSupplier) {
      for (const m of allMailboxes) {
        if (!assigned.has(m.email)) toClear.push(m.email);
      }
      if (toClear.length) await pgdb.bulkSetMailboxField(toClear, 'supplier', null);
    }

    // Group by supplier and run one bulk write per group.
    const bySupplier = {};
    for (const [email, sup] of assigned) {
      (bySupplier[sup] ||= []).push(email);
    }
    const result = {};
    for (const [sup, emails] of Object.entries(bySupplier)) {
      const r = await pgdb.bulkSetMailboxField(emails, 'supplier', sup);
      result[sup] = { matched: emails.length, changed: r.changed };
    }
    res.json({ ok: true, totalAssigned: assigned.size, cleared: toClear.length, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk set billing date + renewal day for a selection of mailboxes.
// Accepts: { emails?, domains?, supplier?, billing_start_date, billing_day }
// If emails not supplied, resolves from domains/supplier against the live cache.
app.post('/api/mailboxes/bulk-billing', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
    let { emails, domains, supplier, billing_start_date, billing_day } = req.body || {};
    if (!billing_start_date) return res.status(400).json({ error: 'billing_start_date required (YYYY-MM-DD)' });
    billing_day = parseInt(billing_day || new Date(billing_start_date).getDate());

    // Resolve email list from domains/supplier if not explicitly given.
    if (!Array.isArray(emails) || !emails.length) {
      const all = _mailboxCache.mailboxes || [];
      const wantedDomains = new Set((domains || []).map(d => d.toLowerCase().trim()));
      emails = all.filter(m => {
        if (supplier && (m.supplier || '') !== supplier) return false;
        if (wantedDomains.size && !wantedDomains.has(m.domain)) return false;
        return true;
      }).map(m => m.email);
    }
    if (!emails.length) return res.json({ ok: true, changed: 0, message: 'No mailboxes matched' });

    const r = await pgdb.bulkSetBilling(emails, billing_start_date, billing_day);
    console.log(`[mailboxes] billing set for ${r.changed} mailboxes: start=${billing_start_date} day=${billing_day}`);
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[mailboxes] bulk-billing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Per-row billing import from spreadsheet: [{email, billing_start_date}]
app.post('/api/mailboxes/bulk-billing-rows', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows array required' });
    for (const row of rows) {
      if (!row.email || !row.billing_start_date) return res.status(400).json({ error: 'each row needs email + billing_start_date' });
    }
    const r = await pgdb.bulkSetBillingRows(rows);
    console.log(`[mailboxes] per-row billing import: ${r.changed} rows updated`);
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[mailboxes] bulk-billing-rows error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Hide mailboxes from the dashboard without touching PlusVibe.
// Sets ignored_at so they're filtered out of GET /api/mailboxes.
app.post('/api/mailboxes/bulk-remove', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
    const { emails } = req.body || {};
    if (!Array.isArray(emails) || !emails.length) return res.status(400).json({ error: 'emails array required' });
    const lower = emails.map(e => e.toLowerCase());
    const placeholders = lower.map((_, i) => `($${i + 1}, NOW())`).join(', ');
    const { rowCount } = await pgdb.query(
      `INSERT INTO mailbox_meta (email, ignored_at)
       VALUES ${placeholders}
       ON CONFLICT (email) DO UPDATE SET ignored_at = NOW()`,
      lower
    );
    console.log(`[mailboxes] bulk-remove: ${lower.length} mailboxes hidden`);
    res.json({ ok: true, removed: lower.length });
  } catch (err) {
    console.error('[mailboxes] bulk-remove error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mailboxes/enable-warmup', requireSession, async (req, res) => {
  try {
    const { emails } = req.body || {};
    if (!Array.isArray(emails) || !emails.length) return res.status(400).json({ error: 'emails array required' });

    const cache = _mailboxCache?.mailboxes || [];
    // Group emails by workspace_id and collect account IDs
    const byWorkspace = {};
    const missing = [];
    for (const email of emails) {
      const m = cache.find(x => x.email === email);
      if (!m || !m.account_id || !m.workspace_id) { missing.push(email); continue; }
      if (!byWorkspace[m.workspace_id]) byWorkspace[m.workspace_id] = [];
      byWorkspace[m.workspace_id].push(m.account_id);
    }

    const results = [];
    for (const [workspace_id, ids] of Object.entries(byWorkspace)) {
      // Bison: PATCH /api/warmup/sender-emails/enable { sender_email_ids }, stateful
      // per workspace. account_id in the cache is the Bison sender-email id;
      // workspace_id is the canonical PV id, so map it to the Bison team_id.
      const team = BISON_TEAMS.find(t => t.pv === String(workspace_id));
      const wsId = team ? team.team_id : workspace_id;
      const sender_email_ids = ids.map(id => Number(id)).filter(n => Number.isFinite(n));
      const r = await bisonReq('/api/warmup/sender-emails/enable', {
        wsId,
        method: 'PATCH',
        body: { sender_email_ids },
      });
      results.push({ workspace_id, count: ids.length, result: r });
    }

    const enabled = results.reduce((s, r) => s + r.count, 0);
    console.log(`[mailboxes] enable-warmup: ${enabled} accounts updated, ${missing.length} skipped (no cache entry)`);
    res.json({ ok: true, enabled, missing, results });
  } catch (err) {
    console.error('[mailboxes] enable-warmup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/mailboxes',      (req, res) => res.sendFile(path.join(__dirname, 'mailboxes.html')));
app.get('/mailboxes.html', (req, res) => res.sendFile(path.join(__dirname, 'mailboxes.html')));
app.get('/mailbox-diff',      (req, res) => res.sendFile(path.join(__dirname, 'mailbox-diff.html')));
app.get('/mailbox-diff.html', (req, res) => res.sendFile(path.join(__dirname, 'mailbox-diff.html')));

// ── Warmup overview (Bison /api/warmup/sender-emails) ───────────────────────
// Per-mailbox warmup health across all workspaces. Like /api/sender-emails,
// Bison caps ~15 rows/page, so we paginate per workspace.
async function bisonListWarmupSenderEmails(wsId, startDate, endDate) {
  const out = [];
  let prevSig = '';
  for (let page = 1; page <= 300; page++) {
    const resp = await bisonReq('/api/warmup/sender-emails', {
      wsId,
      params: { per_page: 200, page, start_date: startDate, end_date: endDate },
    });
    const list = Array.isArray(resp) ? resp : (resp?.data ?? []);
    if (!list.length) break;
    const sig = list.map(a => a.id ?? a.email ?? '').join(',');
    if (sig === prevSig) break;
    prevSig = sig;
    out.push(...list);
  }
  return out;
}

// Categorise a warmup mailbox into a health bucket for the dashboard.
function warmupHealth(a) {
  const score = Number(a.warmup_score ?? 0);
  const bouncesCaused = Number(a.warmup_bounces_caused_count ?? 0);
  const disabledForBouncing = Number(a.warmup_disabled_for_bouncing_count ?? 0);
  if (disabledForBouncing > 0) return 'disabled_bouncing';
  if (bouncesCaused > 0) return 'bouncing';
  if (score > 0 && score < 80) return 'low_score';
  if (score >= 80) return 'healthy';
  return 'unknown'; // score 0 / just started
}

// Gather warmup data across all workspaces (SLOW — 22 ws × paginated Bison calls,
// serialized through the Bison mutex). Must run in the background, never inline on
// a page request, or the request times out (this is why the page "didn't work").
async function gatherWarmupData() {
  const today = serverDateString(new Date());
  const start = serverDateString(new Date(Date.now() - 10 * 86400000));
  const end   = today;
  const pvByTeamId = new Map(BISON_TEAMS.map(t => [String(t.team_id), t]));
  const wsRaw = listBisonWorkspaces();
  const wsList = Array.isArray(wsRaw) ? wsRaw : (wsRaw?.data || []);
  const inactive = inactiveWorkspaceIds();

  const mailboxes = [];
  const seen = new Set();
  for (const w of wsList) {
    const mapped = pvByTeamId.get(String(w.id));
    const pv = mapped ? mapped.pv : String(w.id);
    if (inactive.has(pv)) continue;
    const name = mapped ? mapped.name : (w.name || `Workspace ${w.id}`);
    try {
      const list = await bisonListWarmupSenderEmails(String(w.id), start, end);
      for (const a of list) {
        const email = (a.email || a.name || '').toString().trim().toLowerCase();
        if (!email.includes('@') || seen.has(email)) continue;
        seen.add(email);
        mailboxes.push({
          email,
          domain: a.domain || email.split('@')[1],
          workspace_id: pv,
          workspace_name: name,
          bison_team_id: String(w.id),
          account_id: a.id != null ? String(a.id) : null,
          warmup_score: Number(a.warmup_score ?? 0),
          sent: Number(a.warmup_emails_sent ?? 0),
          replies: Number(a.warmup_replies_received ?? 0),
          saved_from_spam: Number(a.warmup_emails_saved_from_spam ?? 0),
          bounces_received: Number(a.warmup_bounces_received_count ?? 0),
          bounces_caused: Number(a.warmup_bounces_caused_count ?? 0),
          disabled_for_bouncing: Number(a.warmup_disabled_for_bouncing_count ?? 0),
          health: warmupHealth(a),
        });
      }
    } catch (err) {
      console.warn(`[warmup] ${name} (team ${w.id}) failed:`, err.message);
    }
  }

  const summary = { total: mailboxes.length, healthy: 0, low_score: 0, bouncing: 0, disabled_bouncing: 0, unknown: 0 };
  let scoreSum = 0, scoreN = 0;
  for (const m of mailboxes) {
    summary[m.health] = (summary[m.health] || 0) + 1;
    if (m.warmup_score > 0) { scoreSum += m.warmup_score; scoreN++; }
  }
  summary.avg_score = scoreN ? Math.round(scoreSum / scoreN) : 0;
  summary.at_risk = summary.low_score + summary.bouncing + summary.disabled_bouncing;

  return { start, end, summary, mailboxes };
}

let _warmupCache = { data: null, lastRun: null, running: false, error: null };
async function refreshWarmupCache() {
  if (_warmupCache.running || !getBisonKey()) return;
  _warmupCache.running = true;
  try {
    const data = await gatherWarmupData();
    _warmupCache.data = data;
    _warmupCache.lastRun = new Date().toISOString();
    _warmupCache.error = null;
    console.log(`[warmup] cache refreshed — ${data.mailboxes.length} mailbox(es)`);
  } catch (err) {
    _warmupCache.error = err.message;
    console.error('[warmup] refresh failed:', err.message);
  } finally {
    _warmupCache.running = false;
  }
}
// First run 45s after boot (after mailbox cache), then every 30 min.
setTimeout(refreshWarmupCache, 45000);
setInterval(refreshWarmupCache, 30 * 60 * 1000);

app.get('/api/warmup', requireSession, async (req, res) => {
  if (!getBisonKey()) return res.status(400).json({ error: 'No Bison key configured' });
  // Serve the cache instantly. If it's never been built, kick off a refresh and
  // tell the page it's warming (it polls), rather than blocking the request for
  // minutes while we fetch 22 workspaces.
  if (_warmupCache.data) {
    return res.json({ ...(_warmupCache.data), lastRun: _warmupCache.lastRun, warming: _warmupCache.running });
  }
  if (!_warmupCache.running) refreshWarmupCache().catch(() => {});
  res.json({
    warming: true,
    lastRun: null,
    error: _warmupCache.error,
    summary: { total: 0, healthy: 0, low_score: 0, bouncing: 0, disabled_bouncing: 0, unknown: 0, avg_score: 0, at_risk: 0 },
    mailboxes: [],
  });
});

// Enable / disable warmup for a set of mailboxes (Bison sender-email IDs).
// Body: { workspace_id, account_ids: [bisonSenderEmailId, ...] }. Stateful per ws.
async function warmupSetState(req, res, action) {
  const { workspace_id, account_ids } = req.body || {};
  if (!workspace_id || !Array.isArray(account_ids) || !account_ids.length)
    return res.status(400).json({ error: 'workspace_id and account_ids required' });
  const team = BISON_TEAMS.find(t => t.pv === String(workspace_id));
  const wsId = team ? team.team_id : workspace_id;
  const sender_email_ids = account_ids.map(id => Number(id)).filter(Number.isFinite);
  if (!sender_email_ids.length) return res.status(400).json({ error: 'No valid account_ids' });
  try {
    const r = await bisonReq(`/api/warmup/sender-emails/${action}`, {
      wsId, method: 'PATCH', body: { sender_email_ids },
    });
    res.json({ ok: true, action, count: sender_email_ids.length, result: r });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
app.post('/api/warmup/enable',  requireSession, (req, res) => warmupSetState(req, res, 'enable'));
app.post('/api/warmup/disable', requireSession, (req, res) => warmupSetState(req, res, 'disable'));

// Force a warmup cache rebuild (after enable/disable, or manual refresh button).
app.post('/api/warmup/refresh', requireSession, (req, res) => {
  refreshWarmupCache().catch(() => {});
  res.json({ ok: true, warming: true });
});

app.get('/warmup',      (req, res) => res.sendFile(path.join(__dirname, 'warmup.html')));
app.get('/warmup.html', (req, res) => res.sendFile(path.join(__dirname, 'warmup.html')));
app.get('/health',         (req, res) => res.sendFile(path.join(__dirname, 'health.html')));
app.get('/health.html',    (req, res) => res.sendFile(path.join(__dirname, 'health.html')));

// ─────────────────────────────────────────────────────────────────────
// Finance — per-client P&L, agency P&L, recurring opex
// ─────────────────────────────────────────────────────────────────────

function currentMonthStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// "Expense is active in month M" if start_month <= M and (end_month is null
// or end_month >= M). Months are YYYY-MM strings, so lexicographic compare
// is correct.
function expenseActiveInMonth(expense, month) {
  if ((expense.start_month || '') > month) return false;
  if (expense.end_month && expense.end_month < month) return false;
  return true;
}

function pricingMap(rows) {
  const m = new Map();
  for (const p of rows) {
    m.set(`${p.supplier}|${p.mailbox_type}`, parseFloat(p.unit_cost));
  }
  return m;
}

function mailboxUnitCost(m, prices) {
  if (!m.supplier || !m.type) return 0;
  return prices.get(`${m.supplier}|${m.type}`) || 0;
}

// Per-workspace revenue for a single YYYY-MM month, from the revenue cache.
async function revenueByWorkspaceForMonth(month) {
  const out = {};                            // workspace_id → { delivered, revenue, manual_leads, manual_revenue }
  const livePriceMap = {};
  try {
    const rows = db.prepare('SELECT workspace_id, price_per_lead FROM clients').all();
    for (const r of rows) livePriceMap[r.workspace_id] = r.price_per_lead;
  } catch {}
  // Apply the same nonlead exclusions as the admin commission page:
  // manual nonlead_overrides + PlusVibe non-lead label.
  let manualNonleads = new Set();
  try {
    manualNonleads = new Set(
      db.prepare(`SELECT email FROM nonlead_overrides WHERE active = 1`).all()
        .map(r => String(r.email || '').toLowerCase())
    );
  } catch {}
  for (const l of (revenueCache.leads || [])) {
    if (!l || isRevenueExcludedWorkspace(l)) continue;
    if (l.pv_nonlead || isPvNonLeadLabel(l.label)) continue;
    if (manualNonleads.has(String(l.lead_email || '').toLowerCase())) continue;
    if (!(l.date || '').startsWith(month)) continue;
    const ws = l.workspace_id;
    if (!out[ws]) out[ws] = { delivered: 0, revenue: 0, manual_leads: 0, manual_revenue: 0 };
    out[ws].delivered++;
    out[ws].revenue += livePriceMap[ws] ?? l.lead_price ?? 0;
  }
  // Merge manually-entered revenue
  const pgdb = app.locals?.pgDb;
  if (pgdb) {
    try {
      const entries = await pgdb.listManualRevenueEntries(month);
      for (const e of entries) {
        const ws = e.workspace_id;
        const entryRev = e.lead_count * Number(e.price_per_lead);
        if (!out[ws]) out[ws] = { delivered: 0, revenue: 0, manual_leads: 0, manual_revenue: 0 };
        out[ws].delivered      += e.lead_count;
        out[ws].revenue        += entryRev;
        out[ws].manual_leads   += e.lead_count;
        out[ws].manual_revenue += entryRev;
      }
    } catch (err) {
      console.warn('[revenue] manual entries merge failed:', err.message);
    }
  }
  return out;
}

// Build the per-client + agency P&L for a month. This is the core view.
async function buildFinanceSnapshot(month) {
  const pgdb = app.locals.pgDb;
  const allMailboxes = _mailboxCache.mailboxes || [];

  // Tag mailboxes with supplier/type from mailbox_meta, same as the API does.
  const meta = pgdb ? await pgdb.listMailboxMeta() : [];
  const metaByEmail = new Map(meta.map(m => [m.email, m]));
  const mailboxes = mergeMailboxesWithMeta(allMailboxes, metaByEmail);

  // Mailbox unit costs (supplier × type → $/mo).
  const pricingRows = pgdb ? await pgdb.listMailboxPricing() : [];
  const prices = pricingMap(pricingRows);

  // Workspace metadata — load first so we can filter inactive workspaces
  // out of the cost and client rows below.
  const wsMeta = {};
  try {
    const rows = db.prepare('SELECT workspace_id, workspace_name, client_status, campaign_manager FROM clients').all();
    for (const r of rows) wsMeta[r.workspace_id] = r;
  } catch {}

  // Mailbox cost grouped by workspace + by supplier — all clients regardless of status.
  // A client marked inactive mid-month still has real mailbox spend for that month.
  const costByWorkspace  = {};
  const costBySupplier   = {};
  const countByWorkspace = {};
  for (const m of mailboxes) {
    const cost = mailboxUnitCost(m, prices);
    const ws = m.workspace_id || 'unassigned';
    costByWorkspace[ws]  = (costByWorkspace[ws]  || 0) + cost;
    countByWorkspace[ws] = (countByWorkspace[ws] || 0) + 1;
    const sup = m.supplier || 'Unassigned';
    costBySupplier[sup] = (costBySupplier[sup] || 0) + cost;
  }

  // Revenue per workspace for this month.
  const revenue = await revenueByWorkspaceForMonth(month);

  // Per-client P&L rows — all clients that had revenue OR mailboxes this month.
  // Inactive clients are included if they have activity — they generated real
  // revenue and costs even if they've since been paused.
  const activeWsIds = new Set([
    ...Object.keys(wsMeta),
    ...Object.keys(revenue),
    ...Object.keys(countByWorkspace).filter(id => id !== 'unassigned'),
  ]);

  const clients = [];
  for (const id of activeWsIds) {
    if (id === 'unassigned') continue;
    const rev   = revenue[id]?.revenue || 0;
    const cost  = costByWorkspace[id] || 0;
    const delivered = revenue[id]?.delivered || 0;
    const meta = wsMeta[id] || {};
    // Skip clients with no activity this month (no revenue, no mailboxes)
    if (rev === 0 && cost === 0 && !countByWorkspace[id]) continue;
    clients.push({
      workspace_id: id,
      workspace_name: meta.workspace_name || id,
      client_status: meta.client_status || 'active',
      delivered,
      revenue: rev,
      mailbox_cost: cost,
      mailbox_count: countByWorkspace[id] || 0,
      gross_profit: rev - cost,
      gross_margin: rev > 0 ? (rev - cost) / rev : null,
      manual_leads:   revenue[id]?.manual_leads   || 0,
      manual_revenue: revenue[id]?.manual_revenue || 0,
    });
  }
  clients.sort((a, b) => b.gross_profit - a.gross_profit);

  // Operating expenses active in this month — convert each expense to GBP
  // using the month's FX rate. Expenses are stored in their native currency
  // (USD default in DB); the frontend also converts via FX, so the KPI tile
  // and the expense table must agree.
  const allExpenses = pgdb ? await pgdb.listMonthlyExpenses() : [];
  const activeExpenses = allExpenses.filter(e => expenseActiveInMonth(e, month));
  let snapshotFx = { GBP: 1, USD: 1, EUR: 1, ZAR: 1 };
  try { snapshotFx = { ...snapshotFx, ...(await getFxRatesForMonth(month)) }; } catch {}
  const toGBPServer = (amount, currency) => {
    const rate = snapshotFx[(currency || 'GBP').toUpperCase()];
    return parseFloat(amount) * (rate != null ? rate : 1);
  };
  const totalOpex = activeExpenses.reduce((s, e) => s + toGBPServer(e.amount, e.currency), 0);

  // Staff costs — manager base salaries + commission on their clients' revenue.
  // Commission rate lives on the manager row; commission_rate on the client row
  // is kept as a legacy fallback for the commission.html page only.
  let allManagers = [];
  try { allManagers = db.prepare('SELECT name, commission_rate, base_salary FROM managers').all(); } catch {}
  const managerMap  = new Map(allManagers.map(m => [m.name.toLowerCase(), m]));

  // Revenue per manager = sum of lead revenue from their clients this month,
  // applying manager_start_date (same logic as the admin commission page).
  const clientMetaMap = {};
  // Track canonical name casing from campaign_manager / campaign_manager_2 fields.
  const mgrCanonicalName = {};  // lower → original case
  try {
    db.prepare('SELECT workspace_id, campaign_manager, campaign_manager_2, manager_start_date FROM clients').all()
      .forEach(r => {
        clientMetaMap[r.workspace_id] = r;
        const n1 = (r.campaign_manager  || '').trim(); if (n1) mgrCanonicalName[n1.toLowerCase()] = n1;
        const n2 = (r.campaign_manager_2 || '').trim(); if (n2) mgrCanonicalName[n2.toLowerCase()] = n2;
      });
  } catch {}
  let manualNonleadsSet = new Set();
  try {
    manualNonleadsSet = new Set(
      db.prepare(`SELECT email FROM nonlead_overrides WHERE active = 1`).all()
        .map(r => String(r.email || '').toLowerCase())
    );
  } catch {}
  const revenueByManager = {};
  const livePriceMapMgr = {};
  try {
    db.prepare('SELECT workspace_id, price_per_lead FROM clients').all()
      .forEach(r => { livePriceMapMgr[r.workspace_id] = r.price_per_lead; });
  } catch {}
  for (const l of (revenueCache.leads || [])) {
    if (!l || isRevenueExcludedWorkspace(l)) continue;
    if (l.pv_nonlead || isPvNonLeadLabel(l.label)) continue;
    if (manualNonleadsSet.has(String(l.lead_email || '').toLowerCase())) continue;
    if (!(l.date || '').startsWith(month)) continue;
    const meta = clientMetaMap[l.workspace_id];
    if (!meta) continue;
    const mgr1 = (meta.campaign_manager   || '').toLowerCase().trim();
    const mgr2 = (meta.campaign_manager_2 || '').toLowerCase().trim();
    if (!mgr1 && !mgr2) continue;
    if (meta.manager_start_date && l.date < meta.manager_start_date) continue;
    const price    = livePriceMapMgr[l.workspace_id] ?? l.lead_price ?? 0;
    const numMgrs  = (mgr1 ? 1 : 0) + (mgr2 ? 1 : 0);
    const share    = price / numMgrs;
    if (mgr1) revenueByManager[mgr1] = (revenueByManager[mgr1] || 0) + share;
    if (mgr2) revenueByManager[mgr2] = (revenueByManager[mgr2] || 0) + share;
  }

  // Union of manager names: anyone in the managers table OR anyone with revenue
  // attributed to them via campaign_manager on clients this month.
  // This mirrors how commission.html builds its earner list (it derives earners
  // from campaign_manager, not from the managers auth table).
  const allMgrKeys = new Set([
    ...allManagers.map(m => m.name.toLowerCase()),
    ...Object.keys(revenueByManager),
  ]);
  const staffRows = [];
  for (const key of allMgrKeys) {
    const mgr        = managerMap.get(key);
    const name       = mgr?.name || mgrCanonicalName[key] || key;
    const mgrRevenue = revenueByManager[key] || 0;
    const commRate   = (mgr?.commission_rate ?? 15) / 100;
    const commission = mgrRevenue * commRate;
    const salaryZar  = mgr?.base_salary || 0;
    // Salary is stored in ZAR — convert to GBP for finance P&L
    const zarToGbp   = snapshotFx.ZAR || 0.042;
    const salary      = salaryZar * zarToGbp;
    if (salary > 0 || commission > 0) {
      staffRows.push({ name, base_salary: salary, base_salary_zar: salaryZar, commission_rate: mgr?.commission_rate ?? 5, client_revenue: mgrRevenue, commission, total: salary + commission });
    }
  }
  staffRows.sort((a, b) => b.total - a.total);

  const totalStaffCost = staffRows.reduce((s, m) => s + m.total, 0);

  // Mailbox spend not tied to a workspace (e.g. supplier-level inventory).
  const unassignedMailboxCost = costByWorkspace['unassigned'] || 0;

  const totalRevenue        = clients.reduce((s, c) => s + c.revenue, 0);
  const totalMailboxCost    = clients.reduce((s, c) => s + c.mailbox_cost, 0) + unassignedMailboxCost;
  const grossProfit         = totalRevenue - totalMailboxCost;
  const netProfit           = grossProfit - totalOpex - totalStaffCost;

  return {
    month,
    clients,
    bySupplier: Object.entries(costBySupplier).map(([supplier, monthly_cost]) => ({
      supplier,
      monthly_cost,
      mailbox_count: mailboxes.filter(m => (m.supplier || 'Unassigned') === supplier).length,
    })).sort((a, b) => b.monthly_cost - a.monthly_cost),
    expenses: activeExpenses,
    staff: staffRows,
    pricing: pricingRows,
    totals: {
      revenue: totalRevenue,
      mailbox_cost: totalMailboxCost,
      unassigned_mailbox_cost: unassignedMailboxCost,
      opex: totalOpex,
      staff_cost: totalStaffCost,
      gross_profit: grossProfit,
      gross_margin: totalRevenue > 0 ? grossProfit / totalRevenue : null,
      net_profit: netProfit,
      net_margin: totalRevenue > 0 ? netProfit / totalRevenue : null,
      mailbox_total: mailboxes.length,
    },
  };
}

app.get('/api/finance/snapshot', requireAdmin, async (req, res) => {
  try {
    const month = (req.query.month || currentMonthStr()).slice(0, 7);
    const snapshot = await buildFinanceSnapshot(month);
    console.log(`[finance] snapshot month=${month} clients=${snapshot.clients.length} revenue=${snapshot.totals.revenue.toFixed(2)} staff=${JSON.stringify(snapshot.staff)}`);
    res.json(snapshot);
  } catch (err) {
    console.error('[finance] error:', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/finance/staff-debug', requireAdmin, (req, res) => {
  const month = (req.query.month || currentMonthStr()).slice(0, 7);
  let allManagers = [];
  try { allManagers = db.prepare('SELECT name, commission_rate, base_salary FROM managers').all(); } catch (e) { return res.json({ error: 'managers query failed: ' + e.message }); }
  const clientMetaMap = {};
  const mgrCanonicalName = {};
  let clientMetaError = null;
  try {
    db.prepare('SELECT workspace_id, campaign_manager, manager_start_date FROM clients').all()
      .forEach(r => {
        clientMetaMap[r.workspace_id] = r;
        const name = (r.campaign_manager || '').trim();
        if (name) mgrCanonicalName[name.toLowerCase()] = name;
      });
  } catch (e) { clientMetaError = e.message; }
  const revenueByManager = {};
  const livePriceMapMgr = {};
  try { db.prepare('SELECT workspace_id, price_per_lead FROM clients').all().forEach(r => { livePriceMapMgr[r.workspace_id] = r.price_per_lead; }); } catch {}
  let skipped = { excluded: 0, nonlead: 0, date: 0, noMeta: 0, noMgr: 0, startDate: 0, counted: 0 };
  for (const l of (revenueCache.leads || [])) {
    if (!l || isRevenueExcludedWorkspace(l)) { skipped.excluded++; continue; }
    if (l.pv_nonlead || isPvNonLeadLabel(l.label)) { skipped.nonlead++; continue; }
    if (!(l.date || '').startsWith(month)) { skipped.date++; continue; }
    const meta = clientMetaMap[l.workspace_id];
    if (!meta) { skipped.noMeta++; continue; }
    const mgr = (meta.campaign_manager || '').toLowerCase().trim();
    if (!mgr) { skipped.noMgr++; continue; }
    if (meta.manager_start_date && l.date < meta.manager_start_date) { skipped.startDate++; continue; }
    const price = livePriceMapMgr[l.workspace_id] ?? l.lead_price ?? 0;
    revenueByManager[mgr] = (revenueByManager[mgr] || 0) + price;
    skipped.counted++;
  }
  res.json({ month, allManagers, mgrCanonicalName, revenueByManager, clientMetaError, skipped, revenueCacheLeads: revenueCache.leads?.length ?? 0 });
});

// FX rates — fetch historical rates from frankfurter.app (free, ECB data,
// no API key). Cached in-process by month since historical rates don't
// change. Returns the GBP value of 1 unit of each foreign currency for the
// first day of the requested month (or today if month is the current month).
const _fxCache = new Map(); // month → { USD, EUR, ZAR, GBP }
async function getFxRatesForMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must be YYYY-MM');
  if (_fxCache.has(month)) return _fxCache.get(month);
  // Use first day of month for historical; frankfurter returns nearest
  // available rate (skips weekends/holidays automatically).
  const date = `${month}-01`;
  const today = new Date().toISOString().slice(0, 10);
  const queryDate = date > today ? today : date;
  // ECB doesn't quote ZAR directly — pull via USD as base then derive.
  const url = `https://api.frankfurter.app/${queryDate}?from=GBP&to=USD,EUR,ZAR`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`frankfurter ${resp.status}`);
  const data = await resp.json();
  // frankfurter returns "rates: { USD: 1.27 }" meaning 1 GBP = 1.27 USD.
  // We want GBP-per-unit-of-X (i.e. multiplier to convert X amount → GBP).
  const r = data.rates || {};
  const rates = {
    GBP: 1,
    USD: r.USD ? 1 / r.USD : null,
    EUR: r.EUR ? 1 / r.EUR : null,
    ZAR: r.ZAR ? 1 / r.ZAR : null,
  };
  // Only cache if we got at least one rate back — don't poison the cache
  // on a partial outage.
  if (rates.USD || rates.EUR || rates.ZAR) _fxCache.set(month, rates);
  return rates;
}

app.get('/api/finance/fx-rates', requireAdmin, async (req, res) => {
  try {
    const month = String(req.query.month || '').trim();
    const rates = await getFxRatesForMonth(month);
    res.json({ month, rates });
  } catch (err) {
    console.warn('[finance] fx-rates fetch failed:', err.message);
    // Soft-fail with sensible fallback so the page still renders.
    res.json({
      month: req.query.month,
      rates: { GBP: 1, USD: 0.79, EUR: 0.85, ZAR: 0.042 },
      fallback: true,
      error: err.message,
    });
  }
});

// Billing cycle breakdown — groups mailboxes by supplier+client+renewal_day
// Returns rows: { supplier, client, renewal_day, next_renewal, google, microsoft, smtp, other, total_cost }
app.get('/api/finance/billing-cycles', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    const pricingRows = pgdb ? await pgdb.listMailboxPricing() : [];
    const priceMap = {};
    for (const p of pricingRows) priceMap[`${p.supplier}|${p.mailbox_type}`] = parseFloat(p.unit_cost) || 0;

    // Read fresh mailbox_meta so supplier tags are current (cache may be up to 30m stale)
    const metaRows = pgdb ? await pgdb.listMailboxMeta() : [];
    const metaByEmail = new Map(metaRows.map(r => [r.email.toLowerCase(), r]));

    const mailboxes = _mailboxCache.mailboxes || [];
    const groups = {};
    for (const m of mailboxes) {
      const meta     = metaByEmail.get((m.email || '').toLowerCase()) || {};
      const supplier = meta.supplier || m.supplier || 'Unassigned';
      const client   = m.workspace_name || 'Unassigned';
      const key      = `${supplier}||${client}`;
      if (!groups[key]) groups[key] = { supplier, client, renewal_day: null, google: 0, microsoft: 0, smtp: 0, other: 0, total_cost: 0 };
      const g = groups[key];
      const t = (meta.mailbox_type || m.type || detectMailboxType(m.provider) || 'smtp').toLowerCase();
      if (t === 'google') g.google++;
      else if (t === 'microsoft') g.microsoft++;
      else if (t === 'smtp') g.smtp++;
      else g.other++;
      const unitCost = parseFloat(m.unit_cost) || priceMap[`${supplier}|${t}`] || 0;
      g.total_cost += unitCost;
      // Use billing date from fresh meta first, then cached
      const bsd = meta.billing_start_date || m.billing_start_date;
      const bday = meta.billing_day || m.billing_day;
      if (!g.renewal_day && bsd) {
        g.renewal_day = bday || new Date(bsd).getDate();
      }
    }

    // Compute next_renewal date for groups that have a renewal_day
    const now = new Date();
    const rows = Object.values(groups).map(g => {
      let next_renewal = null;
      if (g.renewal_day) {
        let d = new Date(now.getFullYear(), now.getMonth(), g.renewal_day);
        if (d <= now) d = new Date(now.getFullYear(), now.getMonth() + 1, g.renewal_day);
        next_renewal = d.toISOString().slice(0, 10);
      }
      return { ...g, next_renewal, total_count: g.google + g.microsoft + g.smtp + g.other };
    });

    rows.sort((a, b) => a.supplier.localeCompare(b.supplier) || a.client.localeCompare(b.client));
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mailbox pricing CRUD
app.get('/api/finance/pricing', requireAdmin, async (req, res) => {
  try { res.json({ rows: await app.locals.pgDb.listMailboxPricing() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/finance/pricing', requireAdmin, async (req, res) => {
  try {
    const { supplier, mailbox_type, unit_cost, notes } = req.body || {};
    if (!supplier || !mailbox_type) return res.status(400).json({ error: 'supplier and mailbox_type required' });
    if (!(unit_cost >= 0))          return res.status(400).json({ error: 'Invalid cost' });
    const row = await app.locals.pgDb.upsertMailboxPricing(supplier, mailbox_type, unit_cost, notes);
    res.json({ ok: true, row });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/finance/pricing', requireAdmin, async (req, res) => {
  try {
    const { supplier, mailbox_type } = req.body || {};
    if (!supplier || !mailbox_type) return res.status(400).json({ error: 'supplier and mailbox_type required' });
    await app.locals.pgDb.query(
      'DELETE FROM mailbox_pricing WHERE supplier = $1 AND mailbox_type = $2',
      [supplier, mailbox_type]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Monthly expenses CRUD
app.get('/api/finance/expenses', requireAdmin, async (req, res) => {
  try { res.json({ rows: await app.locals.pgDb.listMonthlyExpenses() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/finance/expenses', requireAdmin, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const { label, category, amount, currency, start_month, end_month, notes } = req.body || {};
    if (!label) return res.status(400).json({ error: 'Label required' });
    if (!(parseFloat(amount) > 0)) return res.status(400).json({ error: 'Amount must be > 0' });
    if (!/^\d{4}-\d{2}$/.test(start_month || '')) return res.status(400).json({ error: 'Start month must be YYYY-MM format' });
    if (end_month && !/^\d{4}-\d{2}$/.test(end_month)) return res.status(400).json({ error: 'End month must be YYYY-MM format' });
    const row = await pgdb.createMonthlyExpense({ label, category, amount: parseFloat(amount), currency, start_month, end_month: end_month || null, notes });
    console.log(`[finance] expense added: ${label} $${amount}/mo from ${start_month}`);
    res.json({ ok: true, row });
  } catch (err) {
    console.error('[finance] create expense error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/finance/expenses/:id', requireAdmin, async (req, res) => {
  try {
    const row = await app.locals.pgDb.updateMonthlyExpense(parseInt(req.params.id), req.body || {});
    res.json({ ok: true, row });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/finance/expenses/:id', requireAdmin, async (req, res) => {
  try {
    await app.locals.pgDb.deleteMonthlyExpense(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Manual revenue entries ──────────────────────────────────────
app.get('/api/revenue/manual-entries', requireAdmin, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.json([]);
    const { month } = req.query;
    const rows = await pgdb.listManualRevenueEntries(month || null);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/revenue/manual-entries', requireAdmin, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
    const { workspace_id, month, lead_count, price_per_lead, note } = req.body || {};
    if (!workspace_id || !month || !lead_count || price_per_lead == null) {
      return res.status(400).json({ error: 'workspace_id, month, lead_count, price_per_lead required' });
    }
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }
    const count = parseInt(lead_count, 10);
    const price = parseFloat(price_per_lead);
    if (!Number.isFinite(count) || count < 1 || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'Invalid lead_count or price_per_lead' });
    }
    const row = await pgdb.createManualRevenueEntry({ workspace_id, month, lead_count: count, price_per_lead: price, note });
    res.json({ ok: true, row });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/revenue/manual-entries/:id', requireAdmin, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
    const ok = await pgdb.deleteManualRevenueEntry(parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: 'Entry not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Copy Analytics ─────────────────────────────────────────────
// Aggregates email_events (sent/reply/lead/bounce) by template (content_hash),
// subject line (subject_hash), and step number. Only surfaces data that is
// numerically grounded — no inference, no benchmarks.
app.get('/api/copy/analytics', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.json({ templates: [], subjects: [], by_step: [], stale: [] });
  const { workspace_id } = req.query;
  if (!workspace_id) return res.status(400).json({ error: 'Missing workspace_id' });

  if (!pgdb.pool) return res.status(503).json({ error: 'pg pool unavailable (SQLite fallback active)' });

  // Take a single pooled client so the TEMP TABLE persists across queries.
  // Each pgdb.query() check-out a different connection, which would lose the
  // temp table.
  const client = await pgdb.pool.connect();
  try {
    // Self-heal: ensure the variant-stats table exists. Migration in
    // db-postgres.js should create this on startup, but deploys can roll
    // out the new server.js code before the schema migration runs.
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaign_variant_stats (
        workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
        step INT NOT NULL, variant TEXT NOT NULL DEFAULT 'A',
        sent INT DEFAULT 0, reply INT DEFAULT 0, bounce INT DEFAULT 0, opened INT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workspace_id, campaign_id, step, variant)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaign_variant_stats_snapshots (
        workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
        step INT NOT NULL, variant TEXT NOT NULL DEFAULT 'A',
        snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
        sent INT DEFAULT 0, reply INT DEFAULT 0, bounce INT DEFAULT 0, opened INT DEFAULT 0,
        snapshot_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workspace_id, campaign_id, step, variant, snapshot_date)
      )
    `);

    // Ensure suppressed_templates exists — may not yet if schema migration
    // hasn't run on this DB instance.
    await client.query(`
      CREATE TABLE IF NOT EXISTS suppressed_templates (
        workspace_id  TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        suppressed_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (workspace_id, content_hash)
      )
    `);

    await client.query('BEGIN');

    // Authoritative lead emails for this workspace — PlusVibe labels via
    // revenueCache (same filters as the Stats/Revenue pages). These are the
    // real leads; we attribute them to templates by email→sent-event match
    // below, because 'lead' webhook events undercount badly. Lowercased.
    const nonleadEmails = new Set(
      db.prepare(`SELECT email FROM nonlead_overrides WHERE active = 1`).all()
        .map(o => o.email.toLowerCase())
    );
    const realLeads = (revenueCache.leads || []).filter(l =>
      l.workspace_id === workspace_id
      && !isRevenueExcludedWorkspace(l)
      && !nonleadEmails.has((l.lead_email || '').toLowerCase())
      && !(l.pv_nonlead || isPvNonLeadLabel(l.label)));
    // Parallel per-lead arrays (NOT deduped) so each lead is attributed once.
    const realLeadEmails    = realLeads.map(l => (l.lead_email || '').toLowerCase());
    const realLeadCampaigns = realLeads.map(l => l.campaign || '');
    const total_leads = realLeads.length;

    // Step 0 — build attributed_events: a temporary table linking each
    // email_event in this workspace to a content_hash via multiple strategies.
    //
    //   Strategy 1: event.content_hash (precise — backfilled from campaign_templates)
    //   Strategy 2: campaign_id + step → campaign_templates.content_hash
    //   Strategy 3: campaign_id alone (first step's template) — for events
    //               that have campaign but no step
    //   Strategy 4: lead_email proximity — a reply/lead/bounce inherits the
    //               content_hash of the most recent sent event for the same
    //               lead_email in this workspace. PlusVibe's reply webhook
    //               doesn't carry campaign metadata; this is how we tie a
    //               reply back to the template that triggered it.
    await client.query(`
      CREATE TEMP TABLE attributed_events ON COMMIT DROP AS
      WITH
      sent_resolved AS (
        SELECT
          ee.id, ee.lead_email, ee.event_at, ee.step, ee.campaign_id, ee.campaign_name,
          COALESCE(
            ee.content_hash,
            (SELECT ct.content_hash FROM campaign_templates ct
              WHERE ct.workspace_id = $1
                AND ct.campaign_id  = ee.campaign_id
                AND ct.step         = ee.step
              LIMIT 1),
            (SELECT ct.content_hash FROM campaign_templates ct
              WHERE ct.workspace_id = $1
                AND ct.campaign_id  = ee.campaign_id
              ORDER BY ct.step ASC LIMIT 1)
          ) AS content_hash
        FROM email_events ee
        WHERE ee.workspace_id = $1 AND ee.event_type = 'sent'
      ),
      non_sent_resolved AS (
        SELECT DISTINCT ON (ee.id)
          ee.id, ee.lead_email, ee.event_at,
          -- Normalise inconsistent webhook event names so downstream queries
          -- can use canonical names: all_email_replies → reply, etc.
          CASE
            WHEN ee.event_type ILIKE '%positive%'                                                        THEN 'positive_reply'
            WHEN ee.event_type ILIKE '%ooo%' OR ee.event_type ILIKE '%out_of_office%' OR ee.event_type ILIKE '%auto%repl%' THEN 'ooo'
            WHEN ee.event_type ILIKE '%bounce%' OR ee.event_type ILIKE '%bounced%'                       THEN 'bounce'
            WHEN ee.event_type ILIKE '%unsubscribe%'                                                     THEN 'unsubscribe'
            WHEN ee.event_type ILIKE '%complaint%' OR ee.event_type ILIKE '%spam%'                       THEN 'complaint'
            WHEN ee.event_type ILIKE '%mark%lead%' OR ee.event_type ILIKE '%marked_as_lead%' OR ee.event_type = 'lead' OR ee.event_type ILIKE '%interested%' THEN 'lead'
            WHEN ee.event_type ILIKE '%repl%'                                                            THEN 'reply'
            ELSE ee.event_type
          END AS event_type,
          COALESCE(
            ee.content_hash,
            (SELECT ct.content_hash FROM campaign_templates ct
              WHERE ct.workspace_id = $1
                AND ct.campaign_id  = ee.campaign_id
                AND ct.step         = ee.step
              LIMIT 1),
            (SELECT ct.content_hash FROM campaign_templates ct
              WHERE ct.workspace_id = $1
                AND ct.campaign_id  = ee.campaign_id
              ORDER BY ct.step ASC LIMIT 1),
            sa.content_hash
          ) AS content_hash,
          sa.event_at AS sent_at
        FROM email_events ee
        LEFT JOIN sent_resolved sa
          ON sa.lead_email = ee.lead_email
         AND sa.event_at  <= ee.event_at
        WHERE ee.workspace_id = $1
          AND ee.event_type IS NOT NULL
          AND ee.event_type <> 'sent'
        ORDER BY ee.id, sa.event_at DESC NULLS LAST
      )
      SELECT id, lead_email, event_at, 'sent'::text AS event_type, content_hash, NULL::int AS step
      FROM sent_resolved
      UNION ALL
      SELECT id, lead_email, event_at, event_type, content_hash, NULL::int AS step
      FROM non_sent_resolved
    `, [workspace_id]);

    // Attribute the REAL leads (PlusVibe labels) to a template so per-template
    // leads sum close to the Leads Generated card. Two strategies per lead:
    //   1. Email→send match: the content_hash of the most recent email actually
    //      sent to that address (precise — used when the send is in our
    //      webhook history).
    //   2. Campaign fallback: the lead's campaign entry template (step-1,
    //      top-sent variant). Covers older campaigns whose sends predate the
    //      webhook capture, so the lead still lands on a real template.
    // PlusVibe doesn't tell us the exact variant, so campaign-attributed leads
    // land on the campaign's primary step-1 variant.
    await client.query(`
      CREATE TEMP TABLE real_lead_hash ON COMMIT DROP AS
      WITH leads_in AS (
        SELECT lower(email) AS email, campaign
        FROM unnest($2::text[], $3::text[]) AS t(email, campaign)
      ),
      email_match AS (
        SELECT DISTINCT ON (lower(ee.lead_email))
          lower(ee.lead_email) AS email,
          COALESCE(
            ee.content_hash,
            (SELECT ct.content_hash FROM campaign_templates ct
              WHERE ct.workspace_id = $1 AND ct.campaign_id = ee.campaign_id AND ct.step = ee.step LIMIT 1),
            (SELECT ct.content_hash FROM campaign_templates ct
              WHERE ct.workspace_id = $1 AND ct.campaign_id = ee.campaign_id ORDER BY ct.step ASC LIMIT 1)
          ) AS content_hash
        FROM email_events ee
        WHERE ee.workspace_id = $1 AND ee.event_type = 'sent'
          AND lower(ee.lead_email) IN (SELECT email FROM leads_in WHERE email <> '')
        ORDER BY lower(ee.lead_email), ee.event_at DESC
      ),
      camp_entry AS (
        -- Per campaign, the step-1 variant with the most sends = entry template.
        SELECT DISTINCT ON (ct.campaign_name)
          ct.campaign_name, ct.content_hash
        FROM campaign_templates ct
        LEFT JOIN campaign_variant_stats cvs
          ON cvs.workspace_id = ct.workspace_id AND cvs.campaign_id = ct.campaign_id
         AND cvs.step = ct.step AND cvs.variant = ct.variant
        WHERE ct.workspace_id = $1
          AND ct.step = (SELECT MIN(c2.step) FROM campaign_templates c2
                          WHERE c2.workspace_id = ct.workspace_id AND c2.campaign_id = ct.campaign_id)
          AND ct.campaign_name IS NOT NULL
        ORDER BY ct.campaign_name, COALESCE(cvs.sent, 0) DESC
      ),
      attributed AS (
        SELECT COALESCE(em.content_hash, ce.content_hash) AS content_hash
        FROM leads_in li
        LEFT JOIN email_match em ON em.email = li.email
        LEFT JOIN camp_entry  ce ON ce.campaign_name = li.campaign
      )
      SELECT content_hash, COUNT(*)::int AS leads
      FROM attributed
      WHERE content_hash IS NOT NULL
      GROUP BY content_hash
    `, [workspace_id, realLeadEmails, realLeadCampaigns]);

    // Pre-aggregate event counts by content_hash so the JOIN to
    // campaign_templates (which multiplies rows when a template is used in
    // many campaigns) does not inflate the counts.
    //
    // Two sources contribute counts:
    //   1. PlusVibe variant-stats (authoritative for sent/reply/bounce per
    //      step+variant — only source that knows the step).
    //   2. attributed_events from webhook payloads — used for leads (PV
    //      variant-stats doesn't include lead counts).
    await client.query(`
      CREATE TEMP TABLE template_event_counts ON COMMIT DROP AS
      WITH
      pv AS (
        -- Per content_hash sent/reply/bounce from PlusVibe variant stats.
        SELECT
          ct.content_hash,
          SUM(cvs.sent)   AS sent,
          SUM(cvs.reply)  AS replies,
          SUM(cvs.bounce) AS bounces
        FROM campaign_templates ct
        LEFT JOIN campaign_variant_stats cvs
          ON cvs.workspace_id = ct.workspace_id
         AND cvs.campaign_id  = ct.campaign_id
         AND cvs.step         = ct.step
         AND cvs.variant      = ct.variant
        WHERE ct.workspace_id = $1
        GROUP BY ct.content_hash
      ),
      pv_7d AS (
        -- Last-7-day delta: current variant-stats minus the closest snapshot
        -- taken on/before (today - 7 days). Gives true per-step weekly counts.
        SELECT
          ct.content_hash,
          SUM(GREATEST(cvs.sent   - COALESCE(snap.sent,   0), 0)) AS sent_7d,
          SUM(GREATEST(cvs.reply  - COALESCE(snap.reply,  0), 0)) AS replies_7d,
          SUM(GREATEST(cvs.bounce - COALESCE(snap.bounce, 0), 0)) AS bounces_7d
        FROM campaign_templates ct
        LEFT JOIN campaign_variant_stats cvs
          ON cvs.workspace_id = ct.workspace_id
         AND cvs.campaign_id  = ct.campaign_id
         AND cvs.step         = ct.step
         AND cvs.variant      = ct.variant
        LEFT JOIN LATERAL (
          SELECT sent, reply, bounce
          FROM campaign_variant_stats_snapshots s
          WHERE s.workspace_id = ct.workspace_id
            AND s.campaign_id  = ct.campaign_id
            AND s.step         = ct.step
            AND s.variant      = ct.variant
            AND s.snapshot_date <= CURRENT_DATE - INTERVAL '7 days'
          ORDER BY s.snapshot_date DESC LIMIT 1
        ) snap ON TRUE
        WHERE ct.workspace_id = $1
        GROUP BY ct.content_hash
      ),
      web AS (
        -- Fallback counts from webhook event attribution. Only counted when
        -- PV variant-stats has nothing (lead counts always come from here).
        SELECT
          content_hash,
          COUNT(*) FILTER (WHERE event_type = 'sent')                            AS sent,
          COUNT(*) FILTER (WHERE event_type IN ('reply','positive_reply'))       AS replies,
          COUNT(*) FILTER (WHERE event_type = 'lead')                            AS leads,
          COUNT(*) FILTER (WHERE event_type = 'bounce')                          AS bounces,
          MAX(event_at) FILTER (WHERE event_type IN ('reply','lead','positive_reply')) AS last_positive_at
        FROM attributed_events
        WHERE content_hash IS NOT NULL
        GROUP BY content_hash
      ),
      web_7d AS (
        -- 7d webhook fallback — used only for leads (variant-stats doesn't
        -- track leads). Also feeds the recent-lead count.
        SELECT
          content_hash,
          COUNT(*) FILTER (WHERE event_type = 'lead') AS leads_7d
        FROM attributed_events
        WHERE content_hash IS NOT NULL
          AND event_at >= NOW() - INTERVAL '7 days'
        GROUP BY content_hash
      )
      SELECT
        COALESCE(pv.content_hash, web.content_hash) AS content_hash,
        COALESCE(NULLIF(pv.sent, 0),    web.sent,    0) AS sent,
        COALESCE(NULLIF(pv.replies, 0), web.replies, 0) AS replies,
        -- Leads: real PlusVibe-label leads attributed to this template by
        -- email→send match (real_lead_hash), NOT the sparse 'lead' webhook
        -- count, so per-template leads sum close to the Leads Generated card.
        COALESCE(rlh.leads, 0)                          AS leads,
        COALESCE(NULLIF(pv.bounces, 0), web.bounces, 0) AS bounces,
        web.last_positive_at,
        COALESCE(pv_7d.sent_7d, 0)    AS sent_7d,
        COALESCE(pv_7d.replies_7d, 0) AS replies_7d,
        COALESCE(pv_7d.bounces_7d, 0) AS bounces_7d,
        COALESCE(web_7d.leads_7d, 0)  AS leads_7d
      FROM pv FULL OUTER JOIN web ON pv.content_hash = web.content_hash
      LEFT JOIN pv_7d  ON pv_7d.content_hash  = COALESCE(pv.content_hash, web.content_hash)
      LEFT JOIN web_7d ON web_7d.content_hash = COALESCE(pv.content_hash, web.content_hash)
      LEFT JOIN real_lead_hash rlh ON rlh.content_hash = COALESCE(pv.content_hash, web.content_hash)
    `, [workspace_id]);

    // Per-template campaign list (also pre-aggregated to avoid multiplication
    // when JOINed with event counts). Campaigns are deduplicated and ordered
    // by most-recently-captured first so the email-preview modal shows the
    // currently-running campaigns at the top.
    await client.query(`
      CREATE TEMP TABLE template_campaign_info ON COMMIT DROP AS
      WITH
      -- Earliest real send per campaign. campaign_id is reliably present on
      -- sent events (unlike content_hash), so this gives a trustworthy
      -- "first ran" date even when captured_at was reset by an old sync.
      camp_first_send AS (
        SELECT campaign_id, MIN(event_at) AS first_send
        FROM email_events
        WHERE workspace_id = $1 AND event_type = 'sent' AND campaign_id IS NOT NULL
        GROUP BY campaign_id
      ),
      camp_latest AS (
        SELECT
          ct.content_hash, ct.campaign_name, ct.campaign_id, ct.campaign_status,
          MAX(ct.captured_at) AS recent_at,
          -- Active = the campaign is active AND this template actually sent in
          -- the last 7 days (tec.sent_7d). We do NOT trust ct.active alone: it
          -- comes from PlusVibe's per-variant is_active toggle, but list-all
          -- intermittently omits sequences, so disabled A/B variants keep a
          -- stale active=TRUE. Real 7-day send activity (from daily variant
          -- snapshots) reliably separates the sending variant from disabled
          -- ones and self-corrects. 7d (not 4h) avoids flipping on overnight /
          -- weekend / cap gaps; per-variant recency is only daily-grained.
          BOOL_OR(ct.active AND COALESCE(tec.sent_7d, 0) > 0) AS any_active,
          MIN(ct.step)        AS min_step,
          MAX(ct.step)        AS max_step,
          -- "Running since" = earliest of (first time we saw the template,
          -- first real send of its campaign). LEAST ignores NULLs so a
          -- campaign with no recorded sends still falls back to captured_at.
          LEAST(MIN(ct.captured_at), MIN(cfs.first_send)) AS first_seen
        FROM campaign_templates ct
        LEFT JOIN camp_first_send cfs ON cfs.campaign_id = ct.campaign_id
        LEFT JOIN template_event_counts tec ON tec.content_hash = ct.content_hash
        WHERE ct.workspace_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM suppressed_templates
            WHERE workspace_id = ct.workspace_id
              AND content_hash = ct.content_hash
          )
        GROUP BY ct.content_hash, ct.campaign_name, ct.campaign_id, ct.campaign_status
      )
      SELECT
        content_hash,
        ARRAY_AGG(campaign_name    ORDER BY recent_at DESC NULLS LAST) FILTER (WHERE campaign_name    IS NOT NULL) AS campaigns,
        ARRAY_AGG(campaign_id      ORDER BY recent_at DESC NULLS LAST) FILTER (WHERE campaign_id      IS NOT NULL) AS campaign_ids,
        ARRAY_AGG(DISTINCT campaign_status) FILTER (WHERE campaign_status IS NOT NULL) AS campaign_statuses,
        MIN(min_step)    AS min_step,
        MAX(max_step)    AS max_step,
        BOOL_OR(any_active) AS is_active,
        MIN(first_seen)  AS first_seen
      FROM camp_latest
      GROUP BY content_hash
    `, [workspace_id]);

    // ── 1. Per-template stats ────────────────────────────────────
    const tplRows = await client.query(`
      SELECT
        t.content_hash,
        t.subject,
        t.body_excerpt,
        t.body,
        tci.campaigns,
        tci.campaign_statuses,
        tci.min_step,
        tci.max_step,
        tci.is_active,
        tci.first_seen,
        COALESCE(tec.sent, 0)              AS sent,
        COALESCE(tec.replies, 0)           AS replies,
        COALESCE(tec.leads, 0)             AS leads,
        COALESCE(tec.bounces, 0)           AS bounces,
        COALESCE(tec.sent_7d, 0)           AS sent_7d,
        COALESCE(tec.replies_7d, 0)        AS replies_7d,
        COALESCE(tec.leads_7d, 0)          AS leads_7d,
        COALESCE(tec.bounces_7d, 0)        AS bounces_7d,
        tec.last_positive_at
      FROM templates t
      JOIN  template_campaign_info tci ON tci.content_hash = t.content_hash
      LEFT JOIN template_event_counts  tec ON tec.content_hash = t.content_hash
      ORDER BY COALESCE(tec.leads,0) DESC, COALESCE(tec.replies,0) DESC, COALESCE(tec.sent,0) DESC
    `);

    // ── 2. Per-subject-line stats ────────────────────────────────
    // Two CTEs: campaign_count counts distinct campaigns per subject directly
    // (using DISTINCT on campaign_templates), and stats SUMs per-template
    // counts. JOINing these avoids the JOIN multiplication bug.
    const subRows = await client.query(`
      WITH
      subj_campaigns AS (
        SELECT t.subject_hash, COUNT(DISTINCT ct.campaign_id) AS campaign_count
        FROM templates t
        JOIN campaign_templates ct ON ct.content_hash = t.content_hash AND ct.workspace_id = $1
        WHERE t.subject_hash IS NOT NULL
        GROUP BY t.subject_hash
      ),
      subj_stats AS (
        SELECT
          t.subject_hash,
          MIN(t.subject) AS subject,
          COUNT(DISTINCT t.content_hash) AS template_count,
          SUM(COALESCE(tec.sent, 0))        AS sent,
          SUM(COALESCE(tec.replies, 0))     AS replies,
          SUM(COALESCE(tec.leads, 0))       AS leads,
          SUM(COALESCE(tec.bounces, 0))     AS bounces,
          SUM(COALESCE(tec.sent_7d, 0))     AS sent_7d,
          SUM(COALESCE(tec.replies_7d, 0))  AS replies_7d,
          SUM(COALESCE(tec.leads_7d, 0))    AS leads_7d,
          SUM(COALESCE(tec.bounces_7d, 0))  AS bounces_7d
        FROM templates t
        JOIN  template_campaign_info tci ON tci.content_hash = t.content_hash
        LEFT JOIN template_event_counts tec ON tec.content_hash = t.content_hash
        WHERE t.subject_hash IS NOT NULL
          AND COALESCE(NULLIF(TRIM(t.subject), ''), NULL) IS NOT NULL
        GROUP BY t.subject_hash
      ),
      subj_status AS (
        SELECT t.subject_hash,
               ARRAY_AGG(DISTINCT ct.campaign_status ORDER BY ct.campaign_status) FILTER (WHERE ct.campaign_status IS NOT NULL) AS campaign_statuses,
               BOOL_OR(ct.active) AS is_active
        FROM templates t
        JOIN campaign_templates ct ON ct.content_hash = t.content_hash AND ct.workspace_id = $1
        WHERE t.subject_hash IS NOT NULL
        GROUP BY t.subject_hash
      )
      SELECT s.subject_hash, s.subject, s.template_count,
             COALESCE(c.campaign_count, 0) AS campaign_count,
             s.sent, s.replies, s.leads, s.bounces,
             s.sent_7d, s.replies_7d, s.leads_7d, s.bounces_7d,
             ss.campaign_statuses,
             -- Active only when a campaign is active AND the subject actually
             -- sent in the last 7d — same rule as the Templates tab, so a
             -- disabled variant's subject doesn't read "Active".
             (ss.is_active AND COALESCE(s.sent_7d, 0) > 0) AS is_active
      FROM subj_stats s
      LEFT JOIN subj_campaigns c USING (subject_hash)
      LEFT JOIN subj_status    ss USING (subject_hash)
      ORDER BY s.leads DESC, s.replies DESC, s.sent DESC
    `, [workspace_id]);

    // ── 3. Per-step stats ────────────────────────────────────────
    // Joins variant-stats via campaign_templates so we only count data that
    // has a captured template (matches the Templates/Subjects views).
    // Falls back to webhook events for replies/leads/bounces when
    // variant-stats is empty.
    const stepRows = await client.query(`
      WITH
      pv_step AS (
        SELECT ct.step,
               SUM(cvs.sent)   AS sent,
               SUM(cvs.reply)  AS replies,
               SUM(cvs.bounce) AS bounces
        FROM campaign_templates ct
        LEFT JOIN campaign_variant_stats cvs
          ON cvs.workspace_id = ct.workspace_id
         AND cvs.campaign_id  = ct.campaign_id
         AND cvs.step         = ct.step
         AND cvs.variant      = ct.variant
        WHERE ct.workspace_id = $1
        GROUP BY ct.step
      ),
      web_step AS (
        SELECT step,
               COUNT(*) FILTER (WHERE event_type IN ('reply','positive_reply')) AS replies,
               COUNT(*) FILTER (WHERE event_type = 'lead')                       AS leads,
               COUNT(*) FILTER (WHERE event_type = 'bounce')                     AS bounces
        FROM email_events
        WHERE workspace_id = $1 AND step IS NOT NULL
        GROUP BY step
      )
      SELECT
        COALESCE(pv.step, web.step) AS step,
        COALESCE(pv.sent, 0)                                       AS sent,
        COALESCE(NULLIF(pv.replies, 0), web.replies, 0)            AS replies,
        COALESCE(web.leads, 0)                                     AS leads,
        COALESCE(NULLIF(pv.bounces, 0), web.bounces, 0)            AS bounces
      FROM pv_step pv FULL OUTER JOIN web_step web ON pv.step = web.step
      ORDER BY COALESCE(pv.step, web.step) ASC
    `, [workspace_id]);

    // ── 4. Workspace-level totals ────────────────────────────────
    // Sent/replies/bounces from template_event_counts (PlusVibe variant stats —
    // same source as the per-template table so numbers are consistent).
    // Leads are NOT taken from email_events 'lead' webhooks — those fire
    // unreliably and undercount badly (e.g. ButterflyEco showed 4). The
    // authoritative lead source is PlusVibe lead labels in revenueCache, the
    // same source the Stats and Revenue pages use; we inject that count below.
    const totalsRow = await client.query(`
      SELECT
        COALESCE((SELECT SUM(sent)    FROM template_event_counts), 0) AS total_sent,
        COALESCE((SELECT SUM(replies) FROM template_event_counts), 0) AS total_replies,
        COALESCE((SELECT SUM(bounces) FROM template_event_counts), 0) AS total_bounces,
        0 AS window_days
    `);

    // ── 5. Decaying copy ─────────────────────────────────────────
    // Three conditions mirror the frontend profileFlags() thresholds exactly so
    // anything showing an "avoid" badge also appears here:
    //   A) Profiled: 500+ sends, <0.5% reply rate, 0 leads
    //   B) High bounce: 100+ sends, >=3% bounce rate
    //   C) True decay: had webhook signal, none in last 14 days
    const staleRows = await client.query(`
      SELECT
        t.content_hash,
        t.subject,
        t.body_excerpt,
        tci.campaigns,
        tci.min_step                                                AS step,
        tci.first_seen,
        (COALESCE(tec.replies, 0) + COALESCE(tec.leads, 0))        AS total_signal,
        0                                                           AS signal_14d,
        tec.last_positive_at                                        AS last_signal_at
      FROM templates t
      JOIN template_campaign_info tci ON tci.content_hash = t.content_hash
      JOIN template_event_counts  tec ON tec.content_hash = t.content_hash
      WHERE (
          -- Profiled/bounced: burnt copy regardless of active status
          (COALESCE(tec.sent, 0) >= 500
           AND COALESCE(tec.replies, 0)::float / NULLIF(tec.sent, 0) < 0.005
           AND COALESCE(tec.leads, 0) = 0)
          OR
          (COALESCE(tec.sent, 0) >= 100
           AND COALESCE(tec.bounces, 0)::float / NULLIF(tec.sent, 0) >= 0.03)
          OR
          -- True decay: only relevant for actively sending templates
          (tci.is_active = TRUE
           AND (COALESCE(tec.replies, 0) + COALESCE(tec.leads, 0)) > 0
           AND tec.last_positive_at IS NOT NULL
           AND tec.last_positive_at < NOW() - INTERVAL '14 days'
           AND tci.first_seen < NOW() - INTERVAL '14 days')
        )
      ORDER BY tec.last_positive_at ASC NULLS FIRST
    `);

    await client.query('COMMIT');

    // total_leads (authoritative revenueCache count) computed above, before the
    // temp tables, so the same lead set drives both the card and the per-
    // template email→send attribution.
    res.json({
      templates: tplRows.rows,
      subjects:  subRows.rows,
      by_step:   stepRows.rows,
      stale:     staleRows.rows,
      totals:    { ...(totalsRow.rows[0] || {}), total_leads },
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[copy/analytics]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Suppress a template: hide from copy analytics AND pause the matching
// variant(s) in every PlusVibe campaign that uses this content_hash.
app.post('/api/copy/suppress', requireSession, async (req, res) => {
  try {
    const { workspace_id, content_hash } = req.body || {};
    if (!workspace_id || !content_hash) return res.status(400).json({ error: 'Missing workspace_id or content_hash' });
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'pg not available' });

    // 1. Mark suppressed in dashboard
    await pgdb.query(
      `INSERT INTO suppressed_templates (workspace_id, content_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [workspace_id, content_hash]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Un-suppress a template (restore it to copy analytics).
app.delete('/api/copy/suppress', requireSession, async (req, res) => {
  try {
    const { workspace_id, content_hash } = req.body || {};
    if (!workspace_id || !content_hash) return res.status(400).json({ error: 'Missing workspace_id or content_hash' });
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'pg not available' });
    await pgdb.query(
      `DELETE FROM suppressed_templates WHERE workspace_id = $1 AND content_hash = $2`,
      [workspace_id, content_hash]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lightweight flagged-copy count for the Actions page alert. Returns total
// profiled/bounced template count per workspace WITHOUT suppression filter —
// so the alert fires on raw stats even after auto-disable has hidden them.
app.get('/api/copy/flagged-count', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'pg not available' });
    const { workspace_ids } = req.query; // comma-separated list
    const ids = (workspace_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.json({ total: 0, by_workspace: {} });

    const { rows } = await pgdb.query(`
      SELECT ct.workspace_id, COUNT(DISTINCT ct.content_hash) AS flagged
      FROM campaign_templates ct
      JOIN campaign_variant_stats cvs
        ON cvs.workspace_id = ct.workspace_id
       AND cvs.campaign_id  = ct.campaign_id
       AND cvs.step         = ct.step
       AND cvs.variant      = ct.variant
      WHERE ct.workspace_id = ANY($1::text[])
        AND ct.content_hash IS NOT NULL
      GROUP BY ct.workspace_id, ct.content_hash
      HAVING
        (SUM(cvs.sent) >= 500 AND SUM(cvs.reply)::float / NULLIF(SUM(cvs.sent), 0) < 0.005)
        OR (SUM(cvs.sent) >= 100 AND SUM(cvs.bounce)::float / NULLIF(SUM(cvs.sent), 0) >= 0.03)
    `, [ids]);

    const byWs = {};
    let total = 0;
    for (const r of rows) {
      byWs[r.workspace_id] = (byWs[r.workspace_id] || 0) + Number(r.flagged);
      total += Number(r.flagged);
    }
    res.json({ total, by_workspace: byWs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all suppressed templates — restores all copy to full visibility.
app.delete('/api/copy/suppress-all', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'pg not available' });
    const { rowCount } = await pgdb.query(`DELETE FROM suppressed_templates`);
    res.json({ ok: true, cleared: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-sync templates from PlusVibe for the given workspace. Forces a fresh
// captureCampaignTemplates run for every campaign, then triggers a backfill
// of historical event content_hashes. Useful when newly added templates
// aren't showing up because the periodic capture hasn't run yet.
app.post('/api/copy/refresh-templates', requireSession, async (req, res) => {
  try {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'Missing workspace_id' });

    var camp_raw = await bisonFetch('/api/campaigns', { wsId: ws.id || wsId || workspace_id });
    var campaigns = (camp_raw.data || []).map(function(c) { return { id: c.id, camp_name: c.name, status: c.status, sent_count: c.emails_sent || 0, replied_count: c.replied || 0, unique_opened_count: c.unique_opens || 0, bounced_count: c.bounced || 0, lead_count: c.total_leads || 0, lead_contacted_count: c.total_leads_contacted || 0, positive_reply_count: 0, sequences: [] }; });
    if (!Array.isArray(campaigns)) return res.status(502).json({ error: 'PlusVibe returned no campaigns' });

    let captured = 0;
    let statsRows = 0;
    for (const c of campaigns) {
      try {
        await captureCampaignTemplates(workspace_id, c);
        captured++;
      } catch (err) {
        console.warn('[copy/refresh] capture failed for', c.id, err.message);
      }
      // Pull per-step/per-variant counts from PlusVibe — the only source of
      // truth for which step each send/reply belongs to.
      try {
        statsRows += await captureVariationStats(workspace_id, c.id);
      } catch (err) {
        console.warn('[copy/refresh] variant-stats failed for', c.id, err.message);
      }
    }

    // Run backfill so older events get their content_hash attached.
    try { await backfillEmailEventHashes(); } catch {}

    res.json({ ok: true, captured, stats_rows: statsRows, total: campaigns.length });
  } catch (err) {
    console.error('[copy/refresh-templates]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic — exposes raw field-population stats so we can verify analytics
// is matching events correctly. Surfaces the data shape problems that cause
// templates to show 0 sent / 0 replies.
app.get('/api/copy/diagnostic', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'pg not available' });
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'Missing workspace_id' });

    const byType = await pgdb.query(`
      SELECT
        event_type,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE content_hash  IS NOT NULL) AS with_content_hash,
        COUNT(*) FILTER (WHERE campaign_id   IS NOT NULL) AS with_campaign_id,
        COUNT(*) FILTER (WHERE step          IS NOT NULL) AS with_step,
        COUNT(*) FILTER (WHERE lead_email    IS NOT NULL) AS with_lead_email,
        MIN(event_at) AS earliest,
        MAX(event_at) AS latest
      FROM email_events
      WHERE workspace_id = $1
      GROUP BY event_type
      ORDER BY total DESC
    `, [workspace_id]);

    const tplCount = await pgdb.query(`SELECT COUNT(*)::int AS n FROM campaign_templates WHERE workspace_id = $1`, [workspace_id]);
    const tplActive = await pgdb.query(`SELECT COUNT(*)::int AS n FROM campaign_templates WHERE workspace_id = $1 AND active = TRUE`, [workspace_id]);

    // How well can we attribute via each strategy?
    const attribution = await pgdb.query(`
      WITH classified AS (
        SELECT
          CASE
            WHEN ee.content_hash IS NOT NULL THEN 'direct_hash'
            WHEN ee.campaign_id IS NOT NULL AND ee.step IS NOT NULL
              AND EXISTS (SELECT 1 FROM campaign_templates ct
                WHERE ct.workspace_id = $1 AND ct.campaign_id = ee.campaign_id AND ct.step = ee.step) THEN 'campaign_step'
            WHEN ee.campaign_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM campaign_templates ct
                WHERE ct.workspace_id = $1 AND ct.campaign_id = ee.campaign_id) THEN 'campaign_only'
            WHEN ee.lead_email IS NOT NULL
              AND ee.event_type IN ('reply','lead','bounce','positive_reply')
              AND EXISTS (SELECT 1 FROM email_events s
                WHERE s.workspace_id = $1 AND s.event_type = 'sent' AND s.lead_email = ee.lead_email) THEN 'lead_email'
            ELSE 'unmatched'
          END AS strategy,
          ee.event_type
        FROM email_events ee
        WHERE ee.workspace_id = $1
      )
      SELECT event_type, strategy, COUNT(*) AS n
      FROM classified
      GROUP BY event_type, strategy
      ORDER BY event_type, n DESC
    `, [workspace_id]);

    const sample = await pgdb.query(`
      SELECT event_type, content_hash, campaign_id, step, lead_email, event_at,
             (SELECT array_agg(k) FROM jsonb_object_keys(raw) AS k) AS raw_keys
      FROM email_events
      WHERE workspace_id = $1
      ORDER BY event_at DESC LIMIT 8
    `, [workspace_id]);

    res.json({
      workspace_id,
      campaign_templates_total:  tplCount.rows[0]?.n || 0,
      campaign_templates_active: tplActive.rows[0]?.n || 0,
      events_by_type:            byType.rows,
      attribution_breakdown:     attribution.rows,
      recent_events_sample:      sample.rows,
    });
  } catch (err) {
    console.error('[copy/diagnostic]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Campaign filter snapshots ───────────────────────────────────
// Save the filter set the user had active when they pushed to a campaign,
// so later searches into the same campaign can recall it.
app.get('/api/campaign-filters', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.json({ rows: [] });
    res.json({ rows: await pgdb.listCampaignFilters() });
  } catch (err) {
    console.error('[campaign-filters] list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaign-filters', requireSession, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return res.status(503).json({ error: 'Database not available' });
    const { workspace_id, workspace_name, campaign_id, campaign_name, filters } = req.body || {};
    if (!workspace_id || !campaign_id) return res.status(400).json({ error: 'workspace_id and campaign_id required' });
    await pgdb.saveCampaignFilter({ workspace_id, workspace_name, campaign_id, campaign_name, filters });
    console.log(`[campaign-filters] saved ${workspace_name || workspace_id} / ${campaign_name || campaign_id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[campaign-filters] save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/campaign-filters/:workspace_id/:campaign_id', requireSession, async (req, res) => {
  try {
    await app.locals.pgDb.deleteCampaignFilter(req.params.workspace_id, req.params.campaign_id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/finance/trend — last 12 months of revenue + mailbox cost for charting
app.get('/api/finance/trend', requireAdmin, async (req, res) => {
  try {
    const pgdb = app.locals.pgDb;
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');

      const rev = await revenueByWorkspaceForMonth(month);
      const totalRevenue = Object.values(rev).reduce((s, v) => s + v.revenue, 0);

      // Mailbox cost — sum unit costs from meta for active mailboxes
      const pricingRows = pgdb ? await pgdb.listMailboxPricing() : [];
      const prices = pricingMap(pricingRows);
      const metaRows = pgdb ? await pgdb.listMailboxMeta() : [];
      const metaByEmail = new Map(metaRows.map(m => [m.email, m]));
      const allMbx = mergeMailboxesWithMeta(_mailboxCache.mailboxes || [], metaByEmail);
      const totalMailboxCost = allMbx.reduce((s, m) => s + mailboxUnitCost(m, prices), 0);

      // Active opex — convert to GBP using that month's FX rates
      const allExp = pgdb ? await pgdb.listMonthlyExpenses() : [];
      let trendFx = { GBP: 1, USD: 1, EUR: 1, ZAR: 1 };
      try { trendFx = { ...trendFx, ...(await getFxRatesForMonth(month)) }; } catch {}
      const opex = allExp.filter(e => expenseActiveInMonth(e, month)).reduce((s, e) => {
        const rate = trendFx[(e.currency || 'GBP').toUpperCase()];
        return s + parseFloat(e.amount) * (rate != null ? rate : 1);
      }, 0);

      months.push({ month, revenue: totalRevenue, mailbox_cost: totalMailboxCost, opex });
    }
    res.json({ months });
  } catch (err) {
    console.error('[finance/trend]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI Chat ──────────────────────────────────────────────────────────────────
async function buildChatContext(workspace_id) {
  const pgdb = app.locals.pgDb;
  const today = new Date().toISOString().slice(0, 10);
  let ctx = `You are an AI assistant embedded in the Ottaly cold email dashboard.\nToday is ${today}. Answer questions about campaigns, revenue, copy performance, and operations.\nBe concise and specific — reference actual numbers from the data below. If data is unavailable, say so.\n\n`;

  // Revenue summary (live from PlusVibe via in-memory cache)
  if (revenueCache?.leads?.length) {
    const byWs = {};
    revenueCache.leads.forEach(l => {
      if (!byWs[l.workspace_id]) byWs[l.workspace_id] = { name: l.workspace_name || l.workspace_id, leads: 0, revenue: 0 };
      byWs[l.workspace_id].leads++;
      byWs[l.workspace_id].revenue += Number(l.lead_price) || 0;
    });
    ctx += 'WORKSPACE REVENUE (all-time leads from PlusVibe):\n';
    Object.values(byWs).sort((a, b) => b.leads - a.leads).forEach(w => {
      ctx += `  ${w.name}: ${w.leads} leads, £${w.revenue.toFixed(0)} revenue\n`;
    });
    ctx += '\n';
  }

  // Client config (price per lead, status, manager)
  if (db) {
    try {
      const clients = db.prepare('SELECT workspace_name, price_per_lead, client_status, campaign_manager FROM clients ORDER BY workspace_name').all();
      if (clients.length) {
        ctx += 'CLIENT CONFIG:\n';
        clients.forEach(c => {
          ctx += `  ${c.workspace_name}: £${c.price_per_lead || 0}/lead, status: ${c.client_status || 'active'}, manager: ${c.campaign_manager || 'unassigned'}\n`;
        });
        ctx += '\n';
      }
    } catch {}
  }

  // Manager commission config
  if (db) {
    try {
      const managers = db.prepare('SELECT name, commission_rate, base_salary FROM managers ORDER BY name').all();
      if (managers.length) {
        ctx += 'MANAGERS:\n';
        managers.forEach(m => {
          ctx += `  ${m.name}: ${m.commission_rate || 0}% commission${m.base_salary ? `, £${m.base_salary} base salary` : ''}\n`;
        });
        ctx += '\n';
      }
    } catch {}
  }

  // Email performance from Postgres (last 30 days)
  if (pgdb) {
    try {
      const wsWhere = workspace_id ? 'AND workspace_id = $1' : '';
      const params  = workspace_id ? [workspace_id] : [];
      const r = await pgdb.query(`
        SELECT workspace_id,
          COUNT(*) FILTER (WHERE event_type = 'sent') AS sent,
          COUNT(*) FILTER (WHERE event_type = 'reply'  AND campaign_id IS NOT NULL) AS replies,
          COUNT(*) FILTER (WHERE event_type = 'lead')  AS leads,
          COUNT(*) FILTER (WHERE event_type = 'bounce' AND campaign_id IS NOT NULL) AS bounces
        FROM email_events
        WHERE event_at >= NOW() - INTERVAL '30 days' ${wsWhere}
        GROUP BY workspace_id ORDER BY sent DESC LIMIT 15
      `, params);
      if (r.rows.length) {
        ctx += 'EMAIL PERFORMANCE (last 30 days):\n';
        r.rows.forEach(row => {
          const rr = row.sent > 0 ? ((row.replies / row.sent) * 100).toFixed(1) : '0';
          ctx += `  ${row.workspace_id}: ${row.sent} sent, ${row.replies} replies (${rr}%), ${row.leads} leads, ${row.bounces} bounces\n`;
        });
        ctx += '\n';
      }
    } catch {}
  }

  return ctx;
}

app.post('/api/chat', requireSession, async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI chat not configured — set GROQ_API_KEY env var' });

  const { message, history = [], workspace_id } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Missing message' });

  try {
    const context = await buildChatContext(workspace_id || null);
    const messages = [
      { role: 'system', content: context },
      ...(history || []).slice(-20).map(h => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: String(h.content || '')
      })),
      { role: 'user', content: String(message) }
    ];

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.3,
        max_tokens: 1024
      })
    });
    const data = await groqRes.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ reply: data.choices?.[0]?.message?.content || 'No response' });
  } catch (err) {
    console.error('[chat] Groq error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/finance',      (req, res) => res.sendFile(path.join(__dirname, 'finance.html')));
app.get('/finance.html', (req, res) => res.sendFile(path.join(__dirname, 'finance.html')));
app.get('/workload',      (req, res) => res.sendFile(path.join(__dirname, 'workload.html')));
app.get('/workload.html', (req, res) => res.sendFile(path.join(__dirname, 'workload.html')));

// Apply variant optimisation — pauses losing variants via PlusVibe
app.post('/api/campaigns/apply-optimisation', requireSession, async (req, res) => {
  const { wsId, campId, step, loserVariations } = req.body;
  if (!wsId || !campId || !step || !loserVariations?.length)
    return res.status(400).json({ error: 'Missing params' });
  try {
    // Get current campaign sequence structure
    var camp_raw = await bisonFetch('/api/campaigns', { wsId: ws.id || wsId || workspace_id });
    var campaigns = (camp_raw.data || []).map(function(c) { return { id: c.id, camp_name: c.name, status: c.status, sent_count: c.emails_sent || 0, replied_count: c.replied || 0, unique_opened_count: c.unique_opens || 0, bounced_count: c.bounced || 0, lead_count: c.total_leads || 0, lead_contacted_count: c.total_leads_contacted || 0, positive_reply_count: 0, sequences: [] }; });
    const camp = (Array.isArray(campaigns) ? campaigns : []).find(c => c.id === campId);
    if (!camp) return res.status(404).json({ error: 'Campaign not found' });

    // Build updated sequences with losing variants deactivated
    const sequences = (camp.sequences || []).map(seq => {
      if (seq.seq_number !== step && seq.step !== step) return seq;
      return {
        ...seq,
        variants: (seq.variants || seq.variations || []).map(v => ({
          ...v,
          is_active: loserVariations.includes(v.variation) ? false : v.is_active
        }))
      };
    });

    console.warn('[bison] A/B variant deactivation not supported in EmailBison — skipping');
    var updateResult = { success: false, reason: 'not-supported-in-bison' };
    res.json({ ok: true, result: updateResult });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Workspace-leads proxy (now Bison-backed) ────
app.get('/api/pv/workspace-leads', requireSession, async (req, res) => {
  const { workspace_id, label, page, limit } = req.query;
  if (!workspace_id) return res.status(400).json({ error: 'Missing workspace_id' });
  try {
    const leads = await bisonWorkspaceLeads(workspace_id, {
      label, page: parseInt(page) || 1, perPage: parseInt(limit) || 100,
    });
    res.json({ leads });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ── Admin — workspaces ─────────────────────────────────────
app.get('/api/admin/workspaces', requireAdmin, async (req, res) => {
  try {
    // Bison workspaces: /api/workspaces/v1.1 → { data: [{id,name,...}] }.
    // admin.html expects a bare array of {id,name}, so unwrap + normalise.
    const raw = listBisonWorkspaces();
    const list = Array.isArray(raw) ? raw : (raw?.data || []);
    res.json(list.map(w => ({ id: String(w.id), name: w.name })));
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ── Admin — clients ────────────────────────────────────────
// ── Audience / ICP breakdown ─────────────────────────────────────────────────
// Returns per-segment contact counts, reply rates, and lead counts for a
// workspace. Used by icp.html to show which audiences are working per client.

// List campaigns that have email_events for a given workspace (for the ICP filter dropdown).
app.get('/api/audience/campaigns/:workspaceId', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  const { workspaceId } = req.params;
  try {
    const { rows } = await pgdb.query(`
      SELECT campaign_id, campaign_name, COUNT(*) AS event_count
      FROM email_events
      WHERE workspace_id = $1 AND campaign_id IS NOT NULL AND campaign_name IS NOT NULL
      GROUP BY campaign_id, campaign_name
      ORDER BY event_count DESC
    `, [workspaceId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/audience/icp/:workspaceId', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  const { workspaceId } = req.params;
  const campaignId = req.query.campaign_id || null;
  const allClients = workspaceId === 'all';
  try {
    // Sent counts come from email_events (webhook-tracked 'sent' events).
    // We aggregate per email so a contact emailed 3 times in a cadence contributes 3 sends.
    // When a campaign_id filter is active, only count sends from that campaign, and restrict
    // contacts to those who received at least one email from that campaign.
    let SENT_CTE, WHERE, PARAMS;
    if (campaignId) {
      SENT_CTE = `WITH sent_per_email AS (
           SELECT LOWER(lead_email) AS email, COUNT(*) AS n
           FROM email_events WHERE workspace_id = $1 AND campaign_id = $2 AND event_type = 'sent'
           GROUP BY LOWER(lead_email)
         )`;
      WHERE = `WHERE c.workspace_id = $1 AND EXISTS (
           SELECT 1 FROM email_events ee
           WHERE ee.workspace_id = $1 AND ee.campaign_id = $2 AND LOWER(ee.lead_email) = LOWER(c.email)
         )`;
      PARAMS = [workspaceId, campaignId];
    } else if (allClients) {
      SENT_CTE = `WITH sent_per_email AS (
           SELECT LOWER(lead_email) AS email, COUNT(*) AS n
           FROM email_events WHERE event_type = 'sent'
           GROUP BY LOWER(lead_email)
         )`;
      WHERE = '';
      PARAMS = [];
    } else {
      SENT_CTE = `WITH sent_per_email AS (
           SELECT LOWER(lead_email) AS email, COUNT(*) AS n
           FROM email_events WHERE workspace_id = $1 AND event_type = 'sent'
           GROUP BY LOWER(lead_email)
         )`;
      WHERE = `WHERE c.workspace_id = $1`;
      PARAMS = [workspaceId];
    }
    const SEG_COLS = `
      COUNT(*)::int                                                                       AS total,
      COUNT(*) FILTER (WHERE c.status IN ('replied','interested','not_interested'))::int  AS replied,
      COUNT(*) FILTER (WHERE c.status = 'interested')::int                                AS leads,
      COUNT(*) FILTER (WHERE c.status = 'not_interested')::int                            AS not_interested,
      COALESCE(SUM(s.n), 0)::int                                                          AS sent
    `;
    const JOIN = `LEFT JOIN sent_per_email s ON s.email = LOWER(c.email)`;

    const [industry, size, city, county, seniority, totals] = await Promise.all([
      pgdb.query(`${SENT_CTE}
        SELECT COALESCE(NULLIF(TRIM(c.industry), ''), 'Unknown') AS segment, ${SEG_COLS}
        FROM contacts c ${JOIN} ${WHERE}
        GROUP BY segment ORDER BY total DESC LIMIT 25
      `, PARAMS),

      pgdb.query(`${SENT_CTE}
        SELECT
          CASE
            WHEN c.num_employees IS NULL   THEN 'Unknown'
            WHEN c.num_employees < 10      THEN '1–9'
            WHEN c.num_employees < 50      THEN '10–49'
            WHEN c.num_employees < 200     THEN '50–199'
            WHEN c.num_employees < 500     THEN '200–499'
            WHEN c.num_employees < 1000    THEN '500–999'
            ELSE '1000+'
          END AS segment, ${SEG_COLS}
        FROM contacts c ${JOIN} ${WHERE}
        GROUP BY segment ORDER BY MIN(COALESCE(c.num_employees, 99999))
      `, PARAMS),

      pgdb.query(`${SENT_CTE}
        SELECT COALESCE(NULLIF(TRIM(c.city), ''), NULLIF(TRIM(c.company_city), ''), 'Unknown') AS segment, ${SEG_COLS}
        FROM contacts c ${JOIN} ${WHERE}
        GROUP BY segment ORDER BY total DESC LIMIT 25
      `, PARAMS),

      pgdb.query(`${SENT_CTE}
        SELECT COALESCE(NULLIF(TRIM(c.state), ''), NULLIF(TRIM(c.company_state), ''), 'Unknown') AS segment, ${SEG_COLS}
        FROM contacts c ${JOIN} ${WHERE}
        GROUP BY segment ORDER BY total DESC LIMIT 25
      `, PARAMS),

      pgdb.query(`${SENT_CTE}
        SELECT COALESCE(NULLIF(TRIM(c.seniority), ''), 'Unknown') AS segment, ${SEG_COLS}
        FROM contacts c ${JOIN} ${WHERE}
        GROUP BY segment ORDER BY total DESC
      `, PARAMS),

      pgdb.query(`${SENT_CTE}
        SELECT
          COUNT(*)::int                                                                       AS total,
          COUNT(*) FILTER (WHERE c.status IN ('replied','interested','not_interested'))::int  AS replied,
          COUNT(*) FILTER (WHERE c.status = 'interested')::int                                AS leads,
          COUNT(*) FILTER (WHERE c.status = 'not_interested')::int                            AS not_interested,
          COALESCE(SUM(s.n), 0)::int                                                          AS sent
        FROM contacts c ${JOIN} ${WHERE}
      `, PARAMS),
    ]);

    // For campaign-filtered view or "all clients", use the direct query totals.
    // For a single workspace with no campaign filter, use the central stats store
    // so KPIs match Capacity/Health/Revenue.
    let t;
    if (campaignId || allClients) {
      t = totals.rows[0] || { total: 0, replied: 0, leads: 0, not_interested: 0, sent: 0 };
    } else {
      const central = await getWorkspaceStats(pgdb, workspaceId);
      t = central ? {
        total:          central.contacts_total || 0,
        replied:        central.replied_lifetime || 0,
        leads:          central.leads_lifetime || 0,
        not_interested: central.contacts_by_status?.not_interested || 0,
        sent:           central.sent_lifetime || 0,
      } : (totals.rows[0] || { total: 0, replied: 0, leads: 0, not_interested: 0, sent: 0 });
    }

    // Per-segment send counts: distribute the total send count
    // proportionally so each segment's LPT/RTL is meaningful.
    if (t.sent > 0 && t.total > 0) {
      const scaleSegments = (rows) => rows.map(r => ({
        ...r,
        sent: Math.round((r.total / t.total) * t.sent),
      }));
      industry.rows  = scaleSegments(industry.rows);
      size.rows      = scaleSegments(size.rows);
      city.rows      = scaleSegments(city.rows);
      county.rows    = scaleSegments(county.rows);
      seniority.rows = scaleSegments(seniority.rows);
    }

    res.json({
      workspace_id: workspaceId,
      totals: t,
      industry:  industry.rows,
      size:      size.rows,
      city:      city.rows,
      county:    county.rows,
      seniority: seniority.rows,
    });
  } catch (err) {
    console.error('[icp]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI Campaign Recommendations ──────────────────────────────────────────────
// Reads everything we know about a client — audience breakdowns, past campaign
// performance, captured subject/body templates of past winners — and either
// asks Claude API directly OR returns the assembled prompt for pasting into
// Claude.ai (uses your subscription quota instead of API credits).

// Shared prompt builder used by both endpoints below.
async function buildRecommendationPrompt(pgdb, workspaceId) {
  const client = db.prepare(
    `SELECT workspace_name, website, notes FROM clients WHERE workspace_id = ?`
  ).get(workspaceId);
  if (!client) throw new Error('Client not found');

  const SENT_CTE = `WITH sent_per_email AS (
    SELECT LOWER(lead_email) AS email, COUNT(*) AS n FROM email_events
    WHERE workspace_id = $1 AND event_type = 'sent' GROUP BY LOWER(lead_email)
  )`;
  const SEG = `COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE c.status = 'interested')::int     AS leads,
    COUNT(*) FILTER (WHERE c.status IN ('replied','interested','not_interested'))::int AS replied,
    COUNT(*) FILTER (WHERE c.status = 'not_interested')::int AS not_interested,
    COALESCE(SUM(s.n), 0)::int AS sent`;
  const J = `LEFT JOIN sent_per_email s ON s.email = LOWER(c.email)`;

  const [industry, city, county, size, seniority, totals] = await Promise.all([
    pgdb.query(`${SENT_CTE} SELECT COALESCE(NULLIF(TRIM(c.industry),''),'Unknown') AS segment, ${SEG} FROM contacts c ${J} WHERE c.workspace_id=$1 GROUP BY segment ORDER BY total DESC LIMIT 15`, [workspaceId]),
    pgdb.query(`${SENT_CTE} SELECT COALESCE(NULLIF(TRIM(c.city),''),NULLIF(TRIM(c.company_city),''),'Unknown') AS segment, ${SEG} FROM contacts c ${J} WHERE c.workspace_id=$1 GROUP BY segment ORDER BY total DESC LIMIT 15`, [workspaceId]),
    pgdb.query(`${SENT_CTE} SELECT COALESCE(NULLIF(TRIM(c.state),''),NULLIF(TRIM(c.company_state),''),'Unknown') AS segment, ${SEG} FROM contacts c ${J} WHERE c.workspace_id=$1 GROUP BY segment ORDER BY total DESC LIMIT 15`, [workspaceId]),
    pgdb.query(`${SENT_CTE} SELECT CASE WHEN c.num_employees IS NULL THEN 'Unknown' WHEN c.num_employees<10 THEN '1-9' WHEN c.num_employees<50 THEN '10-49' WHEN c.num_employees<200 THEN '50-199' WHEN c.num_employees<500 THEN '200-499' WHEN c.num_employees<1000 THEN '500-999' ELSE '1000+' END AS segment, ${SEG} FROM contacts c ${J} WHERE c.workspace_id=$1 GROUP BY segment`, [workspaceId]),
    pgdb.query(`${SENT_CTE} SELECT COALESCE(NULLIF(TRIM(c.seniority),''),'Unknown') AS segment, ${SEG} FROM contacts c ${J} WHERE c.workspace_id=$1 GROUP BY segment ORDER BY total DESC`, [workspaceId]),
    pgdb.query(`${SENT_CTE} SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE c.status='interested')::int AS leads, COUNT(*) FILTER (WHERE c.status IN ('replied','interested','not_interested'))::int AS replied, COALESCE(SUM(s.n),0)::int AS sent FROM contacts c ${J} WHERE c.workspace_id=$1`, [workspaceId]),
  ]);

  const t = totals.rows[0] || { total: 0, leads: 0, replied: 0, sent: 0 };
  await ensureCampaignCache();
  const wsCache = (campaignCache.workspaces || []).find(w => w.id === workspaceId);
  const pvTotalSent = wsCache?.totalSent || 0;
  if (pvTotalSent > t.sent) t.sent = pvTotalSent;

  const pastCampaigns = (wsCache?.campaigns || [])
    .filter(c => c.sent >= 200)
    .sort((a, b) => (b.leadRate || 0) - (a.leadRate || 0))
    .slice(0, 8);

  const campaignIds = pastCampaigns.map(c => c.id);
  let templates = [];
  if (campaignIds.length) {
    const r = await pgdb.query(
      `SELECT ct.campaign_id, ct.campaign_name, ct.step, ct.variant, t.subject, t.body_excerpt
         FROM campaign_templates ct
         JOIN templates t ON t.content_hash = ct.content_hash
        WHERE ct.workspace_id = $1 AND ct.campaign_id = ANY($2::text[]) AND ct.active = TRUE
        ORDER BY ct.step, ct.variant`,
      [workspaceId, campaignIds]
    );
    templates = r.rows;
  }

  const fmtSeg = (rows, label) => {
    const top = rows.rows.slice(0, 10).map(r => {
      const replyRate = r.total > 0 ? (r.replied / r.total * 100).toFixed(1) : '0';
      const lpt = r.sent > 0 ? (r.leads * 1000 / r.sent).toFixed(1) : 'n/a';
      return `  - ${r.segment}: ${r.total} contacts, ${r.leads} leads, ${replyRate}% reply, LPT=${lpt}`;
    }).join('\n');
    return `${label}:\n${top}`;
  };

  const campaignBlock = pastCampaigns.map(c => {
    const tpls = templates.filter(tp => tp.campaign_id === c.id);
    const tplStr = tpls.map(tp => `    Step ${tp.step}${tp.variant}: "${tp.subject}" — ${(tp.body_excerpt || '').slice(0, 140)}`).join('\n');
    return `- ${c.name} (${c.status}): sent=${c.sent}, replies=${c.replies}, leads=${c.leads}, leadRate=${(c.leadRate * 100).toFixed(2)}%, replyRate=${(c.replyRate * 100).toFixed(2)}%\n${tplStr || '    (no templates captured)'}`;
  }).join('\n\n');

  const userPrompt = `Client: ${client.workspace_name}
Website: ${client.website || 'unknown'}
Notes: ${client.notes || 'none'}

Overall: ${t.total} contacts, ${t.sent} emails sent, ${t.leads} delivered leads, ${t.replied} total replies, overall reply rate ${t.total > 0 ? (t.replied/t.total*100).toFixed(2) : 0}%

AUDIENCE BREAKDOWNS (where leads come from):
${fmtSeg(industry, 'Industry')}

${fmtSeg(city, 'City')}

${fmtSeg(county, 'County/State')}

${fmtSeg(size, 'Company Size')}

${fmtSeg(seniority, 'Seniority')}

PAST CAMPAIGNS (top 8 by lead rate):
${campaignBlock || '(no past campaigns with significant volume)'}

Generate 2-3 specific, data-backed recommendations. Each must:
1. Cite specific numbers from the data above
2. Pick a TARGET segment combination (e.g. "Construction firms in Yorkshire, 50-199 employees")
3. Recommend an 80/20 split: which existing campaign to keep at 80%, what NEW angle to test at 20%
4. Suggest 3-5 NEW subject lines and 2-3 opening line variants for the test angle, in the same style/voice as past winners
5. Give confidence level (high/medium/low) and call out missing data

Return ONLY this JSON shape, no prose:
{
  "summary": "1-2 sentence overall read on the client",
  "recommendations": [
    {
      "title": "short headline",
      "target": "specific segment description",
      "rationale": "why this segment, citing specific numbers from above",
      "split_80_winner": { "campaign_name": "...", "reason": "..." },
      "split_20_test": {
        "angle": "positioning angle in one sentence",
        "subject_lines": ["...", "...", "..."],
        "opening_lines": ["...", "..."]
      },
      "confidence": "high|medium|low",
      "data_gaps": "what data would make this more confident"
    }
  ]
}`;

  const systemPrompt = 'You are a B2B cold-email strategist analyzing campaign performance data for an outbound agency. You output precise, data-backed recommendations as JSON. Never invent numbers — only cite what is in the data provided.';

  return { client, systemPrompt, userPrompt, pastCampaignCount: pastCampaigns.length, templateCount: templates.length };
}

// Calls Claude API → returns parsed recommendations (uses API credits).
app.get('/api/audience/recommendations/:workspaceId', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI service not configured' });
  const { workspaceId } = req.params;

  try {
    const { client, systemPrompt, userPrompt, pastCampaignCount, templateCount } =
      await buildRecommendationPrompt(pgdb, workspaceId);

    console.log(`[recommendations] ws=${workspaceId} client=${client.workspace_name} prompt_len=${userPrompt.length} past_campaigns=${pastCampaignCount} templates=${templateCount}`);

    if (process.env.DISABLE_AI_FEATURES === '1') return res.status(503).json({ error: 'AI features temporarily disabled' });
    const rawText = await callClaude({ system: systemPrompt, user: userPrompt, maxTokens: 4000, expectJson: false });
    if (!rawText) return res.status(502).json({ error: 'Claude API call failed — check ANTHROPIC_API_KEY and server logs' });

    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let result;
    try { result = JSON.parse(cleaned); }
    catch (e) {
      console.warn(`[recommendations] ws=${workspaceId} JSON parse failed:`, e.message);
      console.warn('[recommendations] raw response (first 500 chars):', cleaned.slice(0, 500));
      return res.status(502).json({ error: `Claude returned non-JSON response: ${cleaned.slice(0, 200)}` });
    }
    if (!result || !Array.isArray(result.recommendations)) {
      console.warn('[recommendations] bad shape:', JSON.stringify(result).slice(0, 300));
      return res.status(502).json({ error: 'Claude returned unexpected response shape' });
    }

    res.json({
      ok: true,
      workspace_id: workspaceId,
      workspace_name: client.workspace_name,
      generated_at: new Date().toISOString(),
      ...result,
    });
  } catch (err) {
    console.error('[recommendations]', err.message);
    res.status(err.message === 'Client not found' ? 404 : 500).json({ error: err.message });
  }
});

// ── Infrastructure Capacity ─────────────────────────────────────────────────
// Reads from the central workspace_stats table so every page agrees.
app.get('/api/capacity', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    let allStats = await getAllWorkspaceStats(pgdb);

    // If cache is empty (fresh deploy, before first cron) OR every row is
    // stale (>20 min old), trigger a synchronous refresh so the user sees
    // current numbers instead of "wait for more data".
    const STALE_MS = 20 * 60 * 1000;
    const cacheEmpty = allStats.length === 0;
    const allStale = !cacheEmpty && allStats.every(s =>
      !s.computed_at || (Date.now() - new Date(s.computed_at).getTime()) > STALE_MS
    );
    if (cacheEmpty || allStale) {
      console.log(`[capacity] stats ${cacheEmpty ? 'empty' : 'stale'} — refreshing inline before responding`);
      await refreshAllWorkspaceStats();
      allStats = await getAllWorkspaceStats(pgdb);
    }

    const rows = allStats.map(s => {
      const mailboxCount = s.mailbox_count || 0;
      const lpt = s.lpt_lifetime || s.lpt_90d;
      const lptSource = s.lpt_lifetime ? 'lifetime' : (s.lpt_90d ? '90d' : null);
      const target = s.lead_target_monthly || 0;
      const actualLeads = s.leads_monthly_avg_3mo || 0;
      const actualSends = s.sent_monthly_avg_3mo || 0;
      const capacitySends = s.mailbox_monthly_capacity || 0;

      // The key question: IF this client ran at full mailbox capacity at
      // their current LPT, would they hit target?
      const projectedLeadsAtFullCapacity = lpt != null ? (capacitySends * lpt / 1000) : null;
      const onPace = target > 0 && actualLeads >= target * 0.85; // 85%+ = hitting target
      const utilisation = capacitySends > 0 ? actualSends / capacitySends : 0;

      let verdict, action, displayGap;
      if (!target) {
        verdict = 'no_target';
        action = 'Set a monthly lead target in Admin to enable capacity planning.';
        displayGap = null;
      } else if (lpt == null) {
        verdict = 'insufficient_data';
        action = mailboxCount === 0
          ? 'No mailboxes attributed to this workspace yet.'
          : `Need 1+ delivered lead and 1,000+ sends to compute LPT. Currently: ${s.leads_lifetime || 0} leads, ${s.sent_lifetime || 0} sends.`;
        displayGap = null;
      } else if (onPace && actualLeads >= target * 1.5) {
        // Client is EXCEEDING target by 50%+. Their real conversion rate is
        // clearly better than lifetime LPT — gap calc against lifetime LPT
        // is meaningless. Show them as on-track regardless of theoretical math.
        verdict = 'ok';
        const excessLeads = actualLeads - target;
        action = `Exceeding target — ${actualLeads.toFixed(1)}/${target} leads/mo (+${excessLeads.toFixed(1)} above target). Actual performance is better than lifetime LPT (${lpt.toFixed(2)}) would suggest.`;
        displayGap = 0;
      } else if (projectedLeadsAtFullCapacity < target) {
        // Even at full mailbox utilisation, current LPT won't deliver target.
        // The only fixes are: add mailboxes, improve LPT, or lower target.
        verdict = 'under';
        const sendsShortfall      = s.required_monthly_sends - capacitySends;
        const mailboxesToAdd      = Math.ceil(sendsShortfall / (30 * 21));
        const lptNeededAtCapacity = (target * 1000 / capacitySends).toFixed(2);
        action = onPace
          ? `Margin is thin — capacity (${capacitySends.toLocaleString()}/mo) only barely supports ${target} leads/mo at ${lptSource} LPT ${lpt.toFixed(2)}. To make headroom: add ~${mailboxesToAdd} mailbox${mailboxesToAdd > 1 ? 'es' : ''}, or improve LPT to ${lptNeededAtCapacity}.`
          : `Behind target — ${actualLeads.toFixed(1)}/${target} leads/mo. Even at FULL capacity (${capacitySends.toLocaleString()}/mo) at ${lptSource} LPT ${lpt.toFixed(2)} you'd only get ${projectedLeadsAtFullCapacity.toFixed(1)} leads/mo. Options: add ~${mailboxesToAdd} mailbox${mailboxesToAdd > 1 ? 'es' : ''}, or raise LPT to ${lptNeededAtCapacity} (higher reply rate / better copy / tighter audience), or lower target.`;
      } else if (!onPace) {
        // Capacity is enough — we'd hit target at full blast, but we're not
        // sending enough. Under-utilisation problem.
        verdict = 'under_utilised';
        const sendsToHitTarget = Math.round(s.required_monthly_sends);
        action = `Behind target — ${actualLeads.toFixed(1)}/${target} leads/mo. Capacity is enough (${capacitySends.toLocaleString()}/mo available could deliver ${projectedLeadsAtFullCapacity.toFixed(1)} leads/mo at ${lptSource} LPT ${lpt.toFixed(2)}). Currently only sending ${actualSends.toLocaleString()}/mo (${(utilisation*100).toFixed(0)}% utilisation) — need ${sendsToHitTarget.toLocaleString()}/mo. Check paused campaigns / mailbox status.`;
      } else if (capacitySends > s.required_monthly_sends * 1.5) {
        // Hitting target AND have lots of headroom — could reduce mailboxes.
        verdict = 'over';
        const excessSends   = capacitySends - s.required_monthly_sends;
        const excessMailbox = Math.floor(excessSends / (30 * 21));
        action = `Hitting target (${actualLeads.toFixed(1)}/${target} leads/mo) with ${excessSends.toLocaleString()}/mo headroom — could reduce by ~${excessMailbox} mailbox${excessMailbox > 1 ? 'es' : ''} or raise the target.`;
      } else {
        // Hitting target with reasonable infrastructure.
        verdict = 'ok';
        action = `On track — ${actualLeads.toFixed(1)}/${target} leads/mo from ${actualSends.toLocaleString()}/mo of ${capacitySends.toLocaleString()}/mo capacity (${(utilisation*100).toFixed(0)}% utilisation, ${lptSource} LPT ${lpt.toFixed(2)}).`;
      }

      return {
        workspace_id: s.workspace_id,
        workspace_name: s.workspace_name,
        client_status: s.client_status,
        lead_target_monthly: s.lead_target_monthly,
        current_mailboxes: mailboxCount,
        current_domains: s.domain_count,
        monthly_leads: s.leads_monthly_avg_3mo,
        monthly_sends: s.sent_monthly_avg_3mo,
        lpt,
        required_monthly_sends: s.required_monthly_sends,
        required_mailboxes: s.required_mailboxes,
        mailbox_gap: s.mailbox_gap,
        mailbox_monthly_capacity: s.mailbox_monthly_capacity,
        avg_daily_per_mailbox: s.avg_daily_per_mailbox,
        verdict, action,
      };
    });

    res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      assumptions: {
        working_days_per_month: 21,
        window_days: 90,
        note: 'Per-client monthly capacity = sum of each mailbox\'s actual PlusVibe daily_limit × 21 working days.',
      },
      clients: rows,
    });
  } catch (err) {
    console.error('[capacity]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Run domain-consensus backfill only (no PlusVibe walk) — fast way to
// reduce 'Unknown' rows on the Audience page without waiting 5+ min for
// a full Refresh All. POST with no body = all workspaces; with workspace_id
// body = single workspace.
app.post('/api/audience/backfill-domains', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const { workspace_id } = req.body || {};
    if (workspace_id) {
      const r = await backfillContactFieldsByDomain(pgdb, workspace_id);
      return res.json({ ok: true, workspace_id, ...r });
    }
    const clients = db.prepare(
      `SELECT workspace_id, workspace_name FROM clients WHERE workspace_id IS NOT NULL AND workspace_id != '' ORDER BY workspace_name`
    ).all();
    const results = [];
    for (const c of clients) {
      const r = await backfillContactFieldsByDomain(pgdb, c.workspace_id);
      results.push({ name: c.workspace_name, workspace_id: c.workspace_id, ...r });
    }
    res.json({ ok: true, clients: results.length, results });
  } catch (err) {
    console.error('[domain-backfill] endpoint failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Backfill num_employees from PlusVibe lead enrichment data.
// Fetches all leads for every workspace (bypassing the skipFullPull optimisation)
// and writes num_employees where PlusVibe has it.  Then runs domain-consensus
// to spread known values to same-domain contacts that still have NULL.
app.post('/api/audience/backfill-employee-size', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const clients = db.prepare(
      `SELECT workspace_id, workspace_name FROM clients WHERE workspace_id IS NOT NULL AND workspace_id != '' ORDER BY workspace_name`
    ).all();

    let totalUpdated = 0;
    const results = [];

    for (const c of clients) {
      const wsId = c.workspace_id;
      let wsUpdated = 0;

      // Step 1 — reliable: backfill from the Apollo data already in our DB.
      // num_employees is only parsed at import time; older rows kept NULL even
      // though raw_data->>'# Employees' holds the value. Strip commas, take the
      // leading integer (lower bound of any range), matching csv-importer.
      let rawUpdated = 0;
      try {
        const rawR = await pgdb.query(`
          UPDATE contacts
          SET num_employees = NULLIF(regexp_replace(regexp_replace(
                COALESCE(raw_data->>'# Employees', raw_data->>'Employees',
                         raw_data->>'Company Size', raw_data->>'num_employees'),
                ',', '', 'g'), '[^0-9].*$', ''), '')::int,
              updated_at = NOW()
          WHERE workspace_id = $1
            AND num_employees IS NULL
            AND COALESCE(raw_data->>'# Employees', raw_data->>'Employees',
                         raw_data->>'Company Size', raw_data->>'num_employees') ~ '[0-9]'
        `, [wsId]);
        rawUpdated = rawR.rowCount || 0;
      } catch (err) { console.warn(`[backfill-employee-size] raw_data step failed for ${wsId}:`, err.message); }

      // Step 2 — supplement from PlusVibe for rows still NULL. PlusVibe stores
      // the Apollo employee count as custom__employees (double underscore, in
      // lead_data), NOT num_employees — reading the latter always missed it.
      const leadMap = new Map();
      for (let page = 1; page <= 500; page++) {
        let batch;
        try {
          batch = await bisonWorkspaceLeads(wsId, { page, perPage: 100 });
        } catch { break; }
        if (!batch.length) break;
        for (const l of batch) {
          if (!l.email) continue;
          const ld = l.lead_data || l;
          const numEmp = parseInt(
            l.num_employees || l.numEmployees || l.company_size || l.estimated_num_employees
            || ld.custom__employees || ld.custom_employees
            || ld['# Employees'] || ld.Employees, 10
          );
          if (Number.isFinite(numEmp) && numEmp > 0) {
            leadMap.set(l.email.toLowerCase().trim(), numEmp);
          }
        }
        if (batch.length < 100) break;
      }

      if (leadMap.size) {
        const emails = [...leadMap.keys()];
        const counts = [...leadMap.values()];
        const r = await pgdb.query(`
          UPDATE contacts
          SET num_employees = t.num_employees, updated_at = CURRENT_TIMESTAMP
          FROM UNNEST($1::text[], $2::int[]) AS t(email, num_employees)
          WHERE contacts.workspace_id = $3
            AND lower(contacts.email) = lower(t.email)
            AND contacts.num_employees IS NULL
        `, [emails, counts, wsId]);
        wsUpdated = r.rowCount || 0;
      }
      // Spread to same-domain contacts that still have NULL
      const domainR = await backfillContactFieldsByDomain(pgdb, wsId);
      const domainUpdated = domainR?.totals?.num_employees || 0;
      totalUpdated += rawUpdated + wsUpdated + domainUpdated;
      results.push({ name: c.workspace_name, fromRaw: rawUpdated, fromPV: wsUpdated, fromDomain: domainUpdated });
    }

    res.json({ ok: true, totalUpdated, results });
  } catch (err) {
    console.error('[backfill-employee-size]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Returns the assembled prompt as plain text for copy-paste into Claude.ai —
// no API call, uses your subscription quota instead.
app.get('/api/audience/recommendations/:workspaceId/prompt', requireSession, async (req, res) => {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  const { workspaceId } = req.params;

  try {
    const { client, systemPrompt, userPrompt } = await buildRecommendationPrompt(pgdb, workspaceId);
    // Combine system + user into one paste-ready block (Claude.ai web UI has no system field).
    const combined = `${systemPrompt}\n\n---\n\n${userPrompt}`;
    res.json({
      ok: true,
      workspace_id: workspaceId,
      workspace_name: client.workspace_name,
      prompt: combined,
      char_count: combined.length,
    });
  } catch (err) {
    console.error('[recommendations/prompt]', err.message);
    res.status(err.message === 'Client not found' ? 404 : 500).json({ error: err.message });
  }
});

// ── Default commission rate setting ──────────────────────────────────────
app.get('/api/admin/default-commission', requireSession, (req, res) => {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = 'default_commission_rate'").get();
  res.json({ rate: row ? parseFloat(row.value) : 5 });
});

app.post('/api/admin/default-commission', requireAdmin, (req, res) => {
  const rate = parseFloat(req.body?.rate ?? 5);
  db.prepare("INSERT INTO app_meta (key, value) VALUES ('default_commission_rate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(rate));
  // Recalculate all existing client assignments with new default rate
  const clients = db.prepare('SELECT DISTINCT client_workspace_id FROM client_managers').all();
  clients.forEach(c => recalcSplitRates(c.client_workspace_id));
  res.json({ ok: true, rate });
});

// ── CM "My Clients" filter ────────────────────────────────────────────────
app.get('/api/my-clients', requireSession, (req, res) => {
  const s = decodeSession(req);
  const managerName = s?.name || '';
  if (!managerName) return res.json({ manager: '', clients: [] });
  const rows = db.prepare(`
    SELECT c.workspace_id, c.workspace_name
    FROM client_managers cm
    JOIN clients c ON c.workspace_id = cm.client_workspace_id
    WHERE cm.manager_name = ?
    ORDER BY c.workspace_name
  `).all(managerName);
  res.json({ manager: managerName, clients: rows });
});

app.get('/api/admin/workload/cm-stats', requireSession, async (req, res) => {
  const managers = db.prepare('SELECT name FROM managers ORDER BY name').all().map(m => m.name);
  const assignments = db.prepare('SELECT client_workspace_id, manager_name FROM client_managers').all();

  // Period: default to current month
  const now = new Date();
  const start = req.query.start || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const end   = req.query.end   || new Date().toISOString().slice(0,10);

  const byManager = {};
  managers.forEach(m => { byManager[m] = []; });
  assignments.forEach(a => {
    if (byManager[a.manager_name]) byManager[a.manager_name].push(a.client_workspace_id);
  });

  // Sum each CM's assigned workspaces using the SAME source as the Stats page,
  // so a CM's totals equal the sum of their clients' Stats-page numbers.
  const stats = {};
  for (const [manager, wsIds] of Object.entries(byManager)) {
    if (!wsIds.length) { stats[manager] = { clients: 0, sent: 0, replies: 0, reply_rate: '—', bounced: 0, leads: 0, ltl: '—' }; continue; }
    const wsStats = computeWorkspaceStatsForRange(wsIds, start, end);
    let sent = 0, replies = 0, bounced = 0, leads = 0;
    for (const wsId of wsIds) {
      const t = wsStats[wsId]?.totals;
      if (!t) continue;
      sent    += t.sent;
      replies += t.replies;
      bounced += t.bounces;
      leads   += t.leads;
    }
    stats[manager] = {
      clients:    wsIds.length,
      sent, replies,
      reply_rate: sent ? ((replies / sent) * 100).toFixed(1) : '—',
      bounced,
      leads,
      ltl: replies ? ((leads / replies) * 100).toFixed(1) : '—',
    };
  }
  res.json({ stats, start, end });
});

// ── CM Workload ───────────────────────────────────────────────────────────

app.post('/api/admin/workload/recalc', requireAdmin, (req, res) => {
  const clients = db.prepare('SELECT DISTINCT client_workspace_id FROM client_managers').all();
  clients.forEach(c => recalcSplitRates(c.client_workspace_id));
  res.json({ ok: true, recalculated: clients.length });
});

app.get('/api/admin/workload', requireSession, (req, res) => {
  const s = decodeSession(req);
  const managers = db.prepare('SELECT id, name, commission_rate FROM managers ORDER BY name').all();
  const clients  = db.prepare('SELECT workspace_id, workspace_name, price_per_lead, client_status, manager_start_date FROM clients ORDER BY workspace_name').all();
  const assignments = db.prepare('SELECT client_workspace_id, manager_name, commission_rate FROM client_managers').all();
  const defaultRateRow = db.prepare("SELECT value FROM app_meta WHERE key = 'default_commission_rate'").get();
  const defaultRate = defaultRateRow ? parseFloat(defaultRateRow.value) : 5;

  // Auto-calculate split rates: for each client count how many CMs assigned
  const cmCountPerClient = {};
  assignments.forEach(a => { cmCountPerClient[a.client_workspace_id] = (cmCountPerClient[a.client_workspace_id] || 0) + 1; });
  const assignmentsWithSplit = assignments.map(a => ({
    ...a,
    commission_rate: a.commission_rate || (defaultRate / (cmCountPerClient[a.client_workspace_id] || 1)),
    split_count: cmCountPerClient[a.client_workspace_id] || 1,
  }));

  res.json({ managers, clients, assignments: assignmentsWithSplit, defaultRate, currentManager: s?.name || null, role: s?.role || 'manager' });
});

function recalcSplitRates(client_workspace_id) {
  const defaultRateRow = db.prepare("SELECT value FROM app_meta WHERE key = 'default_commission_rate'").get();
  const defaultRate = defaultRateRow ? parseFloat(defaultRateRow.value) : 5;
  const cms = db.prepare('SELECT manager_name FROM client_managers WHERE client_workspace_id = ?').all(client_workspace_id);
  const splitRate = cms.length ? defaultRate / cms.length : defaultRate;
  db.prepare('UPDATE client_managers SET commission_rate = ? WHERE client_workspace_id = ?').run(splitRate, client_workspace_id);
}

app.post('/api/admin/workload/assign', requireAdmin, (req, res) => {
  const { client_workspace_id, manager_name } = req.body || {};
  if (!client_workspace_id || !manager_name) return res.status(400).json({ error: 'client_workspace_id and manager_name required' });
  db.prepare(`INSERT OR IGNORE INTO client_managers (client_workspace_id, manager_name, commission_rate) VALUES (?, ?, 0)`)
    .run(client_workspace_id, manager_name);
  recalcSplitRates(client_workspace_id);
  const splitRate = db.prepare('SELECT commission_rate FROM client_managers WHERE client_workspace_id = ? AND manager_name = ?').get(client_workspace_id, manager_name)?.commission_rate ?? 0;
  res.json({ ok: true, commission_rate: splitRate });
});

app.delete('/api/admin/workload/assign', requireAdmin, (req, res) => {
  const { client_workspace_id, manager_name } = req.body || {};
  if (!client_workspace_id || !manager_name) return res.status(400).json({ error: 'client_workspace_id and manager_name required' });
  db.prepare('DELETE FROM client_managers WHERE client_workspace_id = ? AND manager_name = ?').run(client_workspace_id, manager_name);
  recalcSplitRates(client_workspace_id);
  res.json({ ok: true });
});

// Remove manual commission override — rates are always auto-calculated
app.put('/api/admin/workload/commission', requireAdmin, (req, res) => {
  const { client_workspace_id } = req.body || {};
  if (client_workspace_id) recalcSplitRates(client_workspace_id);
  res.json({ ok: true });
});

app.get('/api/admin/clients', requireSession, async (req, res) => {
  try {
    const clients = db.prepare(
      'SELECT id, username, workspace_id, workspace_name, plan_leads, price_per_lead, stripe_customer_id, contact_name, contact_email, contact_phone, website, notes, client_status, restart_date, campaign_manager, campaign_manager_2, commission_rate, manager_start_date, lead_target_monthly, created_at FROM clients ORDER BY created_at DESC'
    ).all();
    const pgDb = req.app.locals.pgDb;
    if (pgDb) {
      const { rows } = await pgDb.query('SELECT workspace_id, notes FROM client_notes');
      const pgNotes = Object.fromEntries(rows.map(r => [r.workspace_id, r.notes]));
      for (const c of clients) {
        if (pgNotes[c.workspace_id] !== undefined) c.notes = pgNotes[c.workspace_id];
      }
    }
    res.json(clients);
  } catch (err) {
    console.error('[clients] GET error:', err.message);
    res.json(db.prepare(
      'SELECT id, username, workspace_id, workspace_name, plan_leads, price_per_lead, stripe_customer_id, contact_name, contact_email, contact_phone, website, notes, client_status, restart_date, campaign_manager, campaign_manager_2, commission_rate, manager_start_date, lead_target_monthly, created_at FROM clients ORDER BY created_at DESC'
    ).all());
  }
});

app.post('/api/admin/clients', requireAdmin, (req, res) => {
  const { username, password, workspace_id, workspace_name, plan_leads, price_per_lead,
          contact_name, contact_email, contact_phone, website, notes, lead_target_monthly } = req.body || {};
  if (!username || !password || !workspace_id || !workspace_name)
    return res.status(400).json({ error: 'All fields required' });
  try {
    db.prepare(
      'INSERT INTO clients (username, password_hash, workspace_id, workspace_name, plan_leads, price_per_lead, contact_name, contact_email, contact_phone, website, notes, lead_target_monthly) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(username, bcrypt.hashSync(password, 10), workspace_id, workspace_name,
         parseInt(plan_leads) || 0, parseFloat(price_per_lead) || 0,
         contact_name || '', contact_email || '', contact_phone || '', website || '', notes || '',
         parseInt(lead_target_monthly) || 0);
    res.json({ ok: true });
  } catch (err) {
    // A UNIQUE violation on username is the common case; surface anything else
    // so a real failure (missing column, bad type) isn't masked as a dup.
    const dup = /UNIQUE|unique|duplicate/.test(err.message || '');
    console.error('[add-client] insert failed:', err.message);
    res.status(400).json({ error: dup ? 'Username already exists' : ('Could not create client: ' + err.message) });
  }
});

app.put('/api/admin/clients/:id', requireAdmin, (req, res) => {
  const { plan_leads, price_per_lead, contact_name, contact_email, contact_phone, website, notes, client_status, restart_date } = req.body || {};
  const updates = [];
  const vals = [];
  if (plan_leads     !== undefined) { updates.push('plan_leads = ?');     vals.push(parseInt(plan_leads) || 0); }
  if (price_per_lead !== undefined) { updates.push('price_per_lead = ?'); vals.push(parseFloat(price_per_lead) || 0); }
  if (contact_name   !== undefined) { updates.push('contact_name = ?');   vals.push(contact_name); }
  if (contact_email  !== undefined) { updates.push('contact_email = ?');  vals.push(contact_email); }
  if (contact_phone  !== undefined) { updates.push('contact_phone = ?');  vals.push(contact_phone); }
  if (website        !== undefined) { updates.push('website = ?');        vals.push(website); }
  if (notes          !== undefined) { updates.push('notes = ?');          vals.push(notes); }
  if (client_status    !== undefined) { updates.push('client_status = ?');    vals.push(client_status); }
  if (restart_date     !== undefined) { updates.push('restart_date = ?');     vals.push(restart_date || null); }
  if (req.body.campaign_manager   !== undefined) { updates.push('campaign_manager = ?');    vals.push(req.body.campaign_manager); }
  if (req.body.campaign_manager_2 !== undefined) { updates.push('campaign_manager_2 = ?'); vals.push(req.body.campaign_manager_2); }
  if (req.body.commission_rate    !== undefined) { updates.push('commission_rate = ?');    vals.push(parseFloat(req.body.commission_rate) || 15); }
  if (req.body.manager_start_date !== undefined) { updates.push('manager_start_date = ?'); vals.push(req.body.manager_start_date || null); }
  if (req.body.lead_target_monthly !== undefined) { updates.push('lead_target_monthly = ?'); vals.push(parseInt(req.body.lead_target_monthly) || 0); }
  if (updates.length)
    db.prepare(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
  if (notes !== undefined) {
    const row = db.prepare('SELECT workspace_id FROM clients WHERE id = ?').get(req.params.id);
    if (row?.workspace_id) {
      req.app.locals.pgDb?.query(
        `INSERT INTO client_notes (workspace_id, notes, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (workspace_id) DO UPDATE SET notes = EXCLUDED.notes, updated_at = NOW()`,
        [row.workspace_id, notes]
      ).catch(err => console.error('[client notes] Postgres save failed:', err.message));
    }
  }
  res.json({ ok: true });
});

app.put('/api/admin/clients/:id/password', requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  db.prepare('UPDATE clients SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/clients/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Admin — Apollo → Verify → PlusVibe automation ─────────
const automationRuns = new Map();
let automationBrowserProcess = null;
let automationBrowserLog = '';
try { fs.mkdirSync(AUTOMATION_RUN_DIR, { recursive: true }); } catch {}

function automationPublicRun(run) {
  return {
    id: run.id,
    status: run.status,
    apollo_url: run.apollo_url,
    workspace_id: run.workspace_id,
    workspace_name: run.workspace_name,
    created_at: run.created_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    exit_code: run.exit_code,
    error: run.error,
    log_tail: run.log_tail,
  };
}

function appendRunLog(run, chunk) {
  const text = String(chunk || '');
  run.log_tail = `${run.log_tail || ''}${text}`.split('\n').slice(-80).join('\n');
  try { fs.appendFileSync(run.server_log_path, text); } catch {}
}

app.get('/api/admin/automation/runs', requireAdmin, (req, res) => {
  res.json(Array.from(automationRuns.values()).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(automationPublicRun));
});

app.get('/api/admin/automation/runs/:id', requireAdmin, (req, res) => {
  const run = automationRuns.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(automationPublicRun(run));
});

function automationBrowserUrl(req) {
  return '/automation-browser/vnc.html?autoconnect=true&resize=scale&path=automation-browser/websockify';
}

function stripAutomationBrowserPrefix(url = '/') {
  return url.replace(/^\/automation-browser(?=\/|$)/, '') || '/';
}

function proxyAutomationBrowser(req, res) {
  const targetPath = stripAutomationBrowserPrefix(req.originalUrl || req.url);
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: Number(AUTOMATION_NOVNC_PORT),
    method: req.method,
    path: targetPath,
    headers: { ...req.headers, host: `127.0.0.1:${AUTOMATION_NOVNC_PORT}` },
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    res.status(502).send('Automation browser is not ready yet. Click Start Browser, wait 10 seconds, then open it again.');
  });
  req.pipe(proxyReq);
}

function automationBrowserStatus(req) {
  return {
    running: !!automationBrowserProcess,
    pid: automationBrowserProcess?.pid || null,
    url: automationBrowserUrl(req),
    log_tail: automationBrowserLog.split('\n').slice(-60).join('\n'),
  };
}

function appendAutomationBrowserLog(chunk) {
  automationBrowserLog = `${automationBrowserLog}${String(chunk || '')}`.split('\n').slice(-120).join('\n');
}

app.get('/api/admin/automation/browser/status', requireAdmin, (req, res) => {
  res.json(automationBrowserStatus(req));
});

app.use('/automation-browser', requireAdmin, proxyAutomationBrowser);

app.post('/api/admin/automation/browser/start', requireAdmin, (req, res) => {
  if (automationBrowserProcess) return res.json(automationBrowserStatus(req));
  automationBrowserLog = '';
  const child = spawn(process.execPath, [path.join(__dirname, 'automation-browser.js')], {
    cwd: __dirname,
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  automationBrowserProcess = child;
  appendAutomationBrowserLog(`[server] Started automation browser ${child.pid}\n`);
  child.stdout.on('data', appendAutomationBrowserLog);
  child.stderr.on('data', appendAutomationBrowserLog);
  child.on('close', code => {
    appendAutomationBrowserLog(`[server] Automation browser exited with code ${code}\n`);
    if (automationBrowserProcess === child) automationBrowserProcess = null;
  });
  child.on('error', err => {
    appendAutomationBrowserLog(`[server] Automation browser error: ${err.message}\n`);
    if (automationBrowserProcess === child) automationBrowserProcess = null;
  });
  res.json(automationBrowserStatus(req));
});

app.post('/api/admin/automation/browser/stop', requireAdmin, (req, res) => {
  if (automationBrowserProcess) {
    try { process.kill(-automationBrowserProcess.pid, 'SIGTERM'); }
    catch { automationBrowserProcess.kill('SIGTERM'); }
  }
  res.json({ ok: true });
});

app.post('/api/admin/automation/run', requireAdmin, (req, res) => {
  const { apollo_url, client_id, workspace_id, workspace_name, dry_run } = req.body || {};
  if (!apollo_url || !/^https:\/\/app\.apollo\.io\//.test(apollo_url)) {
    return res.status(400).json({ error: 'A valid Apollo URL is required' });
  }

  let client = null;
  if (client_id) client = db.prepare('SELECT id, workspace_id, workspace_name FROM clients WHERE id = ?').get(client_id);
  if (!client && workspace_id) client = db.prepare('SELECT id, workspace_id, workspace_name FROM clients WHERE workspace_id = ?').get(workspace_id);
  const wsId = client?.workspace_id || workspace_id;
  const wsName = client?.workspace_name || workspace_name || wsId;
  if (!wsId) return res.status(400).json({ error: 'Choose a client or provide a workspace id' });

  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const run = {
    id,
    status: 'queued',
    apollo_url,
    workspace_id: wsId,
    workspace_name: wsName,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    exit_code: null,
    error: '',
    log_tail: '',
    server_log_path: path.join(AUTOMATION_RUN_DIR, `${id}.server.log`),
  };
  automationRuns.set(id, run);

  const args = [
    path.join(__dirname, 'simple-pipeline.js'),
    '--url', apollo_url,
    '--workspace-id', wsId,
    '--workspace-name', wsName,
  ];
  if (dry_run) args.push('--dry-run');

  run.status = 'running';
  run.started_at = new Date().toISOString();
  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  run.pid = child.pid;
  appendRunLog(run, `[server] Started automation process ${child.pid}\n`);

  child.stdout.on('data', chunk => appendRunLog(run, chunk));
  child.stderr.on('data', chunk => appendRunLog(run, chunk));
  child.on('error', err => {
    run.status = 'failed';
    run.error = err.message;
    run.finished_at = new Date().toISOString();
    appendRunLog(run, `[server] Failed to start: ${err.message}\n`);
  });
  child.on('close', code => {
    run.exit_code = code;
    run.status = code === 0 ? 'completed' : 'failed';
    run.finished_at = new Date().toISOString();
    if (code !== 0 && !run.error) run.error = `Automation exited with code ${code}`;
    appendRunLog(run, `[server] Automation ${run.status} with exit code ${code}\n`);
  });

  res.json(automationPublicRun(run));
});

// ── Admin — non-lead requests ──────────────────────────────
app.get('/api/admin/nonlead-requests', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT nlr.id, nlr.lead_id, nlr.client_id, nlr.reason, nlr.created_at,
           c.username, c.workspace_name, l.data as lead_data
    FROM nonlead_requests nlr
    JOIN clients c ON c.id = nlr.client_id
    LEFT JOIN leads l ON l.id = nlr.lead_id
    WHERE nlr.status = 'pending'
    ORDER BY nlr.created_at DESC
  `).all();
  res.json(rows.map(r => {
    const lead = r.lead_data ? JSON.parse(r.lead_data) : {};
    return {
      id:             r.id,
      lead_id:        r.lead_id,
      client_id:      r.client_id,
      username:       r.username,
      workspace_name: r.workspace_name,
      reason:         r.reason,
      created_at:     r.created_at,
      lead_name:      `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      lead_email:     lead.email || '',
    };
  }));
});

app.post('/api/admin/nonlead-requests/:id/approve', requireAdmin, async (req, res) => {
  const nlr = db.prepare('SELECT * FROM nonlead_requests WHERE id = ?').get(req.params.id);
  if (!nlr) return res.status(404).json({ error: 'Request not found' });
  const leadRow  = db.prepare('SELECT data FROM leads WHERE id = ?').get(nlr.lead_id);
  const leadData = leadRow ? JSON.parse(leadRow.data) : {};
  db.prepare(`UPDATE leads SET status = 'nonlead' WHERE id = ?`).run(nlr.lead_id);
  db.prepare(`UPDATE nonlead_requests SET status = 'approved' WHERE id = ?`).run(nlr.id);
  try {
    await fetch(NONLEAD_WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:        leadData.email || '',
        reason:       nlr.reason,
        timestamp:    new Date().toISOString(),
        lead_id:      nlr.lead_id,
        workspace_id: nlr.workspace_id,
      })
    });
  } catch {}
  res.json({ ok: true });
});

app.post('/api/admin/nonlead-requests/:id/reject', requireAdmin, (req, res) => {
  const nlr = db.prepare('SELECT * FROM nonlead_requests WHERE id = ?').get(req.params.id);
  if (!nlr) return res.status(404).json({ error: 'Request not found' });
  db.prepare(`UPDATE leads SET status = 'active' WHERE id = ?`).run(nlr.lead_id);
  db.prepare(`UPDATE nonlead_requests SET status = 'rejected' WHERE id = ?`).run(nlr.id);
  res.json({ ok: true });
});
}

// ── PlusVibe — campaigns for a workspace ──────────────────
app.get('/api/pv/workspaces', requireSession, async (req, res) => {
  // Source the client list from the local clients table — the live PlusVibe API
  // key is deprecated, and Bison's /api/workspaces only returns the token's own
  // team (not all clients). The clients table has every client keyed by its
  // PlusVibe workspace_id (used for the filter, cooldown, and PV push).
  try {
    if (db && db.prepare) {
      const rows = db.prepare(
        `SELECT workspace_id, workspace_name FROM clients
          WHERE workspace_id IS NOT NULL AND workspace_id != '' ORDER BY workspace_name`
      ).all();
      if (rows.length) {
        return res.json({ workspaces: rows.map(r => ({ _id: r.workspace_id, name: r.workspace_name })) });
      }
    }
    // Fallback: Bison workspaces if the clients table is empty.
    const data = listBisonWorkspaces();
    const workspaces = Array.isArray(data) ? data : (data?.data || []);
    res.json({ workspaces: workspaces.map(w => ({ _id: String(w.id), name: w.name })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Performance/Actions compatibility shim ───────────────────
// performance.html and actions.html were written against the (now deprecated)
// PlusVibe browser API. Rather than rewrite their rendering logic, these routes
// reproduce the exact response shapes those pages already parse, but sourced
// from EmailBison. The pages call /api/perfshim/* same-origin with the session
// cookie; we map their PlusVibe workspace_id -> Bison team_id via BISON_TEAMS.
// Every route degrades to an empty-but-valid shape (never a 500) so the pages
// keep rendering even when Bison errors or a workspace isn't mapped to a team.
function perfshimTeamId(workspace_id) {
  const team = BISON_TEAMS.find(t => t.pv === String(workspace_id));
  return team ? team.team_id : null;
}

// 1. GET /account/email-stats — summed totals for a workspace + date range.
// Source: Bison line-area-chart-stats (stateful: bisonReq wsId switches the
// workspace first), pivoted via pivotBisonStats and summed via aggPvEmailStats.
// Returns { header: { ...totals } } which aggEmailStats() reads directly.
app.get('/api/perfshim/account/email-stats', requireSession, async (req, res) => {
  const { workspace_id, start_date, end_date } = req.query;
  const empty = { header: { total_sent_count: 0, total_reply_count: 0, total_ooo_reply_count: 0, total_pos_reply_count: 0, total_bounce_count: 0, total_contacted_count: 0 } };
  try {
    const wsId = perfshimTeamId(workspace_id);
    if (!wsId) return res.json(empty);
    const bStats = await bisonReq('/api/workspaces/v1.1/line-area-chart-stats', {
      wsId,
      params: { start_date, end_date },
    });
    const rows = Object.values(pivotBisonStats((bStats.data || bStats) || []));
    const agg = aggPvEmailStats(rows); // { sent, replies, oooReplies, posReplies, bounces, contacted }
    res.json({ header: {
      total_sent_count:      agg.sent,
      total_reply_count:     agg.replies,
      total_ooo_reply_count: agg.oooReplies, // Bison has no OOO dimension -> 0 (see pivotBisonStats)
      total_pos_reply_count: agg.posReplies,
      total_bounce_count:    agg.bounces,
      total_contacted_count: agg.contacted,
    } });
  } catch (err) {
    console.warn('[perfshim] email-stats failed for ws', workspace_id, '-', err.message);
    res.json(empty);
  }
});

// 2. GET /analytics/campaign/stats — array of campaigns for renderCampaigns()/agg().
// Source: Bison /api/campaigns mapped to the PV campaign-stat field names.
app.get('/api/perfshim/analytics/campaign/stats', requireSession, async (req, res) => {
  const { workspace_id } = req.query;
  try {
    const wsId = perfshimTeamId(workspace_id);
    if (!wsId) return res.json([]);
    const data = await bisonReq('/api/campaigns', { wsId });
    const list = (data?.data || []).map(c => ({
      camp_name:            c.name,
      name:                 c.name,
      status:               c.status,
      sent_count:           c.emails_sent || 0,
      replied_count:        c.replied || 0,
      ooo_reply_count:      0, // Bison has no OOO dimension
      positive_reply_count: 0, // Bison campaign list has no positive-reply field
      bounced_count:        c.bounced || 0,
      lead_contacted_count: c.total_leads_contacted || 0,
    }));
    res.json(list);
  } catch (err) {
    console.warn('[perfshim] campaign/stats failed for ws', workspace_id, '-', err.message);
    res.json([]);
  }
});

// 3. GET /account/list — sending accounts for renderSummary() capacity calc.
// Source: Bison /api/sender-emails. status connected -> 'ACTIVE'; daily_limit
// nested under payload (the page reads a.status === 'ACTIVE' and a.payload.daily_limit).
app.get('/api/perfshim/account/list', requireSession, async (req, res) => {
  const { workspace_id } = req.query;
  try {
    const wsId = perfshimTeamId(workspace_id);
    if (!wsId) return res.json([]);
    const list = await bisonListSenderEmails(wsId); // paginated — Bison caps ~15/page
    const accounts = list.map(a => {
      const connected = a.status === 'connected' || a.is_connected === true;
      const paused = a.status === 'paused';
      return {
        status: connected ? 'ACTIVE' : (paused ? 'PAUSED' : 'INACTIVE'),
        payload: { daily_limit: typeof a.daily_limit === 'number' ? a.daily_limit : 0 },
      };
    });
    res.json(accounts);
  } catch (err) {
    console.warn('[perfshim] account/list failed for ws', workspace_id, '-', err.message);
    res.json([]);
  }
});

// 4. GET /account/warmup-stats — { emailAcc: { inbox_percent, total_inboxes } }.
// total_inboxes = count of sender emails with warmup enabled (accurate).
// inbox_percent: Bison has no direct "inbox placement %" equivalent in the
// sender-emails payload, so we return 0 rather than fabricate a misleading
// number. renderSummary() shows '—' when inbox_percent is 0/absent.
app.get('/api/perfshim/account/warmup-stats', requireSession, async (req, res) => {
  const { workspace_id } = req.query;
  const empty = { emailAcc: { inbox_percent: 0, total_inboxes: 0 } };
  try {
    const wsId = perfshimTeamId(workspace_id);
    if (!wsId) return res.json(empty);
    const list = await bisonListSenderEmails(wsId); // paginated — Bison caps ~15/page
    const warming = list.filter(a => (a.warmup_enabled ?? a.warmup?.enabled) === true).length;
    res.json({ emailAcc: { inbox_percent: 0, total_inboxes: warming } });
  } catch (err) {
    console.warn('[perfshim] warmup-stats failed for ws', workspace_id, '-', err.message);
    res.json(empty);
  }
});

// 5. GET /lead/count/lead-status — { NOT_CONTACTED, CONTACTED, REPLIED, BOUNCED, COMPLETED }.
// Bison has no direct lead-status-count endpoint, so we derive what we can from
// campaign aggregates: CONTACTED = sum(total_leads_contacted), REPLIED = sum(replied),
// BOUNCED = sum(bounced). NOT_CONTACTED and COMPLETED have no Bison equivalent
// here, so they're 0 (accurate-or-zero, never fabricated).
app.get('/api/perfshim/lead/count/lead-status', requireSession, async (req, res) => {
  const { workspace_id } = req.query;
  const empty = { NOT_CONTACTED: 0, CONTACTED: 0, REPLIED: 0, BOUNCED: 0, COMPLETED: 0 };
  try {
    const wsId = perfshimTeamId(workspace_id);
    if (!wsId) return res.json(empty);
    const data = await bisonReq('/api/campaigns', { wsId });
    const out = { ...empty };
    (data?.data || []).forEach(c => {
      out.CONTACTED += c.total_leads_contacted || 0;
      out.REPLIED   += c.replied || 0;
      out.BOUNCED   += c.bounced || 0;
    });
    res.json(out);
  } catch (err) {
    console.warn('[perfshim] lead-status failed for ws', workspace_id, '-', err.message);
    res.json(empty);
  }
});

// 6. GET /lead/workspace-leads — per-label lead listing (used by fetchLabeledLeads).
// Now Bison-backed via bisonWorkspaceLeads (label → filters[lead_campaign_status]).
app.get('/api/perfshim/lead/workspace-leads', requireSession, async (req, res) => {
  const { workspace_id, label, page, limit } = req.query;
  if (!workspace_id) return res.json([]);
  try {
    const leads = await bisonWorkspaceLeads(workspace_id, {
      label, page: parseInt(page) || 1, perPage: parseInt(limit) || 100,
    });
    res.json(leads);
  } catch { res.json([]); } // pages tolerate empty; never error the scan
});

app.get('/api/pv/campaigns', requireSession, async (req, res) => {
  const { workspace_id } = req.query;
  if (!workspace_id) return res.status(400).json({ error: 'Missing workspace_id' });
  try {
    // Bison is stateful: bisonReq wsId switches the workspace, then /api/campaigns
    // returns { data: [{id,name,status,...}] }. Resolve the incoming PV id (or
    // team_id) to a Bison team_id; a mapping miss is a clear error, not an empty
    // list that looks like "no campaigns".
    const wsId = resolveBisonTeamId(workspace_id);
    if (!wsId) return res.status(404).json({ error: 'This client is not mapped to a Bison workspace yet.' });
    const data = await bisonReq('/api/campaigns', { wsId });
    const list = (data?.data || []).map(c => ({
      id: c.id,
      name: c.name,          // contacts.html renders c.name in the dropdown
      camp_name: c.name,     // older callers expect camp_name
      status: c.status,
    }));
    res.json({ list });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ── PlusVibe — push contacts to campaign ──────────────────
app.post('/api/pv/push-contacts', requireSession, async (req, res) => {
  const { workspace_id, campaign_id, contact_ids } = req.body;
  if (!workspace_id || !campaign_id || !Array.isArray(contact_ids) || contact_ids.length === 0) {
    return res.status(400).json({ error: 'workspace_id, campaign_id and contact_ids required' });
  }
  try {
    const db = req.app.locals.pgDb;
    if (!db) return res.status(500).json({ error: 'Database not available' });

    // Fetch all contact details (batch query)
    const allContacts = await db.getContactsById(contact_ids);
    if (allContacts.length === 0) return res.status(404).json({ error: 'No contacts found' });

    // Same dedup/cooldown filter as /verify-and-push — per-workspace
    // 60-day cooldown + per-campaign skip. Verification is the caller's
    // job on this path (this endpoint is 'push without verify').
    const cooloffDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const campaignNameLc = (req.body.campaign_name || '').toString().trim().toLowerCase();
    const skipped = { unsafe: 0, dnc: 0, cooldownWorkspace: 0, alreadyInCampaign: 0, missingEnrichment: 0, missingName: 0 };
    // Hard status gate — only verified-deliverable contacts may reach PlusVibe,
    // even on this "push without verify" path. Anything unknown/risky/invalid/
    // NULL is rejected so unsafe contacts can never leak into a campaign.
    const PUSHABLE_STATUSES = new Set(['safe', 'safe_catchall']);
    const contacts = allContacts.filter(c => {
      if (!PUSHABLE_STATUSES.has((c.email_status || '').toLowerCase())) { skipped.unsafe++; return false; }
      if (c.do_not_contact) { skipped.dnc++; return false; }
      // Bison requires non-empty first_name AND last_name (422s otherwise), and a
      // nameless contact shouldn't be cold-emailed anyway — skip and report.
      if (!(c.first_name && c.first_name.trim()) || !(c.last_name && c.last_name.trim())) {
        skipped.missingName++; return false;
      }
      if ((!c.keywords || c.keywords.trim() === '') || (!c.industry || c.industry.trim() === '')) {
        skipped.missingEnrichment++; return false;
      }
      if (campaignNameLc && c.last_campaign_name
          && c.last_campaign_name.toLowerCase() === campaignNameLc) {
        skipped.alreadyInCampaign++; return false;
      }
      if (workspace_id) {
        const emailed = typeof c.emailed_workspaces === 'string'
          ? JSON.parse(c.emailed_workspaces || '{}')
          : (c.emailed_workspaces || {});
        const lastSent = emailed[workspace_id]?.last_sent;
        if (lastSent && lastSent >= cooloffDate) { skipped.cooldownWorkspace++; return false; }
      }
      return true;
    });
    console.log(`[push-contacts] filtered ${allContacts.length} → ${contacts.length}`, skipped);
    if (contacts.length === 0) {
      return res.json({ success: true, pushed: 0, total: 0, skipped });
    }

    const leads = contacts.map(c => {
      const raw = typeof c.raw_data === 'string' ? JSON.parse(c.raw_data || '{}') : (c.raw_data || {});

      return {
        // Native PlusVibe fields — go at top level so they populate the
        // matching form fields (and resolve {{merge_tag}} in templates).
        email: c.email,
        first_name: c.first_name || '',
        last_name: c.last_name || '',
        phone_number: c.phone || '',
        company_name: c.company_name || '',
        company_website: c.company_domain || '',
        address_line: c.company_address || raw['Company Address'] || raw['Address Line'] || raw.Address || '',
        // Company is the default location target (per spec): native city/state/
        // country carry COMPANY location so {{city}}/{{state}}/{{country}}
        // resolve to the company. Person is exposed via {{person_*}} custom vars.
        city: c.company_city || c.city || raw['Company City'] || raw.City || '',
        state: c.company_county || c.company_state || c.state || raw['Company State'] || '',
        country: c.company_country || c.country || raw['Company Country'] || raw.Country || '',
        job_title: c.job_title || '',
        department: c.department || '',
        industry: raw.Industry || c.industry || '',
        linkedin_person_url: c.linkedin_url || '',
        linkedin_company_url: c.company_linkedin_url || '',
        custom_variables: {
          job_title_cleaned: c.job_title_cleaned || '',
          seniority: c.seniority || '',
          sub_departments: c.sub_departments || '',
          company_city: c.company_city || raw['Company City'] || '',
          company_state: c.company_state || raw['Company State'] || '',
          company_country: c.company_country || raw['Company Country'] || '',
          num_employees: c.num_employees || raw['Employees'] || '',
          corporate_phone: c.corporate_phone || '',
          company_phone: c.company_phone || raw['Company Phone'] || '',
          apollo_id: c.apollo_id || '',
          apollo_person_id: c.apollo_person_id || '',
          technologies: raw.Technologies || c.technologies || '',
          keywords: raw.Keywords || c.keywords || '',
          ...raw,
          // Location hierarchy last so clean normalised values win over raw.
          ...locationCustomVars(c)
        }
      };
    });

    const BATCH = 100;
    let pushed = 0;
    for (let i = 0; i < leads.length; i += BATCH) {
      const batch = leads.slice(i, i + BATCH);
      /* workspace switch handled by bisonReq wsId */ true;
      var bisonLeadPayload = (batch)
        // Bison requires non-empty first_name AND last_name (422s on null/""/" ").
        // Payload-layer safety net (the route already filters, but this guarantees it).
        .filter(function(l){ return l.first_name && String(l.first_name).trim() && l.last_name && String(l.last_name).trim(); })
        .map(function(l) {
        var cv = [];
        if (l.phone_number) cv.push({ name: 'phone_number', value: String(l.phone_number) });
        if (l.city) cv.push({ name: 'city', value: String(l.city) });
        if (l.state) cv.push({ name: 'state', value: String(l.state) });
        if (l.country) cv.push({ name: 'country', value: String(l.country) });
        if (l.industry) cv.push({ name: 'industry', value: String(l.industry) });
        if (l.linkedin_person_url) cv.push({ name: 'linkedin_person_url', value: String(l.linkedin_person_url) });
        if (l.linkedin_company_url) cv.push({ name: 'linkedin_company_url', value: String(l.linkedin_company_url) });
        if (l.company_website) cv.push({ name: 'company_website', value: String(l.company_website) });
        if (l.department) cv.push({ name: 'department', value: String(l.department) });
        if (l.address_line) cv.push({ name: 'address_line', value: String(l.address_line) });
        return { email: l.email, first_name: l.first_name || null, last_name: l.last_name || null, title: l.job_title || l.title || null, company: l.company_name || l.company || null, custom_variables: cv };
      });
      if (!bisonLeadPayload.length) { continue; }
      // Ensure every custom var these leads use exists in the workspace, or Bison 422s.
      await ensureBisonCustomVars(workspace_id, new Set(bisonLeadPayload.flatMap(function(l){ return (l.custom_variables||[]).map(function(v){ return v.name; }); })));
      var createRes = await bisonReq('/api/leads/create-or-update/multiple', { wsId: workspace_id, method: 'POST', body: { leads: bisonLeadPayload } });
      if (campaign_id && createRes && createRes.data) {
        var leadIds = (createRes.data.leads || createRes.data || []).map(function(l) { return l.id; }).filter(Boolean);
        if (leadIds.length) {
          await bisonReq('/api/campaigns/' + campaign_id + '/leads/attach-leads', { wsId: workspace_id, method: 'POST', body: { lead_ids: leadIds } }).catch(function(e) { console.warn('[bison] campaign-assign FAILED:', e.message); });
        }
      }
      var r = { ok: true };
      pushed += batch.length;
    }

    // Stamp emailed_workspaces so these contacts are snoozed for 60 days
    // for this client — prevents them from appearing in future push batches.
    const pushedIds = contacts.map(c => c.id).filter(Boolean);
    if (pushedIds.length && db.stampPushedCampaign) {
      db.stampPushedCampaign(pushedIds, workspace_id, campaign_id, req.body.campaign_name || '').catch(err =>
        console.warn('[push-contacts] workspace stamp failed:', err.message));
    }

    res.json({ success: true, pushed, total: leads.length, skipped });
  } catch (err) {
    console.error('[PV Push]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Push to EmailBison (reuses the existing bisonFetch/bisonSwitch helpers) ──
// Separate path from PlusVibe (PV endpoint above unchanged). Bison 2-step:
// create/update leads → import-by-ids into the campaign, after switch-workspace.

// Shared contact→pushable filter (same rules as the PV path). Pure function.
function filterPushableContacts(allContacts, { cooldownWorkspaceId, campaignName }) {
  const cooloffDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const campaignNameLc = (campaignName || '').toString().trim().toLowerCase();
  const skipped = { unsafe: 0, dnc: 0, cooldownWorkspace: 0, alreadyInCampaign: 0, missingEnrichment: 0, missingName: 0 };
  const PUSHABLE_STATUSES = new Set(['safe', 'safe_catchall']);
  const contacts = allContacts.filter(c => {
    if (!PUSHABLE_STATUSES.has((c.email_status || '').toLowerCase())) { skipped.unsafe++; return false; }
    if (c.do_not_contact) { skipped.dnc++; return false; }
    // Bison requires non-empty first_name AND last_name (422s otherwise).
    if (!(c.first_name && c.first_name.trim()) || !(c.last_name && c.last_name.trim())) {
      skipped.missingName++; return false;
    }
    if ((!c.keywords || c.keywords.trim() === '') || (!c.industry || c.industry.trim() === '')) {
      skipped.missingEnrichment++; return false;
    }
    if (campaignNameLc && c.last_campaign_name && c.last_campaign_name.toLowerCase() === campaignNameLc) {
      skipped.alreadyInCampaign++; return false;
    }
    if (cooldownWorkspaceId) {
      const emailed = typeof c.emailed_workspaces === 'string'
        ? JSON.parse(c.emailed_workspaces || '{}')
        : (c.emailed_workspaces || {});
      const lastSent = emailed[cooldownWorkspaceId]?.last_sent;
      if (lastSent && lastSent >= cooloffDate) { skipped.cooldownWorkspace++; return false; }
    }
    return true;
  });
  return { contacts, skipped };
}

// Map an Ottaly contact to a Bison lead (custom_variables = array of {name,value}).
function contactToBisonLead(c) {
  const raw = typeof c.raw_data === 'string' ? JSON.parse(c.raw_data || '{}') : (c.raw_data || {});
  const cv = [];
  const add = (name, value) => { if (value !== undefined && value !== null && value !== '') cv.push({ name, value: String(value) }); };
  add('phone_number', c.phone);
  add('company_website', c.company_domain);
  add('job_title', c.job_title);
  add('industry', raw.Industry || c.industry);
  add('linkedin_person_url', c.linkedin_url);
  add('linkedin_company_url', c.company_linkedin_url);
  add('city', c.company_city || c.city);
  add('state', c.company_county || c.company_state || c.state);
  add('country', c.company_country || c.country);
  add('seniority', c.seniority);
  add('keywords', raw.Keywords || c.keywords);
  return {
    email:      c.email,
    first_name: c.first_name || '',
    last_name:  c.last_name || '',
    title:      c.job_title || '',
    company:    c.company_name || '',
    custom_variables: cv,
  };
}

// GET /api/bison/workspaces — Bison workspaces for the push dropdown. Uses the
// known BISON_TEAMS map (the token's /api/workspaces only lists its own teams).
app.get('/api/bison/workspaces', requireSession, (req, res) => {
  res.json({ workspaces: BISON_TEAMS.map(t => ({ id: t.team_id, name: t.name, pv_workspace_id: t.pv })) });
});

// GET /api/bison/campaigns?ws_id=  — live Bison campaigns for a workspace.
app.get('/api/bison/campaigns', requireSession, async (req, res) => {
  const wsId = String(req.query.ws_id || '');
  if (!wsId) return res.status(400).json({ error: 'ws_id required' });
  try {
    const data = await bisonReq('/api/campaigns', { wsId });
    // ?raw=1 → return the unparsed Bison response for diagnosis.
    if (req.query.raw) return res.json({ raw: data });
    // Handle a few possible shapes: {data:[...]}, [...], {data:{data:[...]}}, {data:{campaigns:[...]}}.
    const list = Array.isArray(data) ? data
      : Array.isArray(data?.data) ? data.data
      : Array.isArray(data?.data?.data) ? data.data.data
      : Array.isArray(data?.data?.campaigns) ? data.data.campaigns
      : [];
    res.json({ campaigns: list.map(c => ({ id: String(c.id), name: c.name, status: c.status })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bison/create-campaign  — create a new Draft campaign in a workspace.
// body: { ws_id, name, settings? }
//  - ws_id:    Bison workspace id (switch-workspace target)
//  - name:     campaign name (auto-generated from filters on the client, editable)
//  - settings: optional { max_emails_per_day?, max_new_leads_per_day?,
//              open_tracking?, plain_text?, can_unsubscribe? } applied via
//              PATCH /api/campaigns/{id}/update right after create.
// New campaigns are status "Draft" by default — we do NOT launch/activate them.
// A fixed default sending schedule (Mon–Fri 07:30–17:00 Europe/London) is also
// applied. Settings/schedule are best-effort: a failure there is reported in the
// response but does NOT discard the created campaign (it still returns its id).
app.post('/api/bison/create-campaign', requireSession, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const settings = (req.body.settings && typeof req.body.settings === 'object') ? req.body.settings : null;
  // Map the incoming PV workspace_id (or team_id) to the Bison team_id. Passing
  // the raw PV string switched to team_id NaN and created the campaign in the
  // wrong/last-active workspace.
  const wsId = resolveBisonTeamId(req.body.ws_id);
  if (!wsId || !name) return res.status(400).json({ error: 'ws_id (resolvable to a Bison workspace) and a non-empty name are required' });
  if (!getBisonKey()) return res.status(500).json({ error: 'Bison API key not configured — set it in admin settings' });
  try {
    const resp = await bisonReq('/api/campaigns', { wsId, method: 'POST', body: { name, type: 'outbound' } });
    const c = resp?.data || {};
    const campId = c.id;
    const warnings = [];

    if (campId && settings) {
      // Whitelist the fields Bison's updateCampaignSettings accepts; coerce types.
      const body = {};
      if (settings.max_emails_per_day != null && settings.max_emails_per_day !== '')
        body.max_emails_per_day = Number(settings.max_emails_per_day);
      if (settings.max_new_leads_per_day != null && settings.max_new_leads_per_day !== '')
        body.max_new_leads_per_day = Number(settings.max_new_leads_per_day);
      // Bison enforces max_new_leads_per_day <= max_emails_per_day (422 otherwise).
      // If new-leads is set higher than emails (or emails was left blank), raise the
      // emails cap to match so the PATCH is accepted. Actual send volume is still
      // governed by each mailbox's daily limit, so a high campaign cap is harmless.
      if (body.max_new_leads_per_day != null &&
          (body.max_emails_per_day == null || body.max_emails_per_day < body.max_new_leads_per_day)) {
        body.max_emails_per_day = body.max_new_leads_per_day;
      }
      if (typeof settings.open_tracking === 'boolean') body.open_tracking = settings.open_tracking;
      if (typeof settings.plain_text === 'boolean') body.plain_text = settings.plain_text;
      if (typeof settings.can_unsubscribe === 'boolean') body.can_unsubscribe = settings.can_unsubscribe;
      if (Object.keys(body).length) {
        try {
          await bisonReq('/api/campaigns/' + campId + '/update', { wsId, method: 'PATCH', body });
        } catch (e) {
          console.warn('[bison] campaign settings PATCH failed:', e.message);
          warnings.push('settings not fully applied: ' + e.message);
        }
      }
    }

    if (campId) {
      // Fixed default schedule — Mon–Fri 07:30–17:00 Europe/London.
      try {
        await bisonReq('/api/campaigns/' + campId + '/schedule', {
          wsId, method: 'POST',
          body: {
            monday: true, tuesday: true, wednesday: true, thursday: true, friday: true,
            saturday: false, sunday: false,
            start_time: '07:30', end_time: '17:00', timezone: 'Europe/London',
            save_as_template: false,
          },
        });
      } catch (e) {
        console.warn('[bison] campaign schedule POST failed:', e.message);
        warnings.push('schedule not applied: ' + e.message);
      }
    }

    res.json({ ok: true, campaign: { id: String(c.id), name: c.name, status: c.status }, warnings });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Failed to create Bison campaign' });
  }
});

// POST /api/bison/push-contacts
// body: { ws_id, campaign_id, contact_ids, campaign_name?, cooldown_workspace_id? }
//  - ws_id:        Bison workspace id (switch-workspace target)
//  - campaign_id:  Bison campaign to import into
//  - cooldown_workspace_id: the client's PV workspace_id, for the shared 60-day
//                  per-client cooldown stamp (optional).
app.post('/api/bison/push-contacts', requireSession, async (req, res) => {
  const { ws_id, campaign_id, contact_ids } = req.body;
  if (!ws_id || !campaign_id || !Array.isArray(contact_ids) || contact_ids.length === 0) {
    return res.status(400).json({ error: 'ws_id, campaign_id and contact_ids required' });
  }
  if (!getBisonKey()) return res.status(500).json({ error: 'Bison API key not configured — set it in admin settings' });
  try {
    // Contacts live in Postgres (app.locals.pgDb), not the top-level SQLite db.
    const pgDb = req.app.locals.pgDb;
    if (!pgDb || !pgDb.getContactsById) return res.status(500).json({ error: 'Contacts DB not available' });
    const allContacts = await pgDb.getContactsById(contact_ids);
    if (allContacts.length === 0) return res.status(404).json({ error: 'No contacts found' });

    const cooldownWorkspaceId = req.body.cooldown_workspace_id || null;
    const { contacts, skipped } = filterPushableContacts(allContacts, {
      cooldownWorkspaceId, campaignName: req.body.campaign_name,
    });
    console.log(`[bison-push] filtered ${allContacts.length} → ${contacts.length}`, skipped);
    if (contacts.length === 0) return res.json({ success: true, pushed: 0, total: 0, skipped });

    // 0. Ensure the workspace has every custom variable our leads use — Bison
    //    422s if a lead references a custom variable that doesn't exist. Fetch
    //    existing, create any missing. Best-effort: a creation failure doesn't
    //    abort the push (the create-leads step will surface any real error).
    const neededVars = new Set();
    for (const c of contacts) for (const cv of contactToBisonLead(c).custom_variables) neededVars.add(cv.name);
    try {
      const existingResp = await bisonReq('/api/custom-variables', { wsId: ws_id });
      const existingList = Array.isArray(existingResp) ? existingResp : (existingResp?.data ?? []);
      const existing = new Set(existingList.map(v => (v.name || v.slug || '').toLowerCase()));
      for (const name of neededVars) {
        if (!existing.has(name.toLowerCase())) {
          await bisonReq('/api/custom-variables', { wsId: ws_id, method: 'POST', body: { name } })
            .catch(e => console.warn(`[bison-push] create custom var "${name}" failed:`, e.message));
        }
      }
    } catch (e) {
      console.warn('[bison-push] custom-variable ensure step failed (continuing):', e.message);
    }

    // 1. Create/update leads (≤500/req), collecting Bison ids. Mirrors the
    //    proven verify-and-push Bison path: create-or-update/multiple, then read
    //    ids from data.leads || data.
    const leadIds = [];
    for (let i = 0; i < contacts.length; i += 500) {
      const slice = contacts.slice(i, i + 500);
      const resp = await bisonReq('/api/leads/create-or-update/multiple', {
        wsId: ws_id, method: 'POST',
        body: { leads: slice.map(contactToBisonLead) },
      });
      const rows = (resp && resp.data && (resp.data.leads || resp.data)) || [];
      for (const row of (Array.isArray(rows) ? rows : [])) { if (row?.id != null) leadIds.push(row.id); }
    }
    if (leadIds.length === 0) return res.status(502).json({ error: 'Bison created no leads', pushed: 0, skipped });

    // 2. Assign the leads to the campaign (proven endpoint: /campaigns/{id}/leads).
    let pushed = 0;
    for (let i = 0; i < leadIds.length; i += 1000) {
      const idSlice = leadIds.slice(i, i + 1000);
      await bisonReq(`/api/campaigns/${campaign_id}/leads/attach-leads`, {
        wsId: ws_id, method: 'POST', body: { lead_ids: idSlice },
      });
      pushed += idSlice.length;
    }

    // 3. Shared per-client cooldown stamp (keyed by PV workspace_id).
    const pushedIds = contacts.map(c => c.id).filter(Boolean);
    if (pushedIds.length && cooldownWorkspaceId && pgDb.stampPushedCampaign) {
      pgDb.stampPushedCampaign(pushedIds, cooldownWorkspaceId, String(campaign_id), req.body.campaign_name || '')
        .catch(err => console.warn('[bison-push] stamp failed:', err.message));
    }

    res.json({ success: true, pushed, total: contacts.length, skipped });
  } catch (err) {
    console.error('[Bison Push]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Email Verify 2.0 — Proxy Management ──────────────────────

// GET /api/ev2/proxies
app.get('/api/ev2/proxies', requireSession, (req, res) => {
  if (!db) return res.status(500).json({ error: 'DB not available' });
  const rows = db.prepare('SELECT * FROM ev2_proxies ORDER BY added_at DESC').all();
  res.json({ proxies: rows });
});

// GET /api/ev2/active-proxy — returns next proxy in rotation (round-robin by use_count)
// Called by email-finder-local per Reacher request. Returns null ONLY if pool is empty.
// Priority: ok > untested > error (last resort — never silently fall back to proxy4smtp)
app.get('/api/ev2/active-proxy', (req, res) => {
  if (!db) return res.json({ proxy: null });

  // Pick least-used: prefer ok, then untested, then error as last resort
  const proxy =
    db.prepare(`SELECT * FROM ev2_proxies WHERE status = 'ok'      ORDER BY use_count ASC, last_used ASC NULLS FIRST LIMIT 1`).get() ||
    db.prepare(`SELECT * FROM ev2_proxies WHERE status = 'untested' ORDER BY use_count ASC, last_used ASC NULLS FIRST LIMIT 1`).get() ||
    db.prepare(`SELECT * FROM ev2_proxies WHERE status = 'error'    ORDER BY use_count ASC, last_used ASC NULLS FIRST LIMIT 1`).get();

  if (!proxy) return res.json({ proxy: null }); // truly empty pool

  db.prepare(`UPDATE ev2_proxies SET use_count = use_count + 1, last_used = datetime('now') WHERE id = ?`).run(proxy.id);
  res.json({
    proxy: { host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password }
  });
});

// POST /api/ev2/proxies — bulk add (newline-separated IP:PORT:USER:PASS or IP:PORT)
app.post('/api/ev2/proxies', requireSession, (req, res) => {
  if (!db) return res.status(500).json({ error: 'DB not available' });
  const { lines } = req.body;
  if (!lines) return res.status(400).json({ error: 'lines required' });

  const insert = db.prepare(`INSERT INTO ev2_proxies (host, port, username, password, label) VALUES (?, ?, ?, ?, ?)`);
  let added = 0;
  for (const raw of lines.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length < 2) continue;
    const [host, portStr, username = '', password = ''] = parts;
    const port = parseInt(portStr, 10);
    if (!host || isNaN(port)) continue;
    try {
      insert.run(host, port, username, password, `${host}:${port}`);
      added++;
    } catch { /* skip dupes */ }
  }
  res.json({ added });
});

// DELETE /api/ev2/proxies/:id
app.delete('/api/ev2/proxies/:id', requireSession, (req, res) => {
  if (!db) return res.status(500).json({ error: 'DB not available' });
  db.prepare('DELETE FROM ev2_proxies WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// DELETE /api/ev2/proxies — clear all
app.delete('/api/ev2/proxies', requireSession, (req, res) => {
  if (!db) return res.status(500).json({ error: 'DB not available' });
  db.prepare('DELETE FROM ev2_proxies').run();
  res.json({ ok: true });
});

// POST /api/ev2/proxies/:id/test — HTTP request through proxy to confirm auth works
app.post('/api/ev2/proxies/:id/test', requireSession, (req, res) => {
  if (!db) return res.status(500).json({ error: 'DB not available' });
  const row = db.prepare('SELECT * FROM ev2_proxies WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Proxy not found' });

  let resolved = false;
  const done = (ok, detail) => {
    if (resolved) return;
    resolved = true;
    const status = ok ? 'ok' : 'error';
    try { db.prepare('UPDATE ev2_proxies SET status = ?, tested_at = datetime("now") WHERE id = ?').run(status, row.id); } catch {}
    res.json({ ok, status, detail });
  };

  // Hard 8s overall deadline
  const deadline = setTimeout(() => done(false, 'timeout'), 8000);

  const s = net.createConnection({ host: row.host, port: row.port });
  s.setTimeout(7000);

  s.once('error', (err) => { clearTimeout(deadline); done(false, err.message); });
  s.once('timeout', () => { s.destroy(); clearTimeout(deadline); done(false, 'socket timeout'); });

  s.once('connect', () => {
    // Send HTTP request through the proxy using Proxy-Authorization header
    const authHeader = row.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${row.username}:${row.password}`).toString('base64')}\r\n`
      : '';
    // Request the Webshare IP check endpoint via proxy (HTTP, not HTTPS)
    s.write(
      `GET http://ipv4.webshare.io/ HTTP/1.1\r\n` +
      `Host: ipv4.webshare.io\r\n` +
      authHeader +
      `Connection: close\r\n\r\n`
    );

    let buf = '';
    s.on('data', chunk => {
      buf += chunk.toString();
      // Any valid HTTP response = proxy is working
      if (buf.includes('\r\n')) {
        const firstLine = buf.split('\r\n')[0];
        const httpCode = parseInt(firstLine.split(' ')[1] || '0', 10);
        s.destroy();
        clearTimeout(deadline);
        // 200 = ok, 301/302 redirect = proxy works, 407 = bad auth, others = error
        if (httpCode === 200 || httpCode === 301 || httpCode === 302) {
          done(true, firstLine.trim());
        } else if (httpCode === 407) {
          done(false, 'Proxy auth failed (407)');
        } else {
          done(true, firstLine.trim()); // got a response = proxy is reachable
        }
      }
    });
  });
});

// POST /api/ev2/verify — verify list of emails using rotating proxies
app.post('/api/ev2/verify', requireSession, async (req, res) => {
  if (!db) return res.status(500).json({ error: 'DB not available' });
  const { emails, useProxy = true } = req.body;
  if (!Array.isArray(emails) || emails.length === 0) return res.status(400).json({ error: 'emails array required' });
  if (emails.length > 5000) return res.status(400).json({ error: 'Max 5000 emails per request' });

  const reacherBase = process.env.REACHER_URL || 'http://github_reacher';
  const endpoint = `${reacherBase.replace(/\/$/, '')}/v1/check_email`;

  // Load ok proxies (or all if none tested)
  let proxies = [];
  if (useProxy) {
    proxies = db.prepare("SELECT * FROM ev2_proxies WHERE status = 'ok' ORDER BY RANDOM()").all();
    if (proxies.length === 0) proxies = db.prepare('SELECT * FROM ev2_proxies ORDER BY RANDOM()').all();
  }

  let proxyIdx = 0;
  const getNextProxy = () => proxies.length > 0 ? proxies[proxyIdx++ % proxies.length] : null;

  const results = [];
  const CONCURRENCY = proxies.length > 0 ? Math.min(proxies.length, 5) : 1;

  async function verifyOne(email) {
    const proxy = getNextProxy();
    const body = { to_email: email.trim() };
    if (proxy) body.proxy = { host: proxy.host, port: proxy.port, username: proxy.username || undefined, password: proxy.password || undefined };
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.REACHER_API_KEY) headers.authorization = `Bearer ${process.env.REACHER_API_KEY}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      const r = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal }).finally(() => clearTimeout(timer));
      const data = await r.json();
      const reachable = data?.is_reachable || 'unknown';
      return { email: email.trim(), result: reachable, deliverable: data?.smtp?.is_deliverable, catchAll: data?.smtp?.is_catch_all, proxy: proxy ? `${proxy.host}:${proxy.port}` : null };
    } catch (err) {
      return { email: email.trim(), result: 'error', error: err.message, proxy: proxy ? `${proxy.host}:${proxy.port}` : null };
    }
  }

  // Process with limited concurrency
  for (let i = 0; i < emails.length; i += CONCURRENCY) {
    const batch = emails.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(verifyOne));
    results.push(...batchResults);
  }

  res.json({ results, total: results.length, proxiesUsed: proxies.length });
});

app.get('/email-verify2', (req, res) => res.sendFile(path.join(__dirname, 'email-verify2.html')));
app.get('/apollo-prep',      (req, res) => res.sendFile(path.join(__dirname, 'apollo-prep.html')));
app.get('/apollo-prep.html', (req, res) => res.sendFile(path.join(__dirname, 'apollo-prep.html')));
app.get('/database',         (req, res) => res.sendFile(path.join(__dirname, 'database.html')));
app.get('/database.html',    (req, res) => res.sendFile(path.join(__dirname, 'database.html')));

// ── Database admin API ────────────────────────────────────────────────────

app.get('/api/admin/send-time-analysis', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const [coverage, hourly, daily] = await Promise.all([
      pgdb.query(`
        SELECT event_type, MIN(event_at)::date AS earliest, MAX(event_at)::date AS latest, COUNT(*)::int AS total
        FROM email_events
        WHERE event_type IN ('sent','reply','lead','positive_reply')
        GROUP BY event_type ORDER BY event_type
      `),
      pgdb.query(`
        SELECT
          EXTRACT(DOW  FROM event_at AT TIME ZONE 'Europe/London')::int AS day_of_week,
          EXTRACT(HOUR FROM event_at AT TIME ZONE 'Europe/London')::int AS hour,
          COUNT(*) FILTER (WHERE event_type IN ('reply','lead','positive_reply'))::int AS replies,
          COUNT(*) FILTER (WHERE event_type = 'sent')::int                            AS sent,
          ROUND(100.0 * COUNT(*) FILTER (WHERE event_type IN ('reply','lead','positive_reply'))
                / NULLIF(COUNT(*) FILTER (WHERE event_type = 'sent'), 0), 2)          AS reply_rate_pct
        FROM email_events
        WHERE event_at > NOW() - INTERVAL '90 days'
        GROUP BY 1, 2 ORDER BY 1, 2
      `),
      pgdb.query(`
        SELECT
          EXTRACT(DOW FROM event_at AT TIME ZONE 'Europe/London')::int AS day_of_week,
          COUNT(*) FILTER (WHERE event_type IN ('reply','lead','positive_reply'))::int AS replies,
          COUNT(*) FILTER (WHERE event_type = 'sent')::int                            AS sent,
          ROUND(100.0 * COUNT(*) FILTER (WHERE event_type IN ('reply','lead','positive_reply'))
                / NULLIF(COUNT(*) FILTER (WHERE event_type = 'sent'), 0), 2)          AS reply_rate_pct
        FROM email_events
        WHERE event_at > NOW() - INTERVAL '90 days'
        GROUP BY 1 ORDER BY 1
      `),
    ]);
    res.json({ coverage: coverage.rows, hourly: hourly.rows, daily: daily.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/database/stats', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
  const { rows: [r] } = await pgdb.query(`
    WITH email_agg AS (
      SELECT
        MAX(NULLIF(keywords,  '')) AS max_keywords,
        MAX(NULLIF(industry,  '')) AS max_industry,
        MAX(num_employees)         AS max_employees,
        MAX(NULLIF(city,      '')) AS max_city
      FROM contacts
      GROUP BY email
    ),
    domain_agg AS (
      SELECT
        MAX(NULLIF(keywords,  '')) AS max_keywords,
        MAX(NULLIF(industry,  '')) AS max_industry,
        MAX(num_employees)         AS max_employees,
        MAX(NULLIF(city,      '')) AS max_city
      FROM contacts
      WHERE company_domain IS NOT NULL AND company_domain != ''
      GROUP BY company_domain
    )
    SELECT
      (SELECT COUNT(*)                               FROM email_agg)                       AS total,
      (SELECT COUNT(*) FILTER (WHERE max_keywords  IS NULL) FROM email_agg)               AS missing_keywords,
      (SELECT COUNT(*) FILTER (WHERE max_industry  IS NULL) FROM email_agg)               AS missing_industry,
      (SELECT COUNT(*) FILTER (WHERE max_employees IS NULL) FROM email_agg)               AS missing_num_employees,
      (SELECT COUNT(*) FILTER (WHERE max_city      IS NULL) FROM email_agg)               AS missing_city,
      (SELECT COUNT(*)                               FROM domain_agg)                     AS total_domains,
      (SELECT COUNT(*) FILTER (WHERE max_keywords  IS NOT NULL) FROM domain_agg)          AS domains_with_keywords,
      (SELECT COUNT(*) FILTER (WHERE max_industry  IS NOT NULL) FROM domain_agg)          AS domains_with_industry,
      (SELECT COUNT(*) FILTER (WHERE max_employees IS NOT NULL) FROM domain_agg)          AS domains_with_employees,
      (SELECT COUNT(*) FILTER (WHERE max_city      IS NOT NULL) FROM domain_agg)          AS domains_with_city
  `);
  res.json(r);
});

app.get('/api/admin/database/workspaces', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
  const { rows } = await pgdb.query(`SELECT workspace_id AS id, workspace_id AS name FROM contacts GROUP BY workspace_id ORDER BY workspace_id`);
  res.json({ workspaces: rows });
});

app.get('/api/admin/database/contacts', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });

  const { page = 0, limit = 200, sortBy = 'imported_at', sortDir = 'desc', q = '', workspace = '', source = '', missing = '', export: doExport } = req.query;

  const ALLOWED_SORT = ['email','first_name','last_name','company_name','company_domain','job_title','industry','num_employees','keywords','city','country','email_status','source','imported_at','created_at','updated_at','enriched_at'];
  const safeSortBy  = ALLOWED_SORT.includes(sortBy) ? sortBy : 'imported_at';
  const safeSortDir = sortDir === 'asc' ? 'ASC' : 'DESC';

  const params = [];
  const where = [];

  if (workspace) { params.push(workspace); where.push(`workspace_id = $${params.length}`); }
  if (source)    { params.push(source);    where.push(`source = $${params.length}`); }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(LOWER(email) LIKE $${params.length} OR LOWER(company_name) LIKE $${params.length} OR LOWER(first_name) LIKE $${params.length} OR LOWER(last_name) LIKE $${params.length})`);
  }
  if (missing) {
    for (const f of missing.split(',')) {
      if (f === 'keywords')        where.push(`(keywords IS NULL OR keywords = '')`);
      if (f === 'industry')        where.push(`(industry IS NULL OR industry = '')`);
      if (f === 'num_employees')   where.push(`num_employees IS NULL`);
      if (f === 'city')            where.push(`(city IS NULL OR city = '')`);
      if (f === 'technologies')    where.push(`(technologies IS NULL OR technologies = '')`);
      if (f === 'linkedin_url')    where.push(`(linkedin_url IS NULL OR linkedin_url = '')`);
      if (f === 'company_status')  where.push(`company_status IS NULL`);
      if (f === 'ch_company_number') where.push(`ch_company_number IS NULL`);
      if (f === 'ch_founded_year') where.push(`ch_founded_year IS NULL`);
      if (f === 'ch_postcode')     where.push(`ch_postcode IS NULL`);
      if (f === 'not_active')      where.push(`company_status = 'not active'`);
      if (f === 'ch_insolvency')   where.push(`ch_has_insolvency = true`);
      if (f === 'ch_overdue')      where.push(`ch_accounts_overdue = true`);
    }
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  if (doExport === '1') {
    const { rows } = await pgdb.query(
      `SELECT workspace_id,email,first_name,last_name,company_name,company_domain,job_title,industry,num_employees,keywords,technologies,company_status,city,state,country,email_status,source,imported_at,
              ch_company_number,ch_company_type,ch_founded_year,ch_postcode,ch_sic_codes,ch_jurisdiction,ch_has_insolvency,ch_has_charges,ch_accounts_overdue,ch_active_officers,ch_resigned_officers,ch_address,ch_date_of_cessation,ch_last_accounts_date,ch_year_end_month
       FROM contacts ${whereClause} ORDER BY ${safeSortBy} ${safeSortDir}`,
      params
    );
    const cols = ['workspace_id','email','first_name','last_name','company_name','company_domain','job_title','industry','num_employees','keywords','technologies','company_status','city','state','country','email_status','source','imported_at',
                  'ch_company_number','ch_company_type','ch_founded_year','ch_postcode','ch_sic_codes','ch_jurisdiction','ch_has_insolvency','ch_has_charges','ch_accounts_overdue','ch_active_officers','ch_resigned_officers','ch_address','ch_date_of_cessation','ch_last_accounts_date','ch_year_end_month'];
    const esc = v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`;
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts-export.csv"');
    return res.send(csv);
  }

  const offset = parseInt(page, 10) * parseInt(limit, 10);
  const safeLimit = Math.min(parseInt(limit, 10) || 200, 500);

  params.push(safeLimit, offset);
  const [{ rows: contacts }, { rows: [{ count }] }] = await Promise.all([
    pgdb.query(`SELECT id,workspace_id,email,first_name,last_name,company_name,company_domain,job_title,industry,num_employees,keywords,technologies,company_status,city,country,email_status,source,imported_at,enriched_at,ch_company_number,ch_company_type,ch_founded_year,ch_postcode,ch_sic_codes,ch_jurisdiction,ch_has_insolvency,ch_has_charges,ch_accounts_overdue,ch_active_officers,ch_resigned_officers,ch_address,ch_date_of_cessation,ch_last_accounts_date,ch_year_end_month FROM contacts ${whereClause} ORDER BY ${safeSortBy} ${safeSortDir} LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
    pgdb.query(`SELECT COUNT(*) AS count FROM contacts ${whereClause}`, params.slice(0, -2)),
  ]);

  res.json({ contacts, total: parseInt(count, 10) });
});

app.delete('/api/admin/database/contacts', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'DB unavailable' });
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
  if (ids.length > 500) return res.status(400).json({ error: 'Max 500 at a time' });
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const r = await pgdb.query(`DELETE FROM contacts WHERE id IN (${placeholders})`, ids);
  res.json({ deleted: r.rowCount });
});

// Manager-accessible partial update: notes + master exclusions only.
app.put('/api/clients/:id/notes-exclusions', requireSession, (req, res) => {
  const { notes, excluded_industries, excluded_company_sizes, excluded_keywords,
          excluded_counties, excluded_cities, excluded_job_titles } = req.body || {};
  const client = db.prepare('SELECT workspace_id, workspace_name FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  if (notes !== undefined) {
    db.prepare('UPDATE clients SET notes = ? WHERE id = ?').run(notes, req.params.id);
    req.app.locals.pgDb?.query(
      `INSERT INTO client_notes (workspace_id, notes, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (workspace_id) DO UPDATE SET notes = EXCLUDED.notes, updated_at = NOW()`,
      [client.workspace_id, notes]
    ).catch(err => console.error('[client notes] Postgres save failed:', err.message));
  }

  const norm = v => {
    if (!v) return '';
    const parts = String(v).split(',').map(s => s.trim()).filter(Boolean);
    return [...new Set(parts)].join(',');
  };
  db.prepare(`
    INSERT INTO client_verticals (workspace_id, workspace_name, excluded_industries, excluded_company_sizes,
      excluded_keywords, excluded_counties, excluded_cities, excluded_job_titles, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(workspace_id) DO UPDATE SET
      excluded_industries    = excluded.excluded_industries,
      excluded_company_sizes = excluded.excluded_company_sizes,
      excluded_keywords      = excluded.excluded_keywords,
      excluded_counties      = excluded.excluded_counties,
      excluded_cities        = excluded.excluded_cities,
      excluded_job_titles    = excluded.excluded_job_titles,
      updated_at             = datetime('now')
  `).run(client.workspace_id, client.workspace_name,
         norm(excluded_industries), norm(excluded_company_sizes), norm(excluded_keywords),
         norm(excluded_counties), norm(excluded_cities), norm(excluded_job_titles));

  res.json({ ok: true });
});

// ── Client Targeting Config API ──────────────────────────────────────────

app.get('/api/admin/client-verticals', requireSession, (req, res) => {
  const rows = db.prepare('SELECT * FROM client_verticals ORDER BY workspace_name').all();
  res.json({ verticals: rows });
});

// Session-protected read-only lookup — contacts page needs the master
// exclusion summary for the currently selected client so it can show
// counts ("🚫 3 industries, 2 cities") without exposing the admin route.
app.get('/api/client-rules/:workspace_id', requireSession, (req, res) => {
  const row = db.prepare('SELECT * FROM client_verticals WHERE workspace_id = ?').get(req.params.workspace_id);
  if (!row) return res.json({ rules: null });
  res.json({ rules: row });
});

app.post('/api/admin/client-verticals', requireAdmin, (req, res) => {
  const {
    workspace_id, workspace_name, vertical, exclude_remote, require_owns_building, snooze_months, notes,
    excluded_industries, excluded_company_sizes, excluded_keywords,
    excluded_counties, excluded_cities, excluded_job_titles,
  } = req.body;
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
  // Normalize comma-separated lists — trim each entry, drop empties,
  // dedupe while preserving order. Stored canonically so the search
  // path can split on ',' without re-trimming on every row.
  const norm = v => {
    if (!v) return '';
    const parts = String(v).split(',').map(s => s.trim()).filter(Boolean);
    return [...new Set(parts)].join(',');
  };
  db.prepare(`
    INSERT INTO client_verticals (
      workspace_id, workspace_name, vertical, exclude_remote, require_owns_building,
      snooze_months, notes,
      excluded_industries, excluded_company_sizes, excluded_keywords,
      excluded_counties, excluded_cities, excluded_job_titles,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(workspace_id) DO UPDATE SET
      workspace_name=excluded.workspace_name, vertical=excluded.vertical,
      exclude_remote=excluded.exclude_remote, require_owns_building=excluded.require_owns_building,
      snooze_months=excluded.snooze_months, notes=excluded.notes,
      excluded_industries=excluded.excluded_industries,
      excluded_company_sizes=excluded.excluded_company_sizes,
      excluded_keywords=excluded.excluded_keywords,
      excluded_counties=excluded.excluded_counties,
      excluded_cities=excluded.excluded_cities,
      excluded_job_titles=excluded.excluded_job_titles,
      updated_at=datetime('now')
  `).run(
    workspace_id, workspace_name || '', vertical || '', exclude_remote ? 1 : 0, require_owns_building ? 1 : 0,
    snooze_months || 6, notes || '',
    norm(excluded_industries), norm(excluded_company_sizes), norm(excluded_keywords),
    norm(excluded_counties), norm(excluded_cities), norm(excluded_job_titles),
  );
  res.json({ ok: true });
});

// ── Webhook Events API ────────────────────────────────────────────────────

app.get('/api/admin/webhook-events', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50'), 200);
  const rows = db.prepare('SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?').all(limit);
  res.json({ events: rows.map(r => ({ ...r, payload: JSON.parse(r.payload || '{}') })) });
});

// ── PlusVibe Reply Webhook ────────────────────────────────────────────────
// Set this URL in PlusVibe → Settings → Webhooks → Reply event
// URL: https://your-domain/webhook/plusvibe-reply

function parseReplyIntelligence(replyText, campaignName, workspaceName) {
  const text = (replyText || '').toLowerCase();
  const campaign = (campaignName || '').toLowerCase();
  const workspace = (workspaceName || '').toLowerCase();
  const updates = {};
  const notes = [];

  // Detect remote worker
  if (/\b(remote|work from home|wfh|working remotely|home office|fully remote|hybrid)\b/.test(text)) {
    updates.works_remote = true;
    notes.push('Works remote (detected from reply)');
  }

  // Detect building ownership — check NO first so "we don't own our building"
  // doesn't accidentally match the ownership patterns (own our / our building).
  if (/\b(we rent|we lease|renting|rented|leasing|leased|lease|tenants?|landlord|don.t own|doesn.t own|do not own|not the owner|not our building|not our premises|not our property)\b/.test(text)) {
    updates.owns_building = 'no';
    notes.push('Does not own building (detected from reply)');
  } else if (/\b(we own|own the building|freehold)\b/.test(text)) {
    updates.owns_building = 'yes';
    notes.push('Owns building (detected from reply)');
  }

  // Detect do-not-contact
  if (/\b(unsubscribe|remove me|stop emailing|do not contact|opt out|not interested at all|please remove)\b/.test(text)) {
    updates.do_not_contact = true;
    notes.push('Do not contact (reply request)');
  }

  // Detect "I no longer work here" — recipient has left the company.
  // Mailbox is DNC'd globally (cross-vertical) — even if a different
  // vertical pitches this person, they're not at this email anymore.
  const leftCompanyPatterns = [
    /\bno longer (work|works|working|with|at|employed|here|there)\b/,
    /\bdon'?t work (here|there)\b/,
    /\bi'?(ve| have) left (the company|the firm|this (company|firm|role|organi[sz]ation))\b/,
    /\bi (have )?left (the company|the firm|this (company|firm|role))\b/,
    /\b(has|have) left (the company|the firm|us)\b/,
    /\bmoved on (to|from)\b/,
    /\bnew role (at|with)\b/,
    /\bex.employee\b/,
    /\bformer employee\b/,
    /\bi'?(ve| have) retired\b/,
    /\bi (have )?retired\b/,
    /\bthis (?:mailbox|inbox|e.?mail(?: address)?|address) is (?:no longer|not(?: being)?) (?:monitored|active|in use|checked)\b/,
  ];
  if (leftCompanyPatterns.some(r => r.test(text))) {
    updates._leftCompany = true;
    updates.do_not_contact = true;
    notes.push('Recipient no longer at company — global DNC');
  }

  // Detect "company has closed down" — whole company is gone.
  // Fan out DNC to every contact sharing this domain (handled in
  // processWebhookEvent), cross-vertical.
  const companyClosedPatterns = [
    /\b(closed|shut) down\b/,
    /\bpermanently closed\b/,
    /\bceased (trading|operations|to (trade|operate))\b/,
    /\b(gone|went) (out of business|bust)\b/,
    /\bout of business\b/,
    /\bin (administration|liquidation|receivership)\b/,
    /\bwound up\b/,
    /\b(company|business|firm) (has been |was |is )?dissolved\b/,
    /\b(company|business|firm) (has |is )?folded\b/,
    /\bno longer (in business|trading|operating)\b/,
  ];
  if (companyClosedPatterns.some(r => r.test(text))) {
    updates._companyClosed = true;
    updates.do_not_contact = true;
    notes.push('Company closed — domain-wide DNC');
  }

  // Detect vertical snooze — only fires when the reply makes clear the
  // vertical's service is already taken care of. Generic 'not looking' /
  // 'not right now' / 'don't need' phrases used to qualify here too and
  // were producing false snoozes — those just mean 'not interested
  // today', not 'already have a provider for this'.
  const vertical = detectVertical(campaign + ' ' + workspace);
  const snoozeTriggers = /\b(already (have|use|using|got|work(ing)? with|covered|sorted)|got (someone|a (guy|girl|team|provider|partner|agency|accountant|supplier|company))|have (someone|a (guy|girl|team|provider|partner|agency|accountant|supplier|company))|all (sorted|covered|taken care of)|we.?re sorted|taken care of|in.?house( team)?|internal team|do(es)? it (ourselves|in.?house|internally)|use(s|d)? (an?|our) (existing|current|in.?house))\b/.test(text);

  if (snoozeTriggers && vertical) {
    const months = 6; // default snooze 6 months
    const until = new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    updates._snoozeVertical = { vertical, until, reason: replyText.slice(0, 200) };
    notes.push(`Snoozed for "${vertical}" until ${until}`);
  }

  updates.reply_notes = notes.join(' · ') || null;
  updates.last_reply_at = new Date().toISOString();
  return updates;
}

function detectVertical(text, workspaceId) {
  // Check manually configured vertical first
  if (workspaceId && db) {
    const row = db.prepare('SELECT vertical FROM client_verticals WHERE workspace_id = ?').get(workspaceId);
    if (row?.vertical) return row.vertical;
  }
  // Auto-detect from name
  const t = (text || '').toLowerCase();
  if (/solar|energy|renewable|panels/.test(t)) return 'solar';
  if (/office|furniture|fitout|fit.out|workspace|interior/.test(t)) return 'office_furniture';
  if (/accounting|accountant|bookkeeping|tax|finance/.test(t)) return 'accounting';
  if (/recruitment|staffing|hiring|talent/.test(t)) return 'recruitment';
  if (/marketing|seo|digital|advertising/.test(t)) return 'marketing';
  if (/insurance/.test(t)) return 'insurance';
  if (/cleaning|janitorial/.test(t)) return 'cleaning';
  if (/flooring|carpet|tiles/.test(t)) return 'flooring';
  return null;
}

// Get full targeting rules for a workspace (manual config overrides auto-detect)
function getClientRules(workspaceId, workspaceName) {
  if (workspaceId && db) {
    const row = db.prepare('SELECT * FROM client_verticals WHERE workspace_id = ?').get(workspaceId);
    if (row) return row;
  }
  const vertical = detectVertical(workspaceName || '');
  return {
    vertical,
    exclude_remote: vertical === 'office_furniture' ? 1 : 0,
    require_owns_building: (vertical === 'solar' || vertical === 'flooring') ? 1 : 0,
    snooze_months: 6
  };
}

// ── Client Health analytics helpers ──────────────────────────────────────

// Bucket recipient email by provider so we can split reply rates Gmail vs
// Microsoft vs Yahoo etc. — the single most useful signal for diagnosing
// provider-specific filtering ("Gmail tanked but Outlook held"). Anything
// not in the well-known list is bucketed as 'workspace' (treating it as a
// custom-domain mailbox, most often Google Workspace or O365).
function providerBucketForEmail(email) {
  const domain = String(email || '').toLowerCase().split('@')[1] || '';
  if (!domain) return 'unknown';
  if (/^gmail\.com$|^googlemail\./.test(domain)) return 'gmail';
  if (/^(outlook|hotmail|live|msn)\.com$/.test(domain)) return 'outlook';
  if (/^(yahoo|ymail|rocketmail)\.com$/.test(domain)) return 'yahoo';
  if (/^aol\.com$/.test(domain)) return 'aol';
  if (/^(icloud|me|mac)\.com$/.test(domain)) return 'icloud';
  if (/^(proton|protonmail|pm)\.me$|^protonmail\.com$/.test(domain)) return 'proton';
  return 'workspace'; // business domain — needs MX lookup to classify properly
}

// MX-based provider classification for business domains.
// Cache keyed by domain; TTL 24h. Returns email_google / email_outlook / email_other.
const _mxProviderCache = new Map(); // domain → { provider, at }
const MX_PROVIDER_TTL  = 24 * 60 * 60 * 1000;

async function lookupMxProvider(domain) {
  if (!domain) return 'email_other';
  const hit = _mxProviderCache.get(domain);
  if (hit && Date.now() - hit.at < MX_PROVIDER_TTL) return hit.provider;
  try {
    const records = await dnsPromises.resolveMx(domain);
    const top = (records.sort((a, b) => a.priority - b.priority)[0]?.exchange || '').toLowerCase();
    const provider = /google|gmail/.test(top)   ? 'email_google'
      : /outlook|microsoft|protection\.outlook/.test(top) ? 'email_outlook'
      : 'email_other';
    _mxProviderCache.set(domain, { provider, at: Date.now() });
    return provider;
  } catch {
    _mxProviderCache.set(domain, { provider: 'email_other', at: Date.now() });
    return 'email_other';
  }
}

// Background job: classify/enrich email_events rows that lack a useful provider_bucket.
// Pass 1: rows with provider_bucket IS NULL — do full classification (personal domain check
//         then MX lookup). Even setting 'workspace' or 'email_other' is better than NULL
//         since NULL shows as "Unknown" in the combo analysis.
// Pass 2: rows with provider_bucket = 'workspace' — MX lookup to distinguish Google WS
//         vs Microsoft 365 vs other.
async function enrichWorkspaceBuckets() {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return;
  try {
    // --- Pass 0: bulk-classify from PlusVibe's mx field already in raw ---
    // PlusVibe webhooks include lead.mx (e.g. "GOOGLE_WORKSPACE", "OUTLOOK").
    // For every event with that field, we can skip the DNS lookup entirely.
    // Batched by id to stay under the 45s statement_timeout.
    try {
      let pvTotal = 0;
      for (let i = 0; i < 50; i++) {
        const r = await pgdb.query(`
          UPDATE email_events ee
          SET provider_bucket = sub.new_bucket
          FROM (
            SELECT id, CASE
              WHEN UPPER(COALESCE(raw->'lead'->>'mx', raw->>'mx', raw->'lead_data'->>'mx')) ~ 'GOOGLE|GMAIL' THEN 'google'
              WHEN UPPER(COALESCE(raw->'lead'->>'mx', raw->>'mx', raw->'lead_data'->>'mx')) ~ 'OUTLOOK|MICROSOFT|OFFICE|M365|MS365|EXCHANGE' THEN 'outlook'
              ELSE 'email_other'
            END AS new_bucket
            FROM email_events
            WHERE (provider_bucket IS NULL OR provider_bucket = 'workspace')
              AND COALESCE(raw->'lead'->>'mx', raw->>'mx', raw->'lead_data'->>'mx') IS NOT NULL
              AND COALESCE(raw->'lead'->>'mx', raw->>'mx', raw->'lead_data'->>'mx') <> ''
            LIMIT 20000
          ) sub
          WHERE ee.id = sub.id
        `);
        const n = r.rowCount || 0;
        pvTotal += n;
        if (n < 20000) break;
      }
      if (pvTotal) console.log(`[enrichBuckets] pass 0 (PV mx field) — ${pvTotal} event(s) reclassified`);
    } catch (err) {
      console.warn('[enrichBuckets] pass 0 failed:', err.message);
    }

    // --- Pass 1: classify NULL provider_bucket rows ---
    const { rows: nullRows } = await pgdb.query(
      `SELECT DISTINCT recipient_domain FROM email_events
        WHERE provider_bucket IS NULL AND recipient_domain IS NOT NULL
        LIMIT 8000`
    );
    if (nullRows.length) {
      console.log(`[enrichBuckets] classifying ${nullRows.length} unclassified domains…`);
      let nullUpdated = 0;
      for (const { recipient_domain: domain } of nullRows) {
        let bucket = providerBucketForEmail('x@' + domain);
        if (bucket === 'workspace') bucket = await lookupMxProvider(domain);
        // Map lookupMxProvider result back to storage bucket names
        if (bucket === 'email_google')  bucket = 'google';
        if (bucket === 'email_outlook') bucket = 'outlook';
        if (bucket === 'email_other')   bucket = 'workspace'; // still a business domain
        await pgdb.query(
          `UPDATE email_events SET provider_bucket=$1 WHERE recipient_domain=$2 AND provider_bucket IS NULL`,
          [bucket, domain]
        );
        nullUpdated++;
        await new Promise(r => setTimeout(r, 40));
      }
      console.log(`[enrichBuckets] pass 1 done — classified ${nullUpdated} domain(s)`);
    }

    // --- Pass 2: MX-upgrade workspace rows to google/outlook ---
    const { rows } = await pgdb.query(
      `SELECT DISTINCT recipient_domain FROM email_events
        WHERE provider_bucket = 'workspace' AND recipient_domain IS NOT NULL
        LIMIT 8000`
    );
    if (!rows.length) return;
    console.log(`[enrichBuckets] MX lookup for ${rows.length} workspace domains…`);
    let updated = 0;
    for (const { recipient_domain: domain } of rows) {
      const provider = await lookupMxProvider(domain);
      if (provider === 'email_google' || provider === 'email_outlook') {
        const bucket = provider === 'email_google' ? 'google' : 'outlook';
        await pgdb.query(
          `UPDATE email_events SET provider_bucket=$1 WHERE recipient_domain=$2 AND provider_bucket='workspace'`,
          [bucket, domain]
        );
        updated++;
      } else {
        // Confirmed non-Google/non-Microsoft — mark as email_other so we don't re-process
        await pgdb.query(
          `UPDATE email_events SET provider_bucket='email_other' WHERE recipient_domain=$1 AND provider_bucket='workspace'`,
          [domain]
        );
      }
      await new Promise(r => setTimeout(r, 40)); // 25 lookups/sec max
    }
    console.log(`[enrichBuckets] pass 2 done — upgraded ${updated} domain(s) to google/outlook`);
  } catch (err) {
    console.warn('[enrichBuckets] failed:', err.message);
  }
}
setTimeout(enrichWorkspaceBuckets, 90_000);          // 90s after startup
setInterval(enrichWorkspaceBuckets, 6 * 60 * 60_000); // every 6h

// Normalize subject/body before hashing so trivial whitespace and merge-tag
// formatting differences don't fragment our template identity. Merge tags
// themselves stay in — different {first_name} positions are not 'the same
// content' as far as provider profiling is concerned.
function normalizeForHash(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .trim()
    .toLowerCase();
}

function contentHashFor(subject, body) {
  const norm = normalizeForHash(subject) + '' + normalizeForHash(body);
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 32);
}

function subjectHashFor(subject) {
  return crypto.createHash('sha256').update(normalizeForHash(subject)).digest('hex').slice(0, 32);
}

// Map PlusVibe webhook_event values to our compact event_type column.
// We split EMAIL_REPLIED into 'reply' vs 'positive_reply' vs 'ooo' when the
// payload tells us which (PV exposes these as separate webhook events too).
function normalizeEventType(rawType) {
  const t = String(rawType || '').toUpperCase();
  if (/EMAIL_SENT|SENT/.test(t) && !/REPLY|BOUNCE/.test(t)) return 'sent';
  if (/POS(ITIVE)?_?REPLY|INTERESTED/.test(t))               return 'positive_reply';
  if (/OOO|OUT_OF_OFFICE|AUTO_?REPLY/.test(t))               return 'ooo';
  if (/LEAD|INTERESTED/.test(t))                              return 'lead';
  if (/REPLY|REPLIED/.test(t))                                return 'reply';
  if (/BOUNCE/.test(t))                                       return 'bounce';
  if (/UNSUBSCRIBE/.test(t))                                  return 'unsubscribe';
  if (/COMPLAINT|SPAM/.test(t))                               return 'complaint';
  return String(rawType || 'unknown').toLowerCase();
}

// Best-effort extraction of step/variant from the webhook payload. PV
// names these inconsistently between event types, so we try a handful of
// plausible field paths. Returns nulls when we genuinely don't know —
// downstream code treats null step as 'unknown step' and still records
// the event so we don't silently lose data.
function extractCampaignMeta(body) {
  const campaign_id   = body?.campaign?.id || body?.campaign_id || body?.camp_id || body?.campaignId || null;
  const campaign_name = body?.campaign?.name || body?.campaign_name || body?.camp_name || null;
  const workspace_id  = body?.workspace?.id || body?.workspace_id || body?.workspaceId || null;
  const step          = body?.step ?? body?.sequence_step ?? body?.email?.step ?? body?.sequence?.step ?? null;
  const variant       = body?.variant || body?.variant_label || body?.email?.variant || 'A';
  return { campaign_id, campaign_name, workspace_id, step: step != null ? parseInt(step, 10) || null : null, variant: String(variant || 'A') };
}

// Fire-and-forget event recorder — called from processWebhookEvent. Failures
// here MUST NOT throw, because the SQLite webhook_events row is deleted on
// successful processing; we don't want analytics misses to stall the live
// path.
// Map PlusVibe's mx field (e.g. "GOOGLE_WORKSPACE", "OUTLOOK", "OFFICE_365")
// to our internal provider_bucket. Returns null when mx is missing/unrecognised
// so callers can fall back to other classification (DNS lookup, domain pattern).
function pvMxToBucket(mx) {
  const m = String(mx || '').toUpperCase();
  if (!m) return null;
  if (/GOOGLE|GMAIL/.test(m))                                    return 'google';
  if (/OUTLOOK|MICROSOFT|OFFICE|M365|MS365|EXCHANGE/.test(m))    return 'outlook';
  return 'email_other';
}

async function recordEmailEvent(body, rawEventType, email) {
  try {
    const pgdb = app.locals.pgDb;
    if (!pgdb) return;
    const meta = extractCampaignMeta(body);
    const eventType = normalizeEventType(rawEventType);
    const domain = String(email || '').toLowerCase().split('@')[1] || null;
    let bucket = providerBucketForEmail(email);
    // Business-domain recipient — try PlusVibe's mx field first (instant,
    // already in the webhook payload), fall back to DNS only if absent.
    if (bucket === 'workspace') {
      const pvMx = body?.lead?.mx || body?.mx || body?.lead_data?.mx;
      const pvBucket = pvMxToBucket(pvMx);
      if (pvBucket) bucket = pvBucket;
      else if (domain) bucket = await lookupMxProvider(domain);
    }
    // Extract sending mailbox email — PlusVibe includes it under several possible fields
    const senderEmail = (
      body?.email_account?.email ||
      body?.email_account_name ||
      body?.from_email ||
      body?.sender?.email ||
      body?.emailAccount?.email ||
      null
    )?.toLowerCase() || null;

    // Try to resolve a known content_hash via campaign_templates so we can
    // bind this event to its current template content. Captured lazily —
    // when the campaign-content sync hasn't run yet, we still record the
    // event (just without a hash) and can join later via campaign_id+step.
    let contentHash = null;
    if (meta.workspace_id && meta.campaign_id && meta.step != null) {
      try {
        const r = await pgdb.query(
          `SELECT content_hash FROM campaign_templates
            WHERE workspace_id=$1 AND campaign_id=$2 AND step=$3 AND variant=$4
            LIMIT 1`,
          [meta.workspace_id, meta.campaign_id, meta.step, meta.variant]
        );
        contentHash = r.rows[0]?.content_hash || null;
      } catch { /* table not ready yet on first deploy */ }
    }

    await pgdb.query(
      `INSERT INTO email_events
         (workspace_id, campaign_id, campaign_name, step, variant,
          lead_email, recipient_domain, provider_bucket,
          event_type, content_hash, sender_email, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        meta.workspace_id, meta.campaign_id, meta.campaign_name, meta.step, meta.variant,
        (email || '').toLowerCase() || null, domain, bucket,
        eventType, contentHash, senderEmail, JSON.stringify(body || {}),
      ]
    );
  } catch (err) {
    // Don't blow up the webhook on analytics misses — log and move on.
    console.warn('[email_events] insert failed (non-fatal):', err.message);
  }
}

// Walk a PlusVibe campaign's sequences and capture each (step, variant)'s
// subject+body into the templates/campaign_templates tables. Idempotent —
// safe to call on every refresh. Cheap: one INSERT…ON CONFLICT per variant.
async function captureCampaignTemplates(workspaceId, campaign) {
  const pgdb = app.locals.pgDb;
  if (!pgdb || !workspaceId || !campaign?.id) return;
  const campaignId = campaign.id;
  const campaignName = campaign.camp_name || campaign.name || '';
  // PlusVibe campaign statuses: 'ACTIVE', 'PAUSED', 'DRAFT', 'COMPLETED', etc.
  // active flag = TRUE only when the campaign is actually sending.
  const rawStatus = String(campaign.status || '').toLowerCase();
  const isActive = rawStatus === 'active' || rawStatus === 'running' || rawStatus === 'started' || rawStatus === '1';

  // Migration: add campaign_status column if missing. Cheap noop after first run.
  try {
    await pgdb.query(`ALTER TABLE campaign_templates ADD COLUMN IF NOT EXISTS campaign_status TEXT`);
  } catch {}

  // ALWAYS sync status, and force every variant INACTIVE when the campaign
  // isn't sending (paused/draft/completed) — even when sequences is empty,
  // which is how those campaigns often come back. We AND the existing flag
  // with the campaign state so this can only turn variants OFF, never on:
  // turning a variant ON is the per-variant loop's job (it honours the
  // variant's own is_active toggle). A blanket `active = isActive` here would
  // wrongly re-activate disabled A/B variants of an active campaign.
  try {
    await pgdb.query(
      `UPDATE campaign_templates
          SET active = (active AND $3), campaign_status = $4
        WHERE workspace_id = $1 AND campaign_id = $2`,
      [workspaceId, campaignId, isActive, rawStatus || null]
    );
  } catch { /* table not ready */ }

  const sequences = Array.isArray(campaign.sequences) ? campaign.sequences : [];
  if (!sequences.length) return;

  for (const seq of sequences) {
    const step = seq.seq_number || seq.step || seq.sequence_number || 1;
    const variants = Array.isArray(seq.variants) ? seq.variants
                    : Array.isArray(seq.variations) ? seq.variations
                    : (seq.subject || seq.body) ? [{ variation: 'A', subject: seq.subject, body: seq.body }] : [];

    for (const v of variants) {
      const variant = String(v.variation || v.variant || v.label || 'A');
      const subject = v.subject || v.email_subject || '';
      const body    = v.body || v.email_body || v.content || '';
      if (!subject && !body) continue;

      // A template is genuinely "active" only when the campaign is sending AND
      // this specific variant's toggle is on. PlusVibe exposes the per-variant
      // toggle as v.is_active (missing = on, matching the convention elsewhere).
      // Without this, disabled A/B variants inherited the campaign flag and
      // wrongly showed "Active" on the Copy page.
      const variantActive = isActive && v.is_active !== false;

      const contentHash = contentHashFor(subject, body);
      const subjectHash = subjectHashFor(subject);
      const excerpt = String(body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);

      try {
        await pgdb.query(
          `INSERT INTO templates (content_hash, subject_hash, subject, body, body_excerpt, last_seen)
           VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)
           ON CONFLICT (content_hash) DO UPDATE SET
             last_seen = CURRENT_TIMESTAMP,
             subject = EXCLUDED.subject,
             body = EXCLUDED.body,
             body_excerpt = EXCLUDED.body_excerpt`,
          [contentHash, subjectHash, subject, body, excerpt]
        );
        await pgdb.query(
          `INSERT INTO campaign_templates
             (workspace_id, campaign_id, campaign_name, step, variant, content_hash, active, campaign_status, captured_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
           ON CONFLICT (workspace_id, campaign_id, step, variant) DO UPDATE SET
             campaign_name   = EXCLUDED.campaign_name,
             content_hash    = EXCLUDED.content_hash,
             active          = EXCLUDED.active,
             campaign_status = EXCLUDED.campaign_status`,
          // captured_at is intentionally NOT updated on conflict — it must stay
          // the first time we ever saw this row so "Running since" is accurate.
          // (No last_captured_at column: adding one needs an AccessExclusive
          // lock that times out against the constant writes to this table.)
          [workspaceId, campaignId, campaignName, step, variant, contentHash, variantActive, rawStatus || null]
        );
      } catch (err) {
        console.warn('[templates] upsert failed:', err.message);
      }
    }
  }
}

// Pull per-step/per-variant stats from PlusVibe and store. This is the only
// reliable way to attribute sent/reply counts to a specific step, because
// the webhook payloads for sent and reply events don't include the step
// field.
async function captureVariationStats(workspaceId, campaignId) {
  const pgdb = app.locals.pgDb;
  if (!pgdb || !workspaceId || !campaignId) return 0;
  // Self-heal: ensure tables exist before any upsert. Cheap noop after first
  // successful create.
  try {
    await pgdb.query(`
      CREATE TABLE IF NOT EXISTS campaign_variant_stats (
        workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
        step INT NOT NULL, variant TEXT NOT NULL DEFAULT 'A',
        sent INT DEFAULT 0, reply INT DEFAULT 0, bounce INT DEFAULT 0, opened INT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workspace_id, campaign_id, step, variant)
      )
    `);
    await pgdb.query(`
      CREATE TABLE IF NOT EXISTS campaign_variant_stats_snapshots (
        workspace_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
        step INT NOT NULL, variant TEXT NOT NULL DEFAULT 'A',
        snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
        sent INT DEFAULT 0, reply INT DEFAULT 0, bounce INT DEFAULT 0, opened INT DEFAULT 0,
        snapshot_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workspace_id, campaign_id, step, variant, snapshot_date)
      )
    `);
  } catch {}
  let stored = 0;
  try {
    var vstats = { data: [], steps: [] }; // A/B variant stats not available in EmailBison
    if (!Array.isArray(vstats)) return 0;
    for (const st of vstats) {
      const step = parseInt(st.step ?? st.seq_number ?? 1, 10) || 1;
      const variations = Array.isArray(st.variations) ? st.variations : Array.isArray(st.variants) ? st.variants : [];
      for (const v of variations) {
        const variant = String(v.variation || v.variant || v.label || 'A');
        const sent_   = parseInt(v.sent   || 0, 10) || 0;
        const reply_  = parseInt(v.reply  || 0, 10) || 0;
        const bounce_ = parseInt(v.bounce || 0, 10) || 0;
        const opened_ = parseInt(v.opened || 0, 10) || 0;
        try {
          await pgdb.query(
            `INSERT INTO campaign_variant_stats
               (workspace_id, campaign_id, step, variant, sent, reply, bounce, opened, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
             ON CONFLICT (workspace_id, campaign_id, step, variant) DO UPDATE SET
               sent       = EXCLUDED.sent,
               reply      = EXCLUDED.reply,
               bounce     = EXCLUDED.bounce,
               opened     = EXCLUDED.opened,
               updated_at = CURRENT_TIMESTAMP`,
            [workspaceId, campaignId, step, variant, sent_, reply_, bounce_, opened_]
          );
          // Daily snapshot — one row per day per variant. Subsequent runs
          // the same day update the snapshot to the latest values so the
          // 7d-ago comparison stays anchored to "yesterday's eod" rather
          // than "first sync of today".
          await pgdb.query(
            `INSERT INTO campaign_variant_stats_snapshots
               (workspace_id, campaign_id, step, variant, snapshot_date, sent, reply, bounce, opened, snapshot_at)
             VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$8,CURRENT_TIMESTAMP)
             ON CONFLICT (workspace_id, campaign_id, step, variant, snapshot_date) DO UPDATE SET
               sent        = EXCLUDED.sent,
               reply       = EXCLUDED.reply,
               bounce      = EXCLUDED.bounce,
               opened      = EXCLUDED.opened,
               snapshot_at = CURRENT_TIMESTAMP`,
            [workspaceId, campaignId, step, variant, sent_, reply_, bounce_, opened_]
          );
          stored++;
        } catch (err) {
          console.warn('[variant-stats] upsert failed:', err.message);
        }
      }
    }
  } catch (err) {
    console.warn('[variant-stats] fetch failed:', campaignId, err.message);
  }
  return stored;
}

// Backfill content_hash on email_events that arrived before the matching
// campaign_template row existed. Runs after a template sync so newly-known
// hashes get attached to historical events.
async function backfillEmailEventHashes() {
  const pgdb = app.locals.pgDb;
  if (!pgdb) return;
  try {
    const r = await pgdb.query(`
      UPDATE email_events ee
         SET content_hash = ct.content_hash
        FROM campaign_templates ct
       WHERE ee.content_hash IS NULL
         AND ee.workspace_id = ct.workspace_id
         AND ee.campaign_id  = ct.campaign_id
         AND ee.step         = ct.step
         AND COALESCE(ee.variant,'A') = ct.variant
    `);
    if (r.rowCount > 0) console.log(`[email_events] backfilled content_hash on ${r.rowCount} rows`);
  } catch (err) {
    console.warn('[email_events] backfill failed:', err.message);
  }
}

// Sync webhook event to shared esp_leads table (for client portal)
async function syncToEspLeads(body, eventType, email, dbPg) {
  try {
    const leadId = body?.lead?.id || body?.lead_id || '';
    const workspaceId = body?.workspace?.id || body?.workspace_id || '';
    const campaignId = body?.campaign?.id || body?.campaign_id || '';
    if (!leadId || !workspaceId || !dbPg) return;

    const now = new Date().toISOString();

    // Determine what to update based on event type
    if (/reply/i.test(eventType)) {
      // Mark as replied — use COALESCE to never overwrite existing first_replied_at
      await dbPg.query(`
        UPDATE esp_leads
        SET first_replied_at = COALESCE(first_replied_at, $1), updated_at = $2
        WHERE id = $3 AND workspace_id = $4
      `, [now, now, leadId, workspaceId]);

      // Store the real reply email into portal_emails so the client portal shows
      // the genuine conversation (not a fabricated one). Best-effort, idempotent.
      try {
        const html = body?.reply?.html || body?.html || body?.body_html || '';
        const text = body?.reply?.text || body?.message || body?.body || body?.content || body?.reply_text || '';
        const subject = body?.subject || body?.reply?.subject || body?.email_subject || '';
        const messageId = body?.message_id || body?.reply?.message_id || `wh-${leadId}-${Date.parse(now)}`;
        const threadId = body?.thread_id || body?.reply?.thread_id || null;
        const eaccount = body?.email_account || body?.eaccount || body?.workspace?.email || null;
        if (text || html) {
          await dbPg.query(`
            INSERT INTO portal_emails (
              id, workspace_id, lead_pv_id, lead_email, thread_id, campaign_id, direction,
              subject, body_html, body_text, content_preview, from_email, to_email, eaccount,
              pv_label, is_unread, message_id, timestamp_created, raw
            ) VALUES ($1,$2,$3,$4,$5,$6,'IN',$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,$17)
            ON CONFLICT (id) DO NOTHING
          `, [
            messageId, workspaceId, leadId, String(email).toLowerCase(), threadId, campaignId,
            subject, html, text, (text || '').slice(0, 200), String(email).toLowerCase(),
            eaccount, eaccount, 'INTERESTED', messageId, now, JSON.stringify(body),
          ]);
        }
      } catch (e) {
        console.warn(`[Webhook] portal_emails insert failed: ${e.message}`);
      }
    } else if (/lead/i.test(eventType)) {
      // Mark lead status
      await dbPg.query(`
        UPDATE esp_leads
        SET status = COALESCE(status, 'INTERESTED'), updated_at = $1
        WHERE id = $2 AND workspace_id = $3
      `, [now, leadId, workspaceId]);
    } else if (/sent|email.sent/i.test(eventType) && !/reply|bounce|lead/i.test(eventType)) {
      // Just mark updated_at to show we synced
      await dbPg.query(`
        UPDATE esp_leads SET updated_at = $1 WHERE id = $2 AND workspace_id = $3
      `, [now, leadId, workspaceId]);
    }

    console.log(`[Webhook] Synced to esp_leads: ${eventType} for lead ${leadId}`);
  } catch (err) {
    // Non-fatal — log but don't throw, so webhook processing continues
    console.warn(`[Webhook] esp_leads sync error: ${err.message}`);
  }
}

// Process a single stored webhook event against the DB
async function processWebhookEvent(event) {
  try {
    const body = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    // Same precedence the inbound handler uses — webhook_event is PlusVibe's
    // actual field. Fall back to the stored event_type column for queued
    // events that were saved before this fix.
    const eventType = body?.webhook_event || event.event_type || body?.event || body?.type || 'reply';
    const email = event.email || body?.lead?.email || body?.email || body?.lead_email;
    if (!email) return;

    // Analytics — record into email_events first. Non-fatal on failure so
    // the contact-update path below still runs (we don't want a single bad
    // insert to leave the SQLite webhook row in an unprocessed state).
    await recordEmailEvent(body, eventType, email);

    const dbPg = app.locals.pgDb;
    if (!dbPg) return;

    // Sync to esp_leads (for client portal) — non-fatal on failure
    syncToEspLeads(body, eventType, email, dbPg).catch(() => {});

    const result = await dbPg.query(
      `SELECT id, snoozed_verticals, emailed_workspaces, company_domain FROM contacts WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );
    if (!result.rows.length) return;

    const contact = result.rows[0];
    const campaignName = body?.campaign?.name || body?.campaign_name || '';
    const workspaceName = body?.workspace?.name || body?.workspace_name || '';
    const now = new Date().toISOString();

    // Cooldown is per-client (per-workspace), not global — handled inside
    // the /sent/ branch below, which writes to emailed_workspaces[wsId].
    // No global last_emailed_at bump here on purpose; bumping it globally
    // would lock out other workspaces that haven't actually emailed this
    // contact themselves.

    if (/bounce/i.test(eventType)) {
      const bounceReason = (body?.reason || body?.bounce_reason || body?.message || '').toLowerCase();
      let classification = 'soft';
      if (/hard|permanent|invalid|unknown user|no such user|user unknown|550|551|553|554/i.test(bounceReason)) classification = 'hard';
      else if (/spf|dkim|dmarc|reputation|blocked|blacklist|policy/i.test(bounceReason)) classification = 'sender';

      if (classification === 'sender') return; // our problem, not the contact
      if (classification === 'hard') {
        await dbPg.query(`UPDATE contacts SET email_status='invalid', bounce_type='hard', bounced_at=$1, do_not_contact=true, updated_at=CURRENT_TIMESTAMP WHERE id=$2`, [now, contact.id]);
      } else {
        const cr = await dbPg.query(`SELECT soft_bounce_count FROM contacts WHERE id=$1`, [contact.id]);
        const count = (cr.rows[0]?.soft_bounce_count || 0) + 1;
        if (count >= 3) {
          await dbPg.query(`UPDATE contacts SET email_status='invalid', bounce_type='soft', soft_bounce_count=$1, bounced_at=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3`, [count, now, contact.id]);
        } else {
          await dbPg.query(`UPDATE contacts SET bounce_type='soft', soft_bounce_count=$1, bounced_at=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3`, [count, now, contact.id]);
        }
      }
      return;
    }

    if (/lead/i.test(eventType)) {
      await dbPg.query(`UPDATE contacts SET status='interested', marked_as_lead_at=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2`, [now, contact.id]);
      return;
    }

    // ── Email Sent event — per-client cooldown ────────────────────
    if (/sent|email.sent/i.test(eventType) && !/reply|bounce|lead/i.test(eventType)) {
      const workspaceId = body?.workspace?.id || body?.workspace_id || '';
      if (workspaceId) {
        // Track per-workspace email history in JSONB
        const existing = contact.emailed_workspaces
          ? (typeof contact.emailed_workspaces === 'string' ? JSON.parse(contact.emailed_workspaces) : contact.emailed_workspaces)
          : {};
        existing[workspaceId] = {
          last_sent: new Date().toISOString().slice(0, 10),
          count: ((existing[workspaceId]?.count) || 0) + 1
        };
        await dbPg.query(
          `UPDATE contacts SET emailed_workspaces=$1, last_emailed_at=$2, email_count=COALESCE(email_count,0)+1, updated_at=CURRENT_TIMESTAMP WHERE id=$3`,
          [JSON.stringify(existing), now, contact.id]
        );
        console.log(`[Webhook] Email sent: ${event.email} for workspace ${workspaceId}`);
      }
      return;
    }

    // Reply
    const replyText = body?.reply?.text || body?.message || body?.body || body?.content || body?.reply_text || '';
    const updates = parseReplyIntelligence(replyText, campaignName, workspaceName);
    if (updates._snoozeVertical) {
      const existing = Array.isArray(contact.snoozed_verticals) ? contact.snoozed_verticals : JSON.parse(contact.snoozed_verticals || '[]');
      updates.snoozed_verticals = [...existing.filter(s => s.vertical !== updates._snoozeVertical.vertical), updates._snoozeVertical];
      delete updates._snoozeVertical;
    }
    const companyClosed = !!updates._companyClosed;
    const leftCompany = !!updates._leftCompany;
    await dbPg.updateContactIntelligence(contact.id, updates);

    // Company-closed signal → DNC every contact at this domain, all verticals.
    // One contact's "we ceased trading" should retire the whole company from
    // outreach, not just the person who replied.
    if (companyClosed) {
      const domain = (contact.company_domain || '').toLowerCase().trim();
      if (domain) {
        const reason = ` · Domain DNC: company closed (signal from ${email})`;
        const ur = await dbPg.query(
          `UPDATE contacts
             SET do_not_contact = true,
                 reply_notes = LEFT(COALESCE(reply_notes, '') || $1, 1000),
                 updated_at = CURRENT_TIMESTAMP
           WHERE LOWER(company_domain) = $2
             AND id <> $3
             AND (do_not_contact IS NULL OR do_not_contact = false)`,
          [reason, domain, contact.id]
        );
        console.log(`[Webhook] Domain DNC for ${domain}: ${ur.rowCount} additional contacts marked do_not_contact (trigger: "${replyText.slice(0, 80)}")`);
      } else {
        console.warn(`[Webhook] Company-closed signal from ${email} but no company_domain on record — only this contact DNC'd`);
      }
    }

    // owns_building is a company-level fact — propagate to all contacts at
    // the same domain that don't already have a value set.
    if (updates.owns_building) {
      const domain = (contact.company_domain || '').toLowerCase().trim();
      if (domain) {
        const reason = ` · owns_building=${updates.owns_building} (signal from ${email})`;
        const ur = await dbPg.query(
          `UPDATE contacts
             SET owns_building = $1,
                 reply_notes = LEFT(COALESCE(reply_notes, '') || $2, 1000),
                 updated_at = CURRENT_TIMESTAMP
           WHERE LOWER(company_domain) = $3
             AND id <> $4
             AND (owns_building IS NULL OR owns_building = 'unknown' OR owns_building = '')`,
          [updates.owns_building, reason, domain, contact.id]
        );
        if (ur.rowCount > 0) {
          console.log(`[Webhook] owns_building=${updates.owns_building} propagated to ${ur.rowCount} contacts at ${domain}`);
        }
      }
    }

    // Detailed log of what was detected
    const detected = [];
    if (updates.works_remote)       detected.push('🏠 works_remote=true');
    if (updates.owns_building)      detected.push(`🏢 owns_building=${updates.owns_building}`);
    if (updates.do_not_contact)     detected.push('🚫 do_not_contact=true');
    if (leftCompany)                detected.push('👋 left_company (global DNC)');
    if (companyClosed)              detected.push('🏚 company_closed (domain DNC)');
    if (updates.snoozed_verticals)  detected.push(`⏸ snoozed: ${updates.snoozed_verticals.map(s=>`${s.vertical} until ${s.until}`).join(', ')}`);
    if (detected.length) {
      console.log(`[Webhook] Intelligence saved for ${event.email}: ${detected.join(' · ')}`);
    } else {
      console.log(`[Webhook] Reply logged for ${event.email} — no specific intelligence detected (reply: "${replyText.slice(0, 60)}")`);
    }
  } catch (err) {
    throw err; // caller handles
  }
}

// Optional shared-secret guard. Only enforced when PV_WEBHOOK_SECRET is set, so
// live PlusVibe traffic is never dropped before the secret is configured on both
// ends. Set PV_WEBHOOK_SECRET in env + pass it as x-webhook-secret to lock down.
const PV_WEBHOOK_SECRET = process.env.PV_WEBHOOK_SECRET || '';
app.post('/webhook/plusvibe-reply', (req, res) => {
  if (PV_WEBHOOK_SECRET) {
    const provided = req.headers['x-webhook-secret'] || '';
    if (provided !== PV_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ ok: true }); // respond to PlusVibe immediately (< 5s required)

  const body = req.body || {};
  // PlusVibe uses `webhook_event` (values like EMAIL_SENT / EMAIL_REPLIED /
  // EMAIL_BOUNCED). Check it first so we stop defaulting everything to
  // 'reply' and running the intelligence parser over our own outgoing
  // templates.
  const eventType = body?.webhook_event || body?.event || body?.type || body?.event_type || 'reply';
  const email = body?.lead?.email || body?.email || body?.contact?.email || body?.lead?.Email || body?.Email || body?.lead_email || '';

  // Store raw webhook in SQLite immediately — survives server restarts.
  // Coerce every bound value to a non-undefined string: better-sqlite3 throws
  // "Too few parameter values were provided" if any ? binds to undefined, which
  // happened when a webhook arrived with an empty/unparsed body (JSON.stringify
  // (undefined) === undefined).
  try {
    const payloadStr = JSON.stringify(body) || '{}';
    const stored = db.prepare(`
      INSERT INTO webhook_events (source, event_type, email, payload, processed)
      VALUES ('plusvibe', ?, ?, ?, 0)
    `).run(String(eventType || 'reply'), String(email || '').toLowerCase(), payloadStr);

    // Process async — delete on success, keep with error on failure.
    // Failed webhooks are auto-retried by the loop below every 60s, so
    // pool-timeout / transient errors recover without manual intervention.
    processWebhookEvent({ id: stored.lastInsertRowid, event_type: eventType, email, payload: JSON.stringify(body) })
      .then(() => {
        db.prepare(`DELETE FROM webhook_events WHERE id=?`).run(stored.lastInsertRowid);
        console.log(`[Webhook] Processed + removed: ${eventType} for ${email}`);
      })
      .catch(err => {
        db.prepare(`UPDATE webhook_events SET error=?, processed_at=datetime('now') WHERE id=?`).run(err.message, stored.lastInsertRowid);
        // Transient errors (pool timeout, statement timeout) will be retried
        // automatically — only log non-transient ones at error level.
        const transient = /timeout|connection|ECONNREFUSED|ETIMEDOUT/i.test(err.message);
        if (transient) {
          console.warn(`[Webhook] Transient fail ${eventType} for ${email} — will retry: ${err.message}`);
        } else {
          console.error(`[Webhook] Failed ${eventType} for ${email}:`, err.message);
        }
      });
  } catch (err) {
    console.error('[Webhook] Store error:', err.message);
  }
});

// On startup — re-process any webhooks that arrived while the server was down
setTimeout(async () => {
  if (!db) return; // SQLite not available (Postgres-only deployments)
  const unprocessed = db.prepare(`SELECT * FROM webhook_events WHERE processed=0 ORDER BY received_at ASC LIMIT 500`).all();
  if (!unprocessed.length) return;
  console.log(`[Webhook] Re-processing ${unprocessed.length} queued events from downtime...`);
  for (const event of unprocessed) {
    try {
      await processWebhookEvent(event);
      db.prepare(`DELETE FROM webhook_events WHERE id=?`).run(event.id);
    } catch (err) {
      db.prepare(`UPDATE webhook_events SET error=?, processed_at=datetime('now') WHERE id=?`).run(err.message, event.id);
    }
  }
  console.log(`[Webhook] Catch-up complete`);
}, 10000); // wait 10s for DB connection to be ready

// Continuous retry loop — every 60s, try any webhook that previously failed
// (most often due to a transient pool/connection timeout while indexes were
// building or another big query was holding connections). Limits to 100 per
// pass so we don't block the loop on a thundering herd after a long outage.
setInterval(async () => {
  if (!db) return;
  const stuck = db.prepare(
    `SELECT * FROM webhook_events WHERE processed=0 AND error IS NOT NULL ORDER BY received_at ASC LIMIT 100`
  ).all();
  if (!stuck.length) return;
  let recovered = 0;
  for (const event of stuck) {
    try {
      await processWebhookEvent(event);
      db.prepare(`DELETE FROM webhook_events WHERE id=?`).run(event.id);
      recovered++;
    } catch { /* still failing — leave for next retry */ }
  }
  if (recovered > 0) console.log(`[Webhook] Retry recovered ${recovered}/${stuck.length} stuck events`);
}, 60000);

// ── No2Bounce catch-all verifier ─────────────────────────────────────────
// Per the official spec at docs.no2bounce.com:
//   POST /v2/n2b_validate_bulk        → submit, returns { data: { trackingId } }
//   GET  /v2/n2b_validate_bulk?trackingId=…
//                                     → status response. When overallStatus
//                                       === 'Completed', result.downloadFile
//                                       points to a CSV with per-email verdicts.
const N2B_BULK_URL = 'https://connect.no2bounce.com/v2/n2b_validate_bulk';

// Local CSV parser for the No2Bounce downloadFile.
const { parse: parseCsvSync } = require('csv-parse/sync');
const n2bParseCsv = (text) => parseCsvSync(text, { columns: true, skip_empty_lines: true, trim: true });

async function n2bVerify(emails, jobRef) {
  if (!emails.length) return {};
  if (!NO2BOUNCE_KEY) {
    console.warn('[No2Bounce] NO2BOUNCE_KEY not set — skipping catch-all verification');
    return {};
  }

  // Submit batch. The spec only documents emailList, but the docs UI also
  // shows `catchall:true` as an option — harmless if ignored, useful if
  // it triggers the deeper validation we want.
  const submitResp = await fetch(N2B_BULK_URL, {
    method: 'POST',
    headers: { apitoken: NO2BOUNCE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailList: emails, catchall: true }),
    signal: AbortSignal.timeout(30000)
  });
  const submitData = await submitResp.json();
  if (!submitResp.ok || !submitData?.data?.trackingId) {
    console.error('[No2Bounce] Submit failed:', JSON.stringify(submitData).slice(0, 200));
    return {};
  }
  const trackingId = submitData.data.trackingId;
  console.log(`[No2Bounce] Submitted ${emails.length} emails, trackingId=${trackingId}`);

  // Poll for results (max 8 minutes, every 10 seconds)
  const maxWait = 8 * 60 * 1000;
  const pollInterval = 10000;
  const deadline = Date.now() + maxWait;
  let loggedShape = false;

  while (Date.now() < deadline) {
    if (jobRef?.cancelled) return {};
    await new Promise(r => setTimeout(r, pollInterval));

    try {
      const r = await fetch(`${N2B_BULK_URL}?trackingId=${encodeURIComponent(trackingId)}`, {
        headers: { apitoken: NO2BOUNCE_KEY },
        signal: AbortSignal.timeout(15000)
      });
      const data = await r.json();

      if (!loggedShape) {
        console.log('[No2Bounce] First poll raw response:', JSON.stringify(data).slice(0, 1500));
        loggedShape = true;
      }

      const overall = String(data?.overallStatus || '').toLowerCase();
      if (overall !== 'completed' && overall !== 'complete') {
        console.log(`[No2Bounce] Still processing (${trackingId}) overallStatus="${data?.overallStatus || ''}"`);
        continue;
      }

      // Done — per the spec, results live in a downloadable CSV at
      // result.downloadFile. Fetch it and parse per-email verdicts.
      const downloadUrl = data?.result?.downloadFile;
      if (!downloadUrl) {
        console.warn('[No2Bounce] Completed but no downloadFile in response:', JSON.stringify(data).slice(0, 500));
        return {};
      }
      console.log(`[No2Bounce] Completed — fetching results CSV (${data.totalRecord || '?'} records, ${data.creditDebited || '?'} credits used)`);

      const csvResp = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
      if (!csvResp.ok) {
        console.warn(`[No2Bounce] CSV fetch failed HTTP ${csvResp.status}`);
        return {};
      }
      const csvText = await csvResp.text();
      const rows = n2bParseCsv(csvText);
      if (!rows.length) {
        console.warn('[No2Bounce] CSV had no rows');
        return {};
      }
      console.log('[No2Bounce] CSV headers:', Object.keys(rows[0]).join(', '));
      console.log('[No2Bounce] First CSV row:', JSON.stringify(rows[0]).slice(0, 300));

      const map = {};
      // Real No2Bounce bulk CSV columns: email, finalScore, finalScoreValue, catchall
      // finalScoreValue values seen in the wild:
      //   "Deliverable"          → safe (clean deliverable)
      //   "Deliverable/AcceptAll" → safe (catch-all but No2Bounce confirms email exists)
      //   "Undeliverable"        → invalid
      //   "UnDeliverable/AcceptAll" → invalid (catch-all but No2Bounce confirms it won't deliver)
      //   "Risky/AcceptAll"      → risky (still uncertain)
      // Check undeliverable BEFORE deliverable since the substring "deliverable"
      // appears in both.
      const verdictFromRow = (row) => {
        const raw = (row.finalScoreValue || row.scoreStatus || row.status
                  || row.result || row.verdict || row.Status || '').toString().toLowerCase();
        if (raw.includes('undeliver') || raw.startsWith('invalid') || raw.startsWith('bounce')) return 'invalid';
        if (raw.includes('deliver') || raw.startsWith('valid') || raw.startsWith('safe'))       return 'safe';
        if (raw.startsWith('risk') || raw.includes('catch'))                                     return 'risky';
        return 'unknown';
      };
      for (const row of rows) {
        const email = String(row.email || row.Email || row.address || '').trim().toLowerCase();
        if (!email) continue;
        map[email] = verdictFromRow(row);
      }
      const counts = Object.values(map).reduce((a, v) => (a[v] = (a[v]||0)+1, a), {});
      console.log(`[No2Bounce] Parsed ${Object.keys(map).length} verdicts:`, counts);
      return map;
    } catch (err) {
      console.warn('[No2Bounce] Poll error:', err.message);
    }
  }

  console.warn(`[No2Bounce] Timed out waiting for trackingId=${trackingId}`);
  return {};
}

// ── Verify & Push Job Queue ───────────────────────────────────────────────
const pushJobs = new Map(); // jobId → job state

// Paused jobs persist in SQLite so they survive server restarts.
// Table is created lazily here (server.js runs after db setup).
function initPausedJobsTable(sq) {
  if (!sq) return;
  sq.exec(`CREATE TABLE IF NOT EXISTS paused_push_jobs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    campaign_id TEXT,
    workspace_name TEXT,
    campaign_name TEXT,
    contact_ids TEXT,
    include_risky INTEGER DEFAULT 0,
    max_age_days INTEGER DEFAULT 90,
    paused_at TEXT DEFAULT (datetime('now')),
    verified_count INTEGER DEFAULT 0,
    pushed_count INTEGER DEFAULT 0
  )`);
}

// On boot, restore paused jobs into the in-memory map so the UI shows them.
function restorePausedJobs(sq) {
  if (!sq) return;
  try {
    initPausedJobsTable(sq);
    const rows = sq.prepare('SELECT * FROM paused_push_jobs').all();
    for (const row of rows) {
      const contactIds = JSON.parse(row.contact_ids || '[]');
      pushJobs.set(row.id, {
        id: row.id,
        status: 'paused',
        workspace_id: row.workspace_id,
        campaign_id: row.campaign_id,
        workspace_name: row.workspace_name || row.workspace_id,
        campaign_name: row.campaign_name || row.campaign_id,
        total: contactIds.length,
        verified: row.verified_count || 0,
        pushed: row.pushed_count || 0,
        skipped: 0, safe: 0, risky: 0, invalid: 0, unknown: 0, safe_catchall: 0,
        progress: 0,
        created_at: Date.now(),
        paused: true,
        error: null
      });
    }
    if (rows.length) console.log(`[push] Restored ${rows.length} paused job(s) from SQLite`);
  } catch (e) {
    console.warn('[push] Could not restore paused jobs:', e.message);
  }
}

app.get('/api/reacher-pool', requireSession, async (req, res) => {
  try {
    const finderPort = process.env.EMAIL_FINDER_INTERNAL_PORT || '5055';
    const r = await fetch(`http://127.0.0.1:${finderPort}/api/reacher-pool`);
    res.json(await r.json());
  } catch {
    res.json({ pool: [] });
  }
});

app.get('/api/reacher-pool-test/:label', requireSession, async (req, res) => {
  try {
    const finderPort = process.env.EMAIL_FINDER_INTERNAL_PORT || '5055';
    const r = await fetch(`http://127.0.0.1:${finderPort}/api/reacher-pool-test/${encodeURIComponent(req.params.label)}`);
    res.json(await r.json());
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/contacts/verified-today', requireSession, async (req, res) => {
  try {
    const dbPg = req.app.locals.pgDb;
    if (!dbPg) return res.status(503).json({ error: 'Database unavailable' });
    const result = await dbPg.query(`
      SELECT
        COUNT(*)                                                          AS total,
        COUNT(*) FILTER (WHERE email_status IN ('safe','safe_catchall')) AS safe,
        COUNT(*) FILTER (WHERE email_status = 'invalid')                 AS invalid,
        COUNT(*) FILTER (WHERE email_status = 'risky')                   AS risky,
        COUNT(*) FILTER (WHERE email_status = 'unknown')                 AS unknown
      FROM contacts
      WHERE email_verified_at::timestamptz >= NOW() - INTERVAL '24 hours'
    `);
    const row = result.rows[0];
    res.json({
      total:   +row.total,
      safe:    +row.safe,
      invalid: +row.invalid,
      risky:   +row.risky,
      unknown: +row.unknown,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/contacts/push-jobs', requireSession, (req, res) => {
  const jobs = [...pushJobs.values()]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 20);
  res.json({ jobs });
});

app.get('/api/contacts/push-jobs/:id', requireSession, (req, res) => {
  const job = pushJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// POST starts job immediately, returns job ID — processing runs in background
app.post('/api/contacts/verify-and-push', requireSession, (req, res) => {
  const { contact_ids, workspace_id, campaign_id, workspace_name, campaign_name, include_risky = false, max_age_days = 90, emailProviders } = req.body;
  if (!workspace_id || !campaign_id || !Array.isArray(contact_ids) || !contact_ids.length) {
    return res.status(400).json({ error: 'workspace_id, campaign_id and contact_ids required' });
  }

  const db = req.app.locals.pgDb;
  if (!db) return res.status(500).json({ error: 'Database not available' });

  // Allowed true-MX providers for this push, e.g. ['email_google','email_other'].
  // Empty/absent = no provider restriction. 'unknown' is never an allowed push
  // target: an unknown-MX contact must resolve to a real provider via the
  // verifier first, then that real provider is checked against this list.
  const allowedProviders = (typeof emailProviders === 'string' ? emailProviders : '')
    .split(',').map(s => s.trim()).filter(p => p && p !== 'unknown');

  const sq = req.app.locals.sqliteDb;
  const jobId = require('crypto').randomUUID();
  const job = {
    id: jobId,
    status: 'verifying',
    workspace_name: workspace_name || workspace_id,
    campaign_name: campaign_name || campaign_id,
    workspace_id, campaign_id,
    allowedProviders,
    total: contact_ids.length,
    skipped: 0, verified: 0, safe: 0, risky: 0, invalid: 0, unknown: 0,
    pushed: 0, progress: 0,
    created_at: Date.now(),
    error: null
  };
  pushJobs.set(jobId, job);

  // Persist to SQLite so Pause/Resume survives server restarts
  if (sq) {
    try {
      initPausedJobsTable(sq);
      sq.prepare(`INSERT OR REPLACE INTO paused_push_jobs
        (id, workspace_id, campaign_id, workspace_name, campaign_name, contact_ids, include_risky, max_age_days)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        jobId, workspace_id, campaign_id,
        workspace_name || workspace_id, campaign_name || campaign_id,
        JSON.stringify(contact_ids), include_risky ? 1 : 0, max_age_days
      );
    } catch (e) { console.warn('[push] Could not persist job to SQLite:', e.message); }
  }

  // Clean up old completed jobs (keep last 20)
  const allJobs = [...pushJobs.entries()].sort((a, b) => b[1].created_at - a[1].created_at);
  if (allJobs.length > 20) allJobs.slice(20).forEach(([id]) => pushJobs.delete(id));

  res.json({ jobId, message: 'Job started' });

  // Run async in background — db already validated above
  (async () => {
    try {
      const contacts = await db.getContactsById(contact_ids);
      if (!contacts.length) { job.status = 'failed'; job.error = 'No contacts found'; return; }

      // Domain-MX pre-pass: fill mx_provider for any contact whose domain is
      // already known in the cache, before we verify anything. MX is a domain
      // property, so one prior resolution classifies every later contact on
      // that domain — no repeat lookup. This also lets the provider gate drop
      // wrong-provider contacts without spending a verification on them.
      {
        const byDomain = new Map();
        for (const c of contacts) {
          if (c.mx_provider) continue;
          const domain = (c.email || '').split('@')[1]?.toLowerCase();
          if (!domain) continue;
          if (!byDomain.has(domain)) byDomain.set(domain, []);
          byDomain.get(domain).push(c);
        }
        for (const [domain, list] of byDomain) {
          try {
            const prov = await db.getDomainMxProvider(domain);
            if (prov) list.forEach(c => { c.mx_provider = prov; });
          } catch { /* cache miss / transient — verifier will resolve it */ }
        }
      }

      const cutoff = new Date(Date.now() - max_age_days * 24 * 60 * 60 * 1000).toISOString();
      // A 'fresh' verdict is recent AND has a real status. We re-verify
      // contacts whose previous result was 'unknown' (usually transient
      // Reacher failures — timeout / SMTP refused — not a real permanent
      // verdict) so they get a second shot at a real answer.
      const isFreshVerdict = c =>
        c.email_verified_at && c.email_verified_at >= cutoff && c.email_status && c.email_status !== 'unknown';
      const needsVerify     = contacts.filter(c => !isFreshVerdict(c));
      const alreadyVerified = contacts.filter(isFreshVerdict);

      job.skipped = alreadyVerified.length;
      job.toVerify = needsVerify.length;
      job.startedAt = Date.now();

      const verifyResults = {};
      // Pre-populate with the existing email_status so chip counts reflect
      // the running total. isFreshVerdict already filtered out NULL/unknown
      // so every entry here is a real verdict.
      alreadyVerified.forEach(c => {
        verifyResults[c.id] = c.email_status;
      });

      const finderPort = process.env.EMAIL_FINDER_INTERNAL_PORT || '5055';
      // Reacher author (Jon) recommends concurrency 5 — going higher gets
      // SMTP servers to throttle/block parallel probes from one source IP.
      // Env-overridable for experimentation, default stays at 5.
      const CONCURRENCY = Math.max(1, parseInt(process.env.PUSH_VERIFY_CONCURRENCY || '5', 10));
      const VERIFY_THEN_PUSH = Math.max(20, parseInt(process.env.VERIFY_THEN_PUSH || '100', 10));
      let doneCount = 0;
      const skipped = { unsafe: 0, dnc: 0, cooldownWorkspace: 0, alreadyInCampaign: 0, snoozed: 0, missingEnrichment: 0, wrongProvider: 0, missingName: 0 };
      const allowedProviders = Array.isArray(job.allowedProviders) ? job.allowedProviders : [];

      // ── Shared filter constants ────────────────────────────────
      const campaignVertical = detectVertical((job.campaign_name || '') + ' ' + (job.workspace_name || ''));
      const today        = new Date().toISOString().slice(0, 10);
      const cooloffDate  = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const targetCampLc = (job.campaign_name || '').trim().toLowerCase();

      const passesFilter = (c) => {
        if (verifyResults[c.id] !== 'safe' && verifyResults[c.id] !== 'safe_catchall') { skipped.unsafe++; return false; }
        if (c.do_not_contact)               { skipped.dnc++; return false; }
        // Bison requires non-empty first_name AND last_name (422s otherwise), and a
        // nameless contact shouldn't be cold-emailed anyway — skip and report.
        if (!(c.first_name && c.first_name.trim()) || !(c.last_name && c.last_name.trim())) {
          skipped.missingName++; return false;
        }
        // True-MX provider gate. By the time a contact reaches here it has been
        // verified, so c.mx_provider is its real provider (set by verifyOne /
        // the domain cache). Enforce the user's provider filter against that
        // truth — this is what stops a Microsoft-hosted contact slipping into a
        // "Google + Other" push. A still-null mx_provider means the verifier
        // couldn't resolve MX; exclude it rather than guess (safer than leaking
        // a possibly-wrong provider into the campaign).
        if (allowedProviders.length && !allowedProviders.includes(c.mx_provider)) {
          skipped.wrongProvider++; return false;
        }
        if ((!c.keywords || c.keywords.trim() === '') || (!c.industry || c.industry.trim() === '')) {
          skipped.missingEnrichment++; return false;
        }
        // Bulletproof per-campaign dedup: check the full pushed_campaigns
        // history, not just last_campaign_name (which only remembers the
        // most-recent push and leaks when campaigns interleave).
        const pushed = Array.isArray(c.pushed_campaigns)
          ? c.pushed_campaigns
          : (typeof c.pushed_campaigns === 'string' ? JSON.parse(c.pushed_campaigns || '[]') : []);
        if (pushed.some(p =>
          p.workspace_id === job.workspace_id &&
          (p.campaign_id === job.campaign_id || (targetCampLc && (p.campaign_name || '').toLowerCase() === targetCampLc))
        )) { skipped.alreadyInCampaign++; return false; }
        // Legacy guard kept for contacts imported pre-pushed_campaigns —
        // last_campaign_name comes from PlusVibe CSV imports.
        if (targetCampLc && c.last_campaign_name
            && c.last_campaign_name.toLowerCase() === targetCampLc) {
          skipped.alreadyInCampaign++; return false;
        }
        if (job.workspace_id) {
          const emailed = typeof c.emailed_workspaces === 'string'
            ? JSON.parse(c.emailed_workspaces || '{}') : (c.emailed_workspaces || {});
          if (emailed[job.workspace_id]?.last_sent >= cooloffDate) { skipped.cooldownWorkspace++; return false; }
        }
        if (campaignVertical) {
          const snoozes = Array.isArray(c.snoozed_verticals)
            ? c.snoozed_verticals : JSON.parse(c.snoozed_verticals || '[]');
          if (snoozes.some(s => s.vertical === campaignVertical && s.until >= today)) { skipped.snoozed++; return false; }
        }
        return true;
      };

      // Track which contact IDs needed cleaning at push time so we can
      // backfill the DB after the push completes (fire-and-forget). This
      // heals historical rows that the import-time cleaner didn't catch.
      const cleaningBackfills = []; // [{ id, company_name, job_title_cleaned }]

      const toLead = (c) => {
        const raw = typeof c.raw_data === 'string' ? JSON.parse(c.raw_data || '{}') : (c.raw_data || {});

        // ── Always clean company name + job title at push time. The DB
        //    might have stale ALL-CAPS or uncleaned values from older
        //    imports — push-time cleaning is the authoritative pass that
        //    guarantees PlusVibe receives clean data regardless.
        const rawCompany = c.company_name || raw['Company Name'] || '';
        const cleanedCompany = cleanCompanyName(rawCompany);

        const rawTitle = c.job_title_cleaned || c.job_title || raw['Title'] || raw['Clean Job Title'] || raw['Job Title'] || '';
        const cleanedTitle = normalizeJobTitle(rawTitle);

        // Queue a DB backfill if push-time cleaning produced a different
        // value from what's stored. Async, non-blocking, fire-and-forget.
        if (c.id && (cleanedCompany !== c.company_name || cleanedTitle !== c.job_title_cleaned)) {
          cleaningBackfills.push({
            id: c.id,
            company_name: cleanedCompany || null,
            job_title_cleaned: cleanedTitle || null,
          });
        }

        // Overwrite company-name AND job-title keys inside raw so the
        // Custom fields PlusVibe exposes for personalisation match the
        // cleaned native values.
        const cleanedRaw = { ...raw };
        for (const key of ['Company Name', 'Company Name For Emails', 'Account Name', 'Organization Name']) {
          if (key in cleanedRaw) cleanedRaw[key] = cleanedCompany;
        }
        for (const key of ['Title', 'Clean Job Title', 'Job Title']) {
          if (key in cleanedRaw) cleanedRaw[key] = cleanedTitle;
        }

        return {
          email: c.email,
          first_name: c.first_name || '',
          last_name: c.last_name || '',
          phone_number: c.phone || '',
          company_name: cleanedCompany,
          company_website: c.company_domain || '',
          address_line: c.company_address || raw['Company Address'] || raw['Address Line'] || raw.Address || '',
          // Company is the default location target (per spec): native city/
          // state/country carry COMPANY location so {{city}}/{{state}}/
          // {{country}} resolve to the company. Person via {{person_*}}.
          city: c.company_city || c.city || raw['Company City'] || raw.City || '',
          state: c.company_county || c.company_state || c.state || raw['Company State'] || '',
          country: c.company_country || c.country || raw['Company Country'] || raw.Country || '',
          job_title: cleanedTitle,
          department: c.department || '',
          industry: raw.Industry || c.industry || '',
          linkedin_person_url: c.linkedin_url || '',
          linkedin_company_url: c.company_linkedin_url || '',
          custom_variables: {
            seniority: c.seniority || '',
            email_status: verifyResults[c.id] || '',
            ...cleanedRaw,
            // Location hierarchy last so clean normalised values win over raw.
            ...locationCustomVars(c)
          }
        };
      };

      const pushLeads = async (batch) => {
        for (let i = 0; i < batch.length; i += 100) {
          if (job.cancelled || job.paused) return;
          const slice = batch.slice(i, i + 100);
          let r, d = {};
          /* workspace switch handled by bisonReq wsId */ true;
          var bisonLeadPayload = (slice.map(toLead))
            // Bison requires non-empty first_name AND last_name (422s on null/""/" ").
            // Final safety net at the payload layer so no nameless lead reaches Bison
            // regardless of upstream filtering.
            .filter(function(l){ return l.first_name && String(l.first_name).trim() && l.last_name && String(l.last_name).trim(); })
            .map(function(l) {
            var cv = [];
            if (l.phone_number) cv.push({ name: 'phone_number', value: String(l.phone_number) });
            if (l.city) cv.push({ name: 'city', value: String(l.city) });
            if (l.state) cv.push({ name: 'state', value: String(l.state) });
            if (l.country) cv.push({ name: 'country', value: String(l.country) });
            if (l.industry) cv.push({ name: 'industry', value: String(l.industry) });
            if (l.linkedin_person_url) cv.push({ name: 'linkedin_person_url', value: String(l.linkedin_person_url) });
            if (l.linkedin_company_url) cv.push({ name: 'linkedin_company_url', value: String(l.linkedin_company_url) });
            if (l.company_website) cv.push({ name: 'company_website', value: String(l.company_website) });
            if (l.department) cv.push({ name: 'department', value: String(l.department) });
            if (l.address_line) cv.push({ name: 'address_line', value: String(l.address_line) });
            return { email: l.email, first_name: l.first_name || null, last_name: l.last_name || null, title: l.job_title || l.title || null, company: l.company_name || l.company || null, custom_variables: cv };
          });
          if (!bisonLeadPayload.length) { continue; }
          // Ensure every custom var these leads use exists in the workspace, or Bison 422s.
          await ensureBisonCustomVars(workspace_id, new Set(bisonLeadPayload.flatMap(function(l){ return (l.custom_variables||[]).map(function(v){ return v.name; }); })));
          var createRes = await bisonReq('/api/leads/create-or-update/multiple', { wsId: workspace_id, method: 'POST', body: { leads: bisonLeadPayload } });
          if (campaign_id && createRes && createRes.data) {
            var leadIds = (createRes.data.leads || createRes.data || []).map(function(l) { return l.id; }).filter(Boolean);
            if (leadIds.length) {
              await bisonReq('/api/campaigns/' + campaign_id + '/leads/attach-leads', { wsId: workspace_id, method: 'POST', body: { lead_ids: leadIds } }).catch(function(e) { console.warn('[bison] campaign-assign FAILED:', e.message); });
            }
          }
          r = { ok: true };
          // Stamp pushed_campaigns so future verify-and-push runs against
          // this same campaign skip these contacts cleanly. Fire-and-forget
          // — a stamp failure must not roll back the actual push.
          try {
            const ids = slice.map(c => c.id).filter(Boolean);
            if (ids.length && db.stampPushedCampaign) {
              await db.stampPushedCampaign(ids, workspace_id, campaign_id, job.campaign_name || '');
            }
          } catch (err) {
            console.warn('[push] stampPushedCampaign failed:', err.message);
          }

          // Backfill the DB with whatever cleanCompanyName / normalizeJobTitle
          // changed during this slice. Heals historical rows incrementally —
          // every successful push leaves the DB a bit cleaner. Fire-and-forget,
          // never blocks the push response.
          if (cleaningBackfills.length && db.bulkUpdateCleanedNames) {
            const toFlush = cleaningBackfills.splice(0, cleaningBackfills.length);
            db.bulkUpdateCleanedNames(toFlush).catch(err =>
              console.warn('[push] cleanedNames backfill failed:', err.message));
          }

          job.pushed += Math.min(100, batch.length - i);
          job.progress = Math.min(99, job.progress + 1);
        }
      };

      const verifyOne = async (c, batchUpdates) => {
        if (job.cancelled || job.paused) return;
        try {
          const r = await fetch(`http://127.0.0.1:${finderPort}/api/verify-email`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: c.email, verifier: 'reacher' }),
            signal: AbortSignal.timeout(65000)
          });
          const d = await r.json();
          const smtp = d.result?.raw?.smtp || d.result?.smtp || {};
          const reason = d.result?.reason || '';
          const catchAll = smtp.is_catch_all === true || /catch_all=yes/i.test(reason);
          const reaStatus = (d.result?.status || d.result?.is_reachable || 'unknown').toLowerCase();
          const status = catchAll || reaStatus === 'risky' ? 'risky'
            : reaStatus === 'safe' || reaStatus === 'valid' ? 'safe'
            : reaStatus === 'invalid' ? 'invalid'
            : 'unknown';
          if (status !== 'safe' && !job._loggedSample) {
            job._loggedSample = true;
            console.log(`[Verify] sample non-safe response for ${c.email}: status=${reaStatus} catchAll=${catchAll} smtp=${JSON.stringify(smtp).slice(0,200)} reason="${String(reason).slice(0,160)}"`);
          }
          // Detect email provider from MX records — ground truth vs Apollo tech stack.
          // Reacher returns mx.records[].exchange in its raw response.
          const mxRecords = d.result?.raw?.mx?.records || [];
          const mxHost = (mxRecords[0]?.exchange || '').toLowerCase();
          const mxProvider = /google|gmail/.test(mxHost) ? 'email_google'
            : /outlook|microsoft|protection\.outlook|mail\.microsoft/.test(mxHost) ? 'email_outlook'
            : mxHost ? 'email_other'
            : null;
          // Stamp the true provider onto the in-memory contact so passesFilter
          // (which runs right after) sees it, and fan it out to the whole
          // domain via the cache — MX is a domain property, so one resolution
          // classifies every contact on that domain and they skip re-lookup.
          if (mxProvider) {
            c.mx_provider = mxProvider;
            const domain = (c.email || '').split('@')[1]?.toLowerCase();
            if (domain) {
              try { await db.setDomainMxProvider(domain, mxProvider); }
              catch (e) { console.warn('[verify] domain mx cache update failed:', e.message); }
            }
          }
          verifyResults[c.id] = status;
          batchUpdates.push({ id: c.id, email_status: status, email_verified_at: new Date().toISOString(), mx_provider: mxProvider, email: c.email });
        } catch {
          // Network/timeout reaching the finder itself = a real outage signal
          // (distinct from an SMTP-level "unknown" the finder returns normally).
          verifyResults[c.id] = 'unknown';
          batchUpdates.push({ id: c.id, email_status: 'unknown', email_verified_at: new Date().toISOString(), _netfail: true });
        }
        doneCount++;
        job.verified  = doneCount;
        job.safe         = Object.values(verifyResults).filter(s => s === 'safe').length;
        job.safe_catchall= Object.values(verifyResults).filter(s => s === 'safe_catchall').length;
        job.risky        = Object.values(verifyResults).filter(s => s === 'risky').length;
        job.invalid      = Object.values(verifyResults).filter(s => s === 'invalid').length;
        job.unknown      = Object.values(verifyResults).filter(s => s === 'unknown').length;
        job.progress  = Math.round((doneCount / Math.max(needsVerify.length, 1)) * 85);
        const elapsed = (Date.now() - job.startedAt) / 1000;
        const rate = doneCount / elapsed;
        job.etaSeconds = rate > 0 ? Math.round((needsVerify.length - doneCount) / rate) : null;
      };

      // Count already-verified stats
      alreadyVerified.forEach(c => { const s = c.email_status || 'unknown'; job[s] = (job[s] || 0) + 1; });

      // ── Phase 1: push already-verified contacts immediately ────
      const alreadyPassing = alreadyVerified.filter(passesFilter);
      if (alreadyPassing.length) {
        job.status = 'pushing';
        await pushLeads(alreadyPassing);
        if (job.status === 'failed' || job.cancelled || job.paused) {
          if (job.paused) job.status = 'pausing';
          else job.status = job.cancelled ? 'cancelled' : job.status;
          return;
        }
      }

      // ── Phase 2: verify in batches of 100, push each immediately ──
      for (let i = 0; i < needsVerify.length; i += VERIFY_THEN_PUSH) {
        if (job.cancelled || job.paused) break;
        const chunk = needsVerify.slice(i, i + VERIFY_THEN_PUSH);
        const batchUpdates = [];

        job.status = 'verifying';
        for (let j = 0; j < chunk.length; j += CONCURRENCY) {
          if (job.cancelled || job.paused) break;
          await Promise.all(chunk.slice(j, j + CONCURRENCY).map(c => verifyOne(c, batchUpdates)));
        }
        if (job.cancelled || job.paused) break;

        // First batch all NETWORK failures = the finder is truly unreachable.
        // (SMTP-level "unknown" — greylisting, proxy/MX timeouts, blacklisted
        // verifier IP — is normal and must NOT abort the job; those emails just
        // stay unknown and are skipped from the safe push, the rest proceed.)
        if (i === 0 && batchUpdates.length > 0 && batchUpdates.every(u => u._netfail)) {
          job.status = 'failed';
          job.error = 'Email verification failed — email-finder not responding. Try pushing without verify.';
          return;
        }

        // Save verification to DB — fire-and-forget AND skip the catch-all
        // propagation inside the loop. Both used to block the next verify
        // batch (DB chunked-update + 230k-row domain propagation each took
        // seconds), throttling the loop to ~3-4s/contact. We now fire the
        // write in the background and run the catch-all propagation once
        // at the end, after Reacher has finished crunching the whole list.
        if (batchUpdates.length) {
          db.bulkUpdateVerification(batchUpdates, { skipCatchAllPropagation: true })
            .catch(err => console.warn('[verify] background DB write failed:', err.message));
        }

        // Push passing contacts from this batch right now
        const passing = chunk.filter(passesFilter);
        if (passing.length) {
          job.status = 'pushing';
          await pushLeads(passing);
          if (job.status === 'failed') return;
        }
      }

      // If paused mid-loop, update SQLite record and stop
      if (job.paused) {
        job.status = 'paused';
        if (sq) {
          try { sq.prepare(`UPDATE paused_push_jobs SET verified_count = ?, pushed_count = ? WHERE id = ?`)
            .run(job.verified || 0, job.pushed || 0, job.id); } catch {}
        }
        return;
      }

      // Final catch-all propagation across all risky verdicts collected in
      // this run — done once at the end so it can't throttle the verify loop.
      try {
        const riskyForPropagation = Object.entries(verifyResults)
          .filter(([, s]) => s === 'risky')
          .map(([id]) => ({ id, email_status: 'risky', email: (contacts.find(c => c.id === id) || {}).email }));
        if (riskyForPropagation.length && db.bulkUpdateVerification) {
          await db.bulkUpdateVerification(riskyForPropagation, { propagateOnly: true });
        }
      } catch (err) {
        console.warn('[verify] final catch-all propagation failed:', err.message);
      }

      // ── Phase 3: No2Bounce deeper validation of catch-all contacts ──
      const riskyContacts = contacts.filter(c => verifyResults[c.id] === 'risky');
      console.log(`[No2Bounce] Risky contacts found: ${riskyContacts.length} of ${contacts.length}`);
      if (riskyContacts.length && !job.cancelled) {
        job.status = 'n2b_verifying';
        job.n2bTotal = riskyContacts.length;
        job.n2bDone  = 0;
        console.log(`[No2Bounce] Verifying ${riskyContacts.length} catch-all contacts…`);

        const n2bMap = await n2bVerify(riskyContacts.map(c => c.email), job);
        job.n2bDone = riskyContacts.length;

        // Update DB and push contacts No2Bounce confirms as valid
        const n2bUpdates = [];
        const n2bPush   = [];
        for (const c of riskyContacts) {
          const verdict = n2bMap[c.email.toLowerCase()];
          if (!verdict) continue; // no result — leave as risky
          const newStatus = verdict === 'safe' ? 'safe_catchall' : verdict === 'invalid' ? 'invalid' : 'risky';
          verifyResults[c.id] = newStatus;
          n2bUpdates.push({ id: c.id, email_status: newStatus, email_verified_at: new Date().toISOString() });
          if (newStatus === 'safe_catchall' && passesFilter({ ...c, ...{ } })) n2bPush.push(c);
        }
        if (n2bUpdates.length) await db.bulkUpdateVerification(n2bUpdates);

        const n2bSafe    = n2bUpdates.filter(u => u.email_status === 'safe_catchall').length;
        const n2bInvalid = n2bUpdates.filter(u => u.email_status === 'invalid').length;
        job.n2bSafe    = n2bSafe;
        job.n2bInvalid = n2bInvalid;
        // Recompute the chip counts so the UI shows the rescued contacts
        // moved from 'risky' to 'safe_catchall' (and any confirmed-bad to 'invalid')
        // instead of stuck on the Reacher-phase numbers.
        job.safe         = Object.values(verifyResults).filter(s => s === 'safe').length;
        job.safe_catchall= Object.values(verifyResults).filter(s => s === 'safe_catchall').length;
        job.risky        = Object.values(verifyResults).filter(s => s === 'risky').length;
        job.invalid      = Object.values(verifyResults).filter(s => s === 'invalid').length;
        job.unknown      = Object.values(verifyResults).filter(s => s === 'unknown').length;
        console.log(`[No2Bounce] Results: ${n2bSafe} confirmed safe, ${n2bInvalid} invalid, ${riskyContacts.length - n2bUpdates.length} no result`);

        if (n2bPush.length && !job.cancelled) {
          job.status = 'pushing';
          await pushLeads(n2bPush);
        }
      }

      job.skipped = skipped;
      const breakdown = {
        safe:         Object.values(verifyResults).filter(s => s === 'safe').length,
        safe_catchall:Object.values(verifyResults).filter(s => s === 'safe_catchall').length,
        risky:        Object.values(verifyResults).filter(s => s === 'risky').length,
        invalid:      Object.values(verifyResults).filter(s => s === 'invalid').length,
        unknown:      Object.values(verifyResults).filter(s => s === 'unknown').length,
      };
      console.log(`[push] ${job.id} done — pushed ${job.pushed}, verify breakdown:`, breakdown, 'skipped:', skipped);

      if (job.paused) {
        // Paused mid-run — update the SQLite record with current progress
        if (sq) {
          try {
            sq.prepare(`UPDATE paused_push_jobs SET verified_count = ?, pushed_count = ? WHERE id = ?`)
              .run(job.verified || 0, job.pushed || 0, job.id);
          } catch {}
        }
        // Keep status as 'paused' — do not mark completed/cancelled
      } else {
        // Completed or cancelled — delete from SQLite
        if (sq) { try { sq.prepare(`DELETE FROM paused_push_jobs WHERE id = ?`).run(job.id); } catch {} }
        job.status = job.cancelled ? 'cancelled' : 'completed';
        job.progress = 100;
      }
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      console.error('[Verify+Push]', err.message);
      if (sq) { try { sq.prepare(`DELETE FROM paused_push_jobs WHERE id = ?`).run(job.id); } catch {} }
    }
  })();
});

// Cancel a push job
app.post('/api/contacts/push-jobs/:id/cancel', requireSession, (req, res) => {
  const job = pushJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  job.cancelled = true;
  const sq = req.app.locals.sqliteDb;
  if (sq) { try { sq.prepare(`DELETE FROM paused_push_jobs WHERE id = ?`).run(job.id); } catch {} }
  res.json({ ok: true });
});

// Pause a push job — sets paused flag; worker exits after current batch
app.post('/api/contacts/push-jobs/:id/pause', requireSession, (req, res) => {
  const job = pushJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (!['verifying','pushing','n2b_verifying'].includes(job.status)) {
    return res.status(400).json({ error: 'Job is not running' });
  }
  job.paused = true;
  job.status = 'pausing';
  res.json({ ok: true });
});

// Resume a paused job — spawns a new worker that skips already-verified contacts
app.post('/api/contacts/push-jobs/:id/resume', requireSession, async (req, res) => {
  const job = pushJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.status !== 'paused') return res.status(400).json({ error: 'Job is not paused' });

  const sq = req.app.locals.sqliteDb;
  const db = req.app.locals.pgDb;
  if (!db) return res.status(500).json({ error: 'Database not available' });

  let row;
  try {
    row = sq && sq.prepare(`SELECT * FROM paused_push_jobs WHERE id = ?`).get(job.id);
  } catch {}
  if (!row) return res.status(404).json({ error: 'Paused job record not found — cannot resume' });

  job.paused = false;
  job.cancelled = false;
  job.status = 'verifying';

  res.json({ ok: true });

  const contact_ids = JSON.parse(row.contact_ids || '[]');
  const include_risky = !!row.include_risky;
  const max_age_days = row.max_age_days || 90;
  const workspace_id = row.workspace_id;
  const campaign_id  = row.campaign_id;

  // Re-run the worker — isFreshVerdict inside will skip already-verified contacts,
  // so only contacts that were not yet verified (or got 'unknown') will be re-sent to Reacher.
  ;(async () => {
    try {
      const contacts = await db.getContactsById(contact_ids);
      if (!contacts.length) { job.status = 'failed'; job.error = 'No contacts found'; return; }

      const cutoff = new Date(Date.now() - max_age_days * 24 * 60 * 60 * 1000).toISOString();
      const isFreshVerdict = c =>
        c.email_verified_at && c.email_verified_at >= cutoff && c.email_status && c.email_status !== 'unknown';
      const needsVerify     = contacts.filter(c => !isFreshVerdict(c));
      const alreadyVerified = contacts.filter(isFreshVerdict);

      job.total   = contact_ids.length;
      job.skipped = alreadyVerified.length;
      job.toVerify = needsVerify.length;
      job.startedAt = Date.now();

      const verifyResults = {};
      alreadyVerified.forEach(c => { verifyResults[c.id] = c.email_status; });

      const finderPort = process.env.EMAIL_FINDER_INTERNAL_PORT || '5055';
      const CONCURRENCY = Math.max(1, parseInt(process.env.PUSH_VERIFY_CONCURRENCY || '5', 10));
      const VERIFY_THEN_PUSH = Math.max(20, parseInt(process.env.VERIFY_THEN_PUSH || '100', 10));
      let doneCount = 0;
      const skipped = { unsafe: 0, dnc: 0, cooldownWorkspace: 0, alreadyInCampaign: 0, snoozed: 0 };

      const campaignVertical = detectVertical((job.campaign_name || '') + ' ' + (job.workspace_name || ''));
      const today       = new Date().toISOString().slice(0, 10);
      const cooloffDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const targetCampLc = (job.campaign_name || '').trim().toLowerCase();

      const passesFilter = (c) => {
        if (verifyResults[c.id] !== 'safe' && verifyResults[c.id] !== 'safe_catchall') { skipped.unsafe++; return false; }
        if (c.do_not_contact) { skipped.dnc++; return false; }
        const pushed = Array.isArray(c.pushed_campaigns)
          ? c.pushed_campaigns
          : (typeof c.pushed_campaigns === 'string' ? JSON.parse(c.pushed_campaigns || '[]') : []);
        if (pushed.some(p =>
          p.workspace_id === job.workspace_id &&
          (p.campaign_id === job.campaign_id || (targetCampLc && (p.campaign_name || '').toLowerCase() === targetCampLc))
        )) { skipped.alreadyInCampaign++; return false; }
        if (targetCampLc && c.last_campaign_name && c.last_campaign_name.toLowerCase() === targetCampLc) {
          skipped.alreadyInCampaign++; return false;
        }
        if (job.workspace_id) {
          const emailed = typeof c.emailed_workspaces === 'string'
            ? JSON.parse(c.emailed_workspaces || '{}') : (c.emailed_workspaces || {});
          if (emailed[job.workspace_id]?.last_sent >= cooloffDate) { skipped.cooldownWorkspace++; return false; }
        }
        if (campaignVertical) {
          const snoozes = Array.isArray(c.snoozed_verticals)
            ? c.snoozed_verticals : JSON.parse(c.snoozed_verticals || '[]');
          if (snoozes.some(s => s.vertical === campaignVertical && s.until >= today)) { skipped.snoozed++; return false; }
        }
        return true;
      };

      const cleaningBackfills = [];

      const toLead = (c) => {
        const raw = typeof c.raw_data === 'string' ? JSON.parse(c.raw_data || '{}') : (c.raw_data || {});
        const rawCompany = c.company_name || raw['Company Name'] || '';
        const cleanedCompany = cleanCompanyName(rawCompany);
        const rawTitle = c.job_title_cleaned || c.job_title || raw['Title'] || raw['Clean Job Title'] || raw['Job Title'] || '';
        const cleanedTitle = normalizeJobTitle(rawTitle);
        if (c.id && (cleanedCompany !== c.company_name || cleanedTitle !== c.job_title_cleaned)) {
          cleaningBackfills.push({ id: c.id, company_name: cleanedCompany || null, job_title_cleaned: cleanedTitle || null });
        }
        const cleanedRaw = { ...raw };
        for (const key of ['Company Name', 'Company Name For Emails', 'Account Name', 'Organization Name']) {
          if (key in cleanedRaw) cleanedRaw[key] = cleanedCompany;
        }
        for (const key of ['Title', 'Clean Job Title', 'Job Title']) {
          if (key in cleanedRaw) cleanedRaw[key] = cleanedTitle;
        }
        return {
          email: c.email, first_name: c.first_name || '', last_name: c.last_name || '',
          phone_number: c.phone || '', company_name: cleanedCompany,
          company_website: c.company_domain || '',
          address_line: c.company_address || raw['Company Address'] || raw['Address Line'] || raw.Address || '',
          // Company is the default location target (per spec): native city/
          // state/country carry COMPANY location. Person via {{person_*}}.
          city: c.company_city || c.city || raw['Company City'] || raw.City || '',
          state: c.company_county || c.company_state || c.state || raw['Company State'] || '',
          country: c.company_country || c.country || raw['Company Country'] || raw.Country || '', job_title: cleanedTitle,
          department: c.department || '', industry: raw.Industry || c.industry || '',
          linkedin_person_url: c.linkedin_url || '', linkedin_company_url: c.company_linkedin_url || '',
          custom_variables: { seniority: c.seniority || '', email_status: verifyResults[c.id] || '', ...cleanedRaw, ...locationCustomVars(c) }
        };
      };

      const pushLeads = async (batch) => {
        for (let i = 0; i < batch.length; i += 100) {
          if (job.cancelled || job.paused) return;
          const slice = batch.slice(i, i + 100);
          let r, d = {};
          /* workspace switch handled by bisonReq wsId */ true;
          var bisonLeadPayload = (slice.map(toLead))
            // Bison requires non-empty first_name AND last_name (422s on null/""/" ").
            // Final safety net at the payload layer so no nameless lead reaches Bison
            // regardless of upstream filtering.
            .filter(function(l){ return l.first_name && String(l.first_name).trim() && l.last_name && String(l.last_name).trim(); })
            .map(function(l) {
            var cv = [];
            if (l.phone_number) cv.push({ name: 'phone_number', value: String(l.phone_number) });
            if (l.city) cv.push({ name: 'city', value: String(l.city) });
            if (l.state) cv.push({ name: 'state', value: String(l.state) });
            if (l.country) cv.push({ name: 'country', value: String(l.country) });
            if (l.industry) cv.push({ name: 'industry', value: String(l.industry) });
            if (l.linkedin_person_url) cv.push({ name: 'linkedin_person_url', value: String(l.linkedin_person_url) });
            if (l.linkedin_company_url) cv.push({ name: 'linkedin_company_url', value: String(l.linkedin_company_url) });
            if (l.company_website) cv.push({ name: 'company_website', value: String(l.company_website) });
            if (l.department) cv.push({ name: 'department', value: String(l.department) });
            if (l.address_line) cv.push({ name: 'address_line', value: String(l.address_line) });
            return { email: l.email, first_name: l.first_name || null, last_name: l.last_name || null, title: l.job_title || l.title || null, company: l.company_name || l.company || null, custom_variables: cv };
          });
          if (!bisonLeadPayload.length) { continue; }
          // Ensure every custom var these leads use exists in the workspace, or Bison 422s.
          await ensureBisonCustomVars(workspace_id, new Set(bisonLeadPayload.flatMap(function(l){ return (l.custom_variables||[]).map(function(v){ return v.name; }); })));
          var createRes = await bisonReq('/api/leads/create-or-update/multiple', { wsId: workspace_id, method: 'POST', body: { leads: bisonLeadPayload } });
          if (campaign_id && createRes && createRes.data) {
            var leadIds = (createRes.data.leads || createRes.data || []).map(function(l) { return l.id; }).filter(Boolean);
            if (leadIds.length) {
              await bisonReq('/api/campaigns/' + campaign_id + '/leads/attach-leads', { wsId: workspace_id, method: 'POST', body: { lead_ids: leadIds } }).catch(function(e) { console.warn('[bison] campaign-assign FAILED:', e.message); });
            }
          }
          r = { ok: true };
          try {
            const ids = slice.map(c => c.id).filter(Boolean);
            if (ids.length && db.stampPushedCampaign) {
              await db.stampPushedCampaign(ids, workspace_id, campaign_id, job.campaign_name || '');
            }
          } catch (err) { console.warn('[push] stampPushedCampaign failed:', err.message); }
          if (cleaningBackfills.length && db.bulkUpdateCleanedNames) {
            const toFlush = cleaningBackfills.splice(0, cleaningBackfills.length);
            db.bulkUpdateCleanedNames(toFlush).catch(err => console.warn('[push] cleanedNames backfill failed:', err.message));
          }
          job.pushed += Math.min(100, batch.length - i);
          job.progress = Math.min(99, job.progress + 1);
        }
      };

      const verifyOne = async (c, batchUpdates) => {
        if (job.cancelled || job.paused) return;
        try {
          const r = await fetch(`http://127.0.0.1:${finderPort}/api/verify-email`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: c.email, verifier: 'reacher' }),
            signal: AbortSignal.timeout(65000)
          });
          const d = await r.json();
          const smtp = d.result?.raw?.smtp || d.result?.smtp || {};
          const reason = d.result?.reason || '';
          const catchAll = smtp.is_catch_all === true || /catch_all=yes/i.test(reason);
          const reaStatus = (d.result?.status || d.result?.is_reachable || 'unknown').toLowerCase();
          const status = catchAll || reaStatus === 'risky' ? 'risky'
            : reaStatus === 'safe' || reaStatus === 'valid' ? 'safe'
            : reaStatus === 'invalid' ? 'invalid' : 'unknown';
          const mxRecords = d.result?.raw?.mx?.records || [];
          const mxHost = (mxRecords[0]?.exchange || '').toLowerCase();
          const mxProvider = /google|gmail/.test(mxHost) ? 'email_google'
            : /outlook|microsoft|protection\.outlook|mail\.microsoft/.test(mxHost) ? 'email_outlook'
            : mxHost ? 'email_other' : null;
          verifyResults[c.id] = status;
          batchUpdates.push({ id: c.id, email_status: status, email_verified_at: new Date().toISOString(), mx_provider: mxProvider, email: c.email });
        } catch {
          // Network/timeout reaching the finder itself = a real outage signal
          // (distinct from an SMTP-level "unknown" the finder returns normally).
          verifyResults[c.id] = 'unknown';
          batchUpdates.push({ id: c.id, email_status: 'unknown', email_verified_at: new Date().toISOString(), _netfail: true });
        }
        doneCount++;
        job.verified      = doneCount;
        job.safe          = Object.values(verifyResults).filter(s => s === 'safe').length;
        job.safe_catchall = Object.values(verifyResults).filter(s => s === 'safe_catchall').length;
        job.risky         = Object.values(verifyResults).filter(s => s === 'risky').length;
        job.invalid       = Object.values(verifyResults).filter(s => s === 'invalid').length;
        job.unknown       = Object.values(verifyResults).filter(s => s === 'unknown').length;
        job.progress = Math.round((doneCount / Math.max(needsVerify.length, 1)) * 85);
        const elapsed = (Date.now() - job.startedAt) / 1000;
        const rate = doneCount / elapsed;
        job.etaSeconds = rate > 0 ? Math.round((needsVerify.length - doneCount) / rate) : null;
      };

      alreadyVerified.forEach(c => { const s = c.email_status || 'unknown'; job[s] = (job[s] || 0) + 1; });

      const alreadyPassing = alreadyVerified.filter(passesFilter);
      if (alreadyPassing.length) {
        job.status = 'pushing';
        await pushLeads(alreadyPassing);
        if (job.status === 'failed' || job.cancelled || job.paused) {
          if (job.paused) job.status = 'paused';
          else if (job.cancelled) job.status = 'cancelled';
          return;
        }
      }

      for (let i = 0; i < needsVerify.length; i += VERIFY_THEN_PUSH) {
        if (job.cancelled || job.paused) break;
        const chunk = needsVerify.slice(i, i + VERIFY_THEN_PUSH);
        const batchUpdates = [];
        job.status = 'verifying';
        for (let j = 0; j < chunk.length; j += CONCURRENCY) {
          if (job.cancelled || job.paused) break;
          await Promise.all(chunk.slice(j, j + CONCURRENCY).map(c => verifyOne(c, batchUpdates)));
        }
        if (job.cancelled || job.paused) break;
        // Only abort if the finder is truly unreachable (all NETWORK failures);
        // SMTP-level "unknown" (greylist/timeout/blacklist) is normal — skip those.
        if (i === 0 && batchUpdates.length > 0 && batchUpdates.every(u => u._netfail)) {
          job.status = 'failed';
          job.error = 'Email verification failed — email-finder not responding. Try pushing without verify.';
          return;
        }
        if (batchUpdates.length) {
          db.bulkUpdateVerification(batchUpdates, { skipCatchAllPropagation: true })
            .catch(err => console.warn('[verify] background DB write failed:', err.message));
        }
        const passing = chunk.filter(passesFilter);
        if (passing.length) {
          job.status = 'pushing';
          await pushLeads(passing);
          if (job.status === 'failed') return;
        }
      }

      if (job.paused) {
        job.status = 'paused';
        if (sq) {
          try { sq.prepare(`UPDATE paused_push_jobs SET verified_count = ?, pushed_count = ? WHERE id = ?`)
            .run(job.verified || 0, job.pushed || 0, job.id); } catch {}
        }
        return;
      }

      if (!job.cancelled) {
        try {
          const riskyForPropagation = Object.entries(verifyResults)
            .filter(([, s]) => s === 'risky')
            .map(([id]) => ({ id, email_status: 'risky', email: (contacts.find(c => c.id === id) || {}).email }));
          if (riskyForPropagation.length && db.bulkUpdateVerification) {
            await db.bulkUpdateVerification(riskyForPropagation, { propagateOnly: true });
          }
        } catch (err) { console.warn('[verify] final catch-all propagation failed:', err.message); }

        const riskyContacts = contacts.filter(c => verifyResults[c.id] === 'risky');
        if (riskyContacts.length) {
          job.status = 'n2b_verifying';
          job.n2bTotal = riskyContacts.length;
          job.n2bDone  = 0;
          const n2bMap = await n2bVerify(riskyContacts.map(c => c.email), job);
          job.n2bDone = riskyContacts.length;
          const n2bUpdates = [];
          const n2bPush   = [];
          for (const c of riskyContacts) {
            const verdict = n2bMap[c.email.toLowerCase()];
            if (!verdict) continue;
            const newStatus = verdict === 'safe' ? 'safe_catchall' : verdict === 'invalid' ? 'invalid' : 'risky';
            verifyResults[c.id] = newStatus;
            n2bUpdates.push({ id: c.id, email_status: newStatus, email_verified_at: new Date().toISOString() });
            if (newStatus === 'safe_catchall' && passesFilter({ ...c })) n2bPush.push(c);
          }
          if (n2bUpdates.length) await db.bulkUpdateVerification(n2bUpdates);
          job.safe         = Object.values(verifyResults).filter(s => s === 'safe').length;
          job.safe_catchall= Object.values(verifyResults).filter(s => s === 'safe_catchall').length;
          job.risky        = Object.values(verifyResults).filter(s => s === 'risky').length;
          job.invalid      = Object.values(verifyResults).filter(s => s === 'invalid').length;
          job.unknown      = Object.values(verifyResults).filter(s => s === 'unknown').length;
          if (n2bPush.length) { job.status = 'pushing'; await pushLeads(n2bPush); }
        }
      }

      job.skipped = skipped;
      if (sq) { try { sq.prepare(`DELETE FROM paused_push_jobs WHERE id = ?`).run(job.id); } catch {} }
      job.status = job.cancelled ? 'cancelled' : 'completed';
      job.progress = 100;
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      console.error('[Verify+Push resume]', err.message);
    }
  })();
});

// ── Audience Scoring API ──────────────────────────────────────────────────
// POST /api/audience/refresh/:workspaceId
//   Rebuilds responder profile + scores all unsent contacts for this workspace.
//   Safe to call repeatedly — upserts on conflict. Takes a few seconds on
//   large contact lists.
app.post('/api/audience/refresh/:workspaceId', requireSession, async (req, res) => {
  const db = req.app.locals.pgDb;
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  const { workspaceId } = req.params;
  try {
    const result = await db.computeAudienceScores(workspaceId);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[audience] refresh failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/audience/profile/:workspaceId
//   Returns the stored responder profile (top attribute values) for a workspace.
//   Also includes a score distribution summary (how many contacts scored 100, 80, etc.)
app.get('/api/audience/profile/:workspaceId', requireSession, async (req, res) => {
  const db = req.app.locals.pgDb;
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  const { workspaceId } = req.params;
  try {
    const [profileRes, distRes] = await Promise.all([
      db.query(
        `SELECT * FROM client_audience_profiles WHERE workspace_id = $1`,
        [workspaceId]
      ),
      db.query(
        `SELECT
           score,
           COUNT(*) AS contact_count
         FROM audience_scores
         WHERE workspace_id = $1
         GROUP BY score
         ORDER BY score DESC`,
        [workspaceId]
      ),
    ]);
    const profile = profileRes.rows[0] || null;
    if (!profile) return res.json({ exists: false });
    res.json({
      exists: true,
      workspace_id: workspaceId,
      responder_count: profile.responder_count,
      sent_count: profile.sent_count,
      computed_at: profile.computed_at,
      profile: profile.profile,
      score_distribution: distRes.rows,
    });
  } catch (err) {
    console.error('[audience] profile fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/audience/recommended/:workspaceId?limit=500&minScore=40
//   Returns top-N unsent contacts sorted by lookalike score descending.
app.get('/api/audience/recommended/:workspaceId', requireSession, async (req, res) => {
  const db = req.app.locals.pgDb;
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  const { workspaceId } = req.params;
  const limit    = Math.min(2000, Math.max(1, parseInt(req.query.limit    || '500', 10)));
  const minScore = Math.max(0,           parseInt(req.query.minScore || '0',   10));
  try {
    const contacts = await db.getRecommendedBatch(workspaceId, limit, minScore);
    res.json({ workspace_id: workspaceId, count: contacts.length, contacts });
  } catch (err) {
    console.error('[audience] recommended fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/audience/seed-responders
// Backfills historical responder data from a PlusVibe reply export.
// Debug: inspect raw PlusVibe lead fields for a workspace — shows all keys on the lead object.
// GET /api/audience/pv-lead-debug?workspace_id=XXX
app.get('/api/audience/pv-lead-debug', requireAdmin, async (req, res) => {
  const wsId = String(req.query.workspace_id || '');
  if (!wsId) return res.status(400).json({ error: 'workspace_id required' });
  try {
    const leads = await bisonWorkspaceLeads(wsId, { page: 1, perPage: 3 });
    const sample = leads.map(l => ({
      keys: Object.keys(l),
      num_employees:           l.num_employees,
      estimated_num_employees: l.estimated_num_employees,
      company_size:            l.company_size,
      numEmployees:            l.numEmployees,
      variables:               l.variables || l.custom_variables || null,
    }));
    res.json({ workspace_id: wsId, count: leads.length, sample });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Body: { workspace_id, emails: [...] }
// Marks matching contacts as replied for this workspace so the scorer
// has signal to work from even before the webhook was connected.
app.post('/api/audience/seed-responders', requireSession, async (req, res) => {
  const db = req.app.locals.pgDb;
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  const { workspace_id, emails } = req.body || {};
  if (!workspace_id || !Array.isArray(emails) || !emails.length)
    return res.status(400).json({ error: 'workspace_id and emails[] required' });

  const emailsLower = emails.map(e => String(e).toLowerCase().trim()).filter(Boolean);
  try {
    // Mark contacts as replied + stamp emailed_workspaces for the workspace
    const now = new Date().toISOString();
    const r = await db.query(`
      UPDATE contacts
      SET
        status          = CASE WHEN status IN ('new','active') THEN 'replied' ELSE status END,
        last_reply_at   = COALESCE(last_reply_at, $1::timestamp),
        emailed_workspaces = jsonb_set(
          COALESCE(emailed_workspaces, '{}'::jsonb),
          ARRAY[$2],
          COALESCE(emailed_workspaces->$2, jsonb_build_object('last_sent', $3::text, 'replied', true)),
          true
        ),
        updated_at = CURRENT_TIMESTAMP
      WHERE LOWER(email) = ANY($4::text[])
    `, [now, workspace_id, now.slice(0,10), emailsLower]);

    // Also insert into email_events so the scorer's primary path finds them
    for (const email of emailsLower) {
      try {
        await db.query(`
          INSERT INTO email_events (workspace_id, lead_email, event_type, event_at, raw)
          VALUES ($1, $2, 'reply', $3, '{"seeded":true}'::jsonb)
          ON CONFLICT DO NOTHING
        `, [workspace_id, email, now]);
      } catch { /* ignore per-row errors */ }
    }

    res.json({ ok: true, matched: r.rowCount, total_emails: emailsLower.length });
  } catch (err) {
    console.error('[audience] seed-responders failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Labels we pull from PlusVibe and how each maps to a contact status.
// Order matters: when a contact appears in multiple label lists, later labels
// overwrite earlier ones in leadMap. Progression labels (CLOSED, MEETING_COMPLETED)
// are placed LAST so a closed-deal status always wins over plain LEAD.
const PV_REPLY_LABELS = [
  // Neutral first
  'REPLIED', 'INTERESTED', 'INFO',
  // Negatives middle (they override neutral via PV_NEGATIVE_LABELS)
  'NOT_INTERESTED', 'NEGATIVE_REPLY', 'DO_NOT_CONTACT', 'UNSUBSCRIBED',
  // Positive lead labels last so they win — ordered weakest → strongest
  'WEAK_LEAD', 'AWAITING_REPLY', 'ADDED_TO_ZOHO', 'LEAD',
  'MEETING_BOOKED', 'MEETING_COMPLETED',
];

// A contact carrying ANY of these labels is a delivered lead → status='interested'.
// Matches the Revenue page's LEAD_LABELS (minus NON_LEAD) so Capacity, Audience,
// and Revenue all count the same set of leads.
const PV_POSITIVE_LABELS = new Set([
  'LEAD', 'MEETING_BOOKED', 'MEETING_COMPLETED',
  'CLOSED', 'ADDED_TO_ZOHO', 'AWAITING_REPLY', 'WEAK_LEAD',
]);
// Negative labels → status='not_interested'
const PV_NEGATIVE_LABELS = new Set(['NOT_INTERESTED', 'NEGATIVE_REPLY', 'DO_NOT_CONTACT', 'UNSUBSCRIBED']);
// Everything else (REPLIED, INTERESTED, INFO) → status='replied' — positive engagement, not a delivered lead

// Derive a seniority bucket from a job title since PlusVibe never returns
// the seniority field — it only stores the raw job_title. Matches Apollo's
// own seniority taxonomy so CSV-imported and PV-seeded contacts bucket the same.
function deriveSeniority(jobTitle) {
  if (!jobTitle) return null;
  const t = String(jobTitle).toLowerCase().trim();
  if (!t) return null;
  // C-suite — check before "vp" or "director" because titles like
  // "CEO and Founder" or "Chief Operating Officer" must win.
  if (/\b(ceo|cfo|cto|coo|cmo|cio|cso|cpo|cro|cco|chief\s+\w+\s+officer|founder|co[\s\-]?founder|owner|managing\s+partner|managing\s+director|president(?!\s+of\s+\w+))\b/i.test(t)) return 'c_suite';
  if (/\b(svp|evp|vp|vice\s+president)\b/i.test(t)) return 'vp';
  if (/\b(director|head\s+of|head)\b/i.test(t)) return 'director';
  if (/\b(partner|principal)\b/i.test(t)) return 'director';
  if (/\b(senior|sr\.?|lead|manager|mgr)\b/i.test(t)) return 'manager';
  if (/\b(junior|jr\.?|associate|assistant|coordinator|intern|entry)\b/i.test(t)) return 'junior';
  return 'individual_contributor';
}

function extractPvLeadFields(l) {
  const numEmp = parseInt(l.num_employees || l.numEmployees || l.company_size || l.estimated_num_employees, 10);
  const jobTitle = l.job_title || l.jobTitle || l.title || null;
  // PV updates modified_at when a label is applied — for labelled (responder)
  // contacts this is a reasonable proxy for "when did they become a lead/reply".
  // Falls back to last_sent_at or created_at if modified_at is missing.
  const labelTs = l.modified_at || l.last_lead_replied || l.last_sent_at || l.created_at || null;
  return {
    first_name:    l.first_name || l.firstName || null,
    last_name:     l.last_name  || l.lastName  || null,
    company_name:  l.company_name || l.companyName || l.company || l.organization_name || null,
    job_title:     jobTitle,
    industry:      l.industry || null,
    num_employees: Number.isFinite(numEmp) ? numEmp : null,
    city:          l.city || null,
    country:       l.country || l.company_country || null,
    state:         l.state || l.company_state || null,
    seniority:     l.seniority || deriveSeniority(jobTitle),
    linkedin_url:  l.linkedin_url || l.linkedin_person_url || l.linkedinUrl || null,
    label_at:      labelTs,
  };
}

// Domain-consensus backfill: if one contact at firstofficehub.com has
// industry="real estate", apply it to every contact at that domain that
// lacks the field. Same for city/state/country/num_employees. 100% factual —
// we only copy data that already exists for another contact at the same domain.
// Returns { totals: { industry: N, city: N, ... } }
async function backfillContactFieldsByDomain(pgdb, workspaceId) {
  const totals = {};
  const TEXT_FIELDS = ['industry', 'city', 'state', 'country'];
  for (const field of TEXT_FIELDS) {
    try {
      const r = await pgdb.query(`
        WITH domain_vals AS (
          SELECT
            LOWER(SPLIT_PART(email, '@', 2)) AS domain,
            ${field} AS val,
            COUNT(*) AS cnt
          FROM contacts
          WHERE workspace_id = $1
            AND ${field} IS NOT NULL AND TRIM(${field}) != ''
            AND email LIKE '%@%'
          GROUP BY domain, ${field}
        ),
        top_per_domain AS (
          SELECT DISTINCT ON (domain) domain, val
          FROM domain_vals
          ORDER BY domain, cnt DESC, val ASC
        )
        UPDATE contacts c
        SET ${field} = t.val, updated_at = CURRENT_TIMESTAMP
        FROM top_per_domain t
        WHERE c.workspace_id = $1
          AND (c.${field} IS NULL OR TRIM(c.${field}) = '')
          AND LOWER(SPLIT_PART(c.email, '@', 2)) = t.domain
      `, [workspaceId]);
      totals[field] = r.rowCount || 0;
      if (r.rowCount) console.log(`[domain-backfill] ws=${workspaceId} ${field}: ${r.rowCount} contacts`);
    } catch (err) {
      console.warn(`[domain-backfill] ws=${workspaceId} ${field} failed:`, err.message);
      totals[field] = 0;
    }
  }
  try {
    const r = await pgdb.query(`
      WITH domain_vals AS (
        SELECT
          LOWER(SPLIT_PART(email, '@', 2)) AS domain,
          num_employees AS val,
          COUNT(*) AS cnt
        FROM contacts
        WHERE num_employees IS NOT NULL AND email LIKE '%@%'
        GROUP BY domain, num_employees
      ),
      top_per_domain AS (
        SELECT DISTINCT ON (domain) domain, val
        FROM domain_vals
        ORDER BY domain, cnt DESC, val DESC
      )
      UPDATE contacts c
      SET num_employees = t.val, updated_at = CURRENT_TIMESTAMP
      FROM top_per_domain t
      WHERE c.workspace_id = $1
        AND c.num_employees IS NULL
        AND LOWER(SPLIT_PART(c.email, '@', 2)) = t.domain
    `, [workspaceId]);
    totals.num_employees = r.rowCount || 0;
    if (r.rowCount) console.log(`[domain-backfill] ws=${workspaceId} num_employees: ${r.rowCount} contacts`);
  } catch (err) {
    console.warn(`[domain-backfill] ws=${workspaceId} num_employees failed:`, err.message);
    totals.num_employees = 0;
  }
  return { totals };
}

async function autoSeedWorkspaceResponders(pgdb, workspaceId, _pvFetch) {
  const pv = _pvFetch || pvFetch;
  // Map email -> { fields, status, label } — pulled across all leads + labels.
  const leadMap = new Map();

  // Pass 1: pull labeled leads so we know who replied / declined.
  for (const label of PV_REPLY_LABELS) {
    const status = PV_POSITIVE_LABELS.has(label) ? 'interested'
                 : PV_NEGATIVE_LABELS.has(label) ? 'not_interested'
                 : 'replied';
    for (let page = 1; page <= 50; page++) {
      let batch;
      try {
        batch = await bisonWorkspaceLeads(workspaceId, { label, page, perPage: 100 });
      } catch (err) {
        console.warn(`[audience-seed] ws=${workspaceId} label=${label} page=${page} error:`, err.message);
        break;
      }
      if (!batch.length) break;
      batch.forEach(l => {
        if (!l.email) return;
        const e = l.email.toLowerCase().trim();
        leadMap.set(e, { fields: extractPvLeadFields(l), status, label });
      });
      if (batch.length < 100) break;
    }
  }

  // Skip Pass 2 if workspace already has a healthy contact count — saves
  // hundreds of API calls per refresh. Pass 1 still runs to keep statuses fresh.
  let existingCount = 0;
  try {
    const r = await pgdb.query('SELECT COUNT(*)::int AS n FROM contacts WHERE workspace_id = $1', [workspaceId]);
    existingCount = r.rows[0]?.n || 0;
  } catch {}
  const skipFullPull = existingCount >= 500;
  if (skipFullPull) {
    console.log(`[audience-seed] ws=${workspaceId} skip full pull (${existingCount} contacts already)`);
  }

  // Pass 2: pull all leads (no label) to fill in non-responders.
  // Cap at 500 pages = 50k leads per workspace. Adjust if a client has more.
  for (let page = 1; !skipFullPull && page <= 500; page++) {
    let batch;
    try {
      batch = await bisonWorkspaceLeads(workspaceId, { page, perPage: 100 });
    } catch (err) {
      console.warn(`[audience-seed] ws=${workspaceId} all page=${page} error:`, err.message);
      break;
    }
    if (!batch.length) break;
    batch.forEach(l => {
      if (!l.email) return;
      const e = l.email.toLowerCase().trim();
      const fields = extractPvLeadFields(l);
      const existing = leadMap.get(e);
      if (existing) {
        // Keep labeled status, but fill in any missing fields PlusVibe provides here.
        leadMap.set(e, {
          fields: { ...fields, ...Object.fromEntries(Object.entries(existing.fields).filter(([,v]) => v != null)) },
          status: existing.status,
          label:  existing.label,
        });
      } else {
        leadMap.set(e, { fields, status: 'new', label: null });
      }
    });
    if (batch.length < 100) break;
  }

  console.log(`[audience-seed] ws=${workspaceId} total_pv_leads=${leadMap.size}`);

  const now = new Date().toISOString();
  const leads = [...leadMap.entries()].map(([email, { fields, status }]) => ({ email, fields, status }));
  const interestedCount    = leads.filter(l => l.status === 'interested').length;
  const repliedCount       = leads.filter(l => l.status === 'replied').length;
  const notInterestedCount = leads.filter(l => l.status === 'not_interested').length;

  // PlusVibe is the source of truth for who is a delivered LEAD. Any contact
  // currently marked 'interested' that is NOT in this run's LEAD set gets
  // downgraded to 'replied'. The upsert below then re-promotes real leads.
  const leadEmails = leads.filter(l => l.status === 'interested').map(l => l.email);
  try {
    const downgrade = await pgdb.query(`
      UPDATE contacts SET status = 'replied', updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = $1
        AND status = 'interested'
        AND LOWER(email) <> ALL($2::text[])
    `, [workspaceId, leadEmails]);
    if (downgrade.rowCount) console.log(`[audience-seed] ws=${workspaceId} downgraded ${downgrade.rowCount} stale 'interested' → 'replied'`);
  } catch (err) {
    console.warn(`[audience-seed] ws=${workspaceId} downgrade failed:`, err.message);
  }

  // Bulk upsert in batches via UNNEST — turns 6k+ sequential queries into ~7 batched ones.
  const BATCH = 1000;
  let upserted = 0;
  for (let i = 0; i < leads.length; i += BATCH) {
    const slice = leads.slice(i, i + BATCH);
    const emails        = slice.map(l => l.email);
    const firstNames    = slice.map(l => l.fields.first_name);
    const lastNames     = slice.map(l => l.fields.last_name);
    const companyNames  = slice.map(l => l.fields.company_name);
    const jobTitles     = slice.map(l => l.fields.job_title);
    const industries    = slice.map(l => l.fields.industry);
    const numEmps       = slice.map(l => l.fields.num_employees);
    const cities        = slice.map(l => l.fields.city);
    const states        = slice.map(l => l.fields.state);
    const countries     = slice.map(l => l.fields.country);
    const seniorities   = slice.map(l => l.fields.seniority);
    const linkedinUrls  = slice.map(l => l.fields.linkedin_url);
    const statuses      = slice.map(l => l.status);
    // Use PlusVibe's modified_at (when the label was applied) as the
    // reply timestamp — falls back to 'now' only when PV doesn't provide one.
    const lastReplyAts  = slice.map(l => {
      if (l.status !== 'interested' && l.status !== 'replied' && l.status !== 'not_interested') return null;
      if (l.fields.label_at) {
        const d = new Date(l.fields.label_at);
        if (!isNaN(d.getTime())) return d.toISOString();
      }
      return now;
    });

    try {
      await pgdb.query(`
        INSERT INTO contacts (
          workspace_id, email, first_name, last_name, company_name,
          job_title, industry, num_employees, city, state, country, seniority,
          linkedin_url, status, last_reply_at, source, imported_at
        )
        SELECT
          $1::text, email, first_name, last_name, company_name,
          job_title, industry, num_employees, city, state, country, seniority,
          linkedin_url, status, last_reply_at::timestamp, 'plusvibe', CURRENT_TIMESTAMP
        FROM UNNEST(
          $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
          $7::text[], $8::int[], $9::text[], $10::text[], $11::text[],
          $12::text[], $13::text[], $14::text[], $15::text[]
        ) AS t(email, first_name, last_name, company_name, job_title,
               industry, num_employees, city, state, country, seniority,
               linkedin_url, status, last_reply_at)
        ON CONFLICT (workspace_id, email) DO UPDATE SET
          first_name    = COALESCE(contacts.first_name,    EXCLUDED.first_name),
          last_name     = COALESCE(contacts.last_name,     EXCLUDED.last_name),
          company_name  = COALESCE(contacts.company_name,  EXCLUDED.company_name),
          job_title     = COALESCE(contacts.job_title,     EXCLUDED.job_title),
          industry      = COALESCE(contacts.industry,      EXCLUDED.industry),
          num_employees = COALESCE(contacts.num_employees, EXCLUDED.num_employees),
          city          = COALESCE(contacts.city,          EXCLUDED.city),
          state         = COALESCE(contacts.state,         EXCLUDED.state),
          country       = COALESCE(contacts.country,       EXCLUDED.country),
          -- seniority should backfill from job_title even on existing contacts
          seniority     = COALESCE(contacts.seniority,     EXCLUDED.seniority),
          linkedin_url  = COALESCE(contacts.linkedin_url,  EXCLUDED.linkedin_url),
          status = CASE
            -- 'interested' is the strongest signal — always promote to it
            WHEN EXCLUDED.status = 'interested'                                                 THEN 'interested'
            -- 'not_interested' overrides anything except 'interested'
            WHEN EXCLUDED.status = 'not_interested' AND contacts.status != 'interested'         THEN 'not_interested'
            -- 'replied' only promotes from new/active
            WHEN EXCLUDED.status = 'replied'        AND contacts.status IN ('new','active')     THEN 'replied'
            ELSE contacts.status
          END,
          -- Prefer the value from this seed (it now comes from PV's modified_at,
          -- which is more accurate than the stored value from an old seed that
          -- used NOW()). Only fall back to the existing value if the new one is null.
          last_reply_at = COALESCE(EXCLUDED.last_reply_at, contacts.last_reply_at),
          updated_at    = CURRENT_TIMESTAMP
      `, [
        workspaceId,
        emails, firstNames, lastNames, companyNames, jobTitles,
        industries, numEmps, cities, states, countries, seniorities,
        linkedinUrls, statuses, lastReplyAts,
      ]);
      upserted += slice.length;
    } catch (err) {
      console.warn(`[audience-seed] ws=${workspaceId} batch upsert ${i}-${i+slice.length} failed:`, err.message);
    }
  }

  // Backfill seniority for existing contacts that have job_title but no
  // seniority (e.g. older contacts seeded before deriveSeniority existed,
  // or contacts not re-upserted this run because Pass 2 was skipped).
  try {
    const r = await pgdb.query(
      `SELECT email, job_title FROM contacts
        WHERE workspace_id = $1 AND seniority IS NULL AND job_title IS NOT NULL AND job_title != ''`,
      [workspaceId]
    );
    if (r.rows.length) {
      const byEmail = new Map();
      r.rows.forEach(row => {
        const s = deriveSeniority(row.job_title);
        if (s) byEmail.set(row.email, s);
      });
      if (byEmail.size) {
        const ems = [...byEmail.keys()];
        const sens = [...byEmail.values()];
        await pgdb.query(
          `UPDATE contacts AS c SET seniority = t.seniority, updated_at = CURRENT_TIMESTAMP
             FROM UNNEST($2::text[], $3::text[]) AS t(email, seniority)
            WHERE c.workspace_id = $1 AND c.email = t.email AND c.seniority IS NULL`,
          [workspaceId, ems, sens]
        );
        console.log(`[audience-seed] ws=${workspaceId} backfilled seniority on ${byEmail.size} existing contacts`);
      }
    }
  } catch (err) {
    console.warn(`[audience-seed] ws=${workspaceId} seniority backfill failed:`, err.message);
  }

  // Domain-consensus backfill (factored out so the standalone endpoint
  // /api/audience/backfill-domains can call it without the slow PV walk).
  await backfillContactFieldsByDomain(pgdb, workspaceId);

  // Insert reply events for all responders (interested + replied + not_interested).
  const responderEmails = leads.filter(l =>
    l.status === 'interested' || l.status === 'replied' || l.status === 'not_interested'
  );
  if (responderEmails.length) {
    try {
      await pgdb.query(`
        INSERT INTO email_events (workspace_id, lead_email, event_type, event_at, raw)
        SELECT $1::text, email, 'reply', $2::timestamp, raw::jsonb
        FROM UNNEST($3::text[], $4::jsonb[]) AS t(email, raw)
        ON CONFLICT DO NOTHING
      `, [
        workspaceId, now,
        responderEmails.map(l => l.email),
        responderEmails.map(l => JSON.stringify({ seeded: true, auto: true, status: l.status })),
      ]);
    } catch (err) {
      console.warn(`[audience-seed] ws=${workspaceId} events batch failed:`, err.message);
    }
  }

  console.log(`[audience-seed] ws=${workspaceId} upserted=${upserted} interested=${interestedCount} replied=${repliedCount} not_interested=${notInterestedCount}`);
  return { seeded: upserted, interested: interestedCount, replied: repliedCount, not_interested: notInterestedCount };
}

// Core function — seed replies then score. Called by the daily cron and the API.
async function runAudienceScoringAll(pgdb) {
  // Skip inactive clients — they're not sending so there's no fresh data
  // to pull from PlusVibe and refreshing them just burns rate-limited API calls.
  const clients = db.prepare(
    `SELECT workspace_id, workspace_name FROM clients
     WHERE workspace_id IS NOT NULL AND workspace_id != ''
       AND (client_status IS NULL OR client_status != 'inactive')
     ORDER BY workspace_name`
  ).all();

  console.log(`[audience] starting refresh for ${clients.length} active clients`);
  const results = [];
  for (let i = 0; i < clients.length; i++) {
    const client = clients[i];
    console.log(`[audience] (${i+1}/${clients.length}) ${client.workspace_name} starting`);
    try {
      const { seeded } = await autoSeedWorkspaceResponders(pgdb, client.workspace_id, pvFetch);
      const scored = await pgdb.computeAudienceScores(client.workspace_id);
      results.push({ name: client.workspace_name, workspace_id: client.workspace_id, seeded, ...scored });
      console.log(`[audience] (${i+1}/${clients.length}) ${client.workspace_name}: seeded=${seeded} scored=${scored.scored} responders=${scored.responders}`);
      await new Promise(r => setTimeout(r, 500)); // brief pause between workspaces
    } catch (err) {
      results.push({ name: client.workspace_name, workspace_id: client.workspace_id, error: err.message });
      console.warn(`[audience] (${i+1}/${clients.length}) failed ${client.workspace_name}:`, err.message);
    }
  }
  console.log(`[audience] refresh complete — ${results.filter(r => !r.error).length}/${results.length} succeeded`);
  return results;
}

// POST /api/audience/refresh-all
app.post('/api/audience/refresh-all', requireSession, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const results = await runAudienceScoringAll(pgdb);
    res.json({ ok: true, clients: results.length, results });
  } catch (err) {
    console.error('[audience] refresh-all failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Placement Tests ───────────────────────────────────────────────────────────

let _nodemailer = null;
let _imapflow   = null;
function getNm()   { if (!_nodemailer) _nodemailer = require('nodemailer');    return _nodemailer; }
function getImap() { if (!_imapflow)   _imapflow   = require('imapflow');      return _imapflow;   }

let _placementJob = null; // { status, started_at, total, done, errors, current }

function ptSubject(domain) {
  const ts   = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(3).toString('hex');
  return `PT-${domain}-${ts}-${rand}`;
}

async function ptSendEmail(smtp, toEmail, subject) {
  const trans = getNm().createTransport({
    host: smtp.smtp_host,
    port: smtp.smtp_port || 587,
    secure: (smtp.smtp_port || 587) === 465,
    auth: { user: smtp.smtp_user, pass: smtp.smtp_password },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
  });
  await trans.sendMail({
    from: `"Test" <${smtp.from_email || smtp.smtp_user}>`,
    to: toEmail,
    subject,
    text: [
      'Hi there,',
      '',
      "I came across your company and wanted to reach out — we've been helping similar B2B teams improve their outbound results significantly over the past few months.",
      '',
      'Would it be worth a quick 15-minute call this week to see if there could be a fit?',
      '',
      'Best,',
      'The Team',
    ].join('\n'),
    html: '<p>Hi there,</p><p>I came across your company and wanted to reach out — we\'ve been helping similar B2B teams improve their outbound results significantly over the past few months.</p><p>Would it be worth a quick 15-minute call this week to see if there could be a fit?</p><p>Best,<br>The Team</p>',
  });
  trans.close();
}

// Check a single seed account for a specific subject (polling loop for manual tests).
async function ptPollSeed(seed, subject, timeoutMs = 15 * 60 * 1000) {
  const { ImapFlow } = getImap();
  const deadline = Date.now() + timeoutMs;
  const foldersToCheck = [
    { name: 'INBOX',         result: 'inbox' },
    { name: '[Gmail]/Spam',  result: 'spam'  },
    { name: 'Spam',          result: 'spam'  },
    { name: 'Junk',          result: 'spam'  },
  ];

  while (Date.now() < deadline) {
    let client;
    try {
      client = new ImapFlow({
        host: seed.imap_host, port: seed.imap_port || 993, secure: true,
        auth: { user: seed.imap_user, pass: seed.imap_password },
        logger: false, tls: { rejectUnauthorized: false },
      });
      await client.connect();
      for (const folder of foldersToCheck) {
        try {
          await client.mailboxOpen(folder.name, { readOnly: true });
          const uids = await client.search({ header: ['Subject', subject] }, { uid: true });
          if (uids.length > 0) {
            await client.logout();
            return { result: folder.result, raw_folder: folder.name };
          }
        } catch {} // folder may not exist on this provider
      }
      await client.logout();
    } catch (err) {
      try { if (client) await client.logout(); } catch {}
    }
    if (Date.now() + 30000 >= deadline) break;
    await new Promise(r => setTimeout(r, 30000));
  }
  return { result: 'inconclusive', raw_folder: null };
}

// Batch IMAP check — opens each seed once and searches for all pending subjects.
async function ptBatchCheckSeed(seed, testRecords) {
  const { ImapFlow } = getImap();
  const results = {}; // subject → { result, raw_folder }
  const foldersToCheck = [
    { name: 'INBOX',        result: 'inbox' },
    { name: '[Gmail]/Spam', result: 'spam'  },
    { name: 'Spam',         result: 'spam'  },
    { name: 'Junk',         result: 'spam'  },
  ];
  let client;
  try {
    client = new ImapFlow({
      host: seed.imap_host, port: seed.imap_port || 993, secure: true,
      auth: { user: seed.imap_user, pass: seed.imap_password },
      logger: false, tls: { rejectUnauthorized: false },
    });
    await client.connect();
    for (const folder of foldersToCheck) {
      try {
        await client.mailboxOpen(folder.name, { readOnly: true });
        for (const t of testRecords) {
          if (results[t.subject]) continue;
          const uids = await client.search({ header: ['Subject', t.subject] }, { uid: true });
          if (uids.length > 0) results[t.subject] = { result: folder.result, raw_folder: folder.name };
        }
      } catch {}
    }
    await client.logout();
  } catch (err) {
    try { if (client) await client.logout(); } catch {}
  }
  for (const t of testRecords) {
    if (!results[t.subject]) results[t.subject] = { result: 'inconclusive', raw_folder: null };
  }
  return results;
}

// Run placement test for one domain: send to all seeds simultaneously, poll IMAP.
async function ptRunDomain(pgdb, smtp, seeds, triggeredBy, batchMode = false) {
  const domain = smtp.domain;
  const sent   = [];

  await Promise.all(seeds.map(async seed => {
    const subject = ptSubject(domain);
    let id;
    try {
      const row = await pgdb.query(
        `INSERT INTO placement_tests (domain, seed_email, subject, sent_at, triggered_by) VALUES ($1,$2,$3,NOW(),$4) RETURNING id`,
        [domain, seed.email, subject, triggeredBy],
      );
      id = row.rows[0].id;
      await ptSendEmail(smtp, seed.email, subject);
      sent.push({ id, seed, subject });
    } catch (err) {
      console.error(`[placement] send fail ${domain}→${seed.email}: ${err.message}`);
      if (id) await pgdb.query(`UPDATE placement_tests SET result='inconclusive', checked_at=NOW() WHERE id=$1`, [id]);
    }
  }));

  if (batchMode) return sent; // caller handles IMAP after delay

  // Manual / per-domain mode: poll IMAP individually with full timeout
  await Promise.all(sent.map(async ({ id, seed, subject }) => {
    try {
      const { result, raw_folder } = await ptPollSeed(seed, subject);
      await pgdb.query(
        `UPDATE placement_tests SET result=$1, raw_folder=$2, checked_at=NOW() WHERE id=$3`,
        [result, raw_folder, id],
      );
    } catch (err) {
      await pgdb.query(`UPDATE placement_tests SET result='inconclusive', checked_at=NOW() WHERE id=$1`, [id]);
    }
  }));
}

async function ptGetSeeds(pgdb) {
  const r = await pgdb.query('SELECT * FROM placement_seed_accounts WHERE active=true ORDER BY id');
  return r.rows;
}

// ── Routes ─────────────────────────────────────────────────────────

app.get('/placement', requireSession, (req, res) => {
  res.sendFile(path.join(__dirname, 'placement.html'));
});

app.get('/api/placement/domains', requireSession, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const r = await pgdb.query(`
      SELECT
        dh.domain,
        dh.workspace_name,
        dh.spf,
        dh.dkim,
        dh.dmarc,
        dh.score,
        dh.status         AS health_status,
        pt.last_tested,
        pt.last_result,
        pt.inbox_count,
        pt.spam_count,
        pt.seed_count,
        (ps.domain IS NOT NULL) AS has_smtp
      FROM domain_health dh
      LEFT JOIN (
        SELECT
          domain,
          MAX(sent_at)                                                    AS last_tested,
          (array_agg(result ORDER BY sent_at DESC NULLS LAST))[1]        AS last_result,
          COUNT(CASE WHEN result='inbox' AND sent_at > NOW()-INTERVAL '8 days' THEN 1 END)::int AS inbox_count,
          COUNT(CASE WHEN result='spam'  AND sent_at > NOW()-INTERVAL '8 days' THEN 1 END)::int AS spam_count,
          COUNT(CASE WHEN sent_at > NOW()-INTERVAL '8 days' THEN 1 END)::int AS seed_count
        FROM placement_tests
        GROUP BY domain
      ) pt ON pt.domain = dh.domain
      LEFT JOIN placement_smtp_accounts ps ON ps.domain = dh.domain AND ps.active = true
      WHERE dh.ignored_at IS NULL
      ORDER BY dh.domain
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('[placement] domains query:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/placement/domains/:domain/history', requireSession, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const r = await pgdb.query(`
      SELECT id, domain, seed_email, subject, sent_at, result, raw_folder, checked_at, triggered_by
      FROM placement_tests WHERE domain=$1 ORDER BY sent_at DESC LIMIT 90
    `, [req.params.domain]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/placement/run', requireSession, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  if (_placementJob && _placementJob.status === 'running') {
    return res.json({ ok: true, already_running: true, job: _placementJob });
  }
  const { domain } = req.body || {};
  const triggeredBy = domain ? 'manual' : 'manual-all';
  _placementJob = { status: 'running', started_at: new Date().toISOString(), total: 0, done: 0, errors: 0, current: null };
  res.json({ ok: true, started: true, job: _placementJob });

  (async () => {
    try {
      const seeds = await ptGetSeeds(pgdb);
      if (!seeds.length) { _placementJob.status = 'done'; _placementJob.error = 'No seed accounts'; return; }
      const where = domain
        ? `domain=$1 AND active=true`
        : `active=true`;
      const args  = domain ? [domain] : [];
      const smtpList = (await pgdb.query(`SELECT * FROM placement_smtp_accounts WHERE ${where} ORDER BY domain`, args)).rows;
      _placementJob.total = smtpList.length;

      if (smtpList.length > 1) {
        // Batch mode: send all first, wait 12 min, then check
        const allSent = [];
        for (const smtp of smtpList) {
          _placementJob.current = smtp.domain;
          try {
            const sent = await ptRunDomain(pgdb, smtp, seeds, triggeredBy, true);
            allSent.push(...sent);
          } catch (err) {
            console.error(`[placement] send error ${smtp.domain}: ${err.message}`);
            _placementJob.errors++;
          }
          _placementJob.done++;
        }
        _placementJob.current = 'Waiting for delivery…';
        await new Promise(r => setTimeout(r, 12 * 60 * 1000));

        _placementJob.current = 'Checking inboxes…';
        for (const seed of seeds) {
          const mine = allSent.filter(t => t.seed.email === seed.email);
          if (!mine.length) continue;
          try {
            const found = await ptBatchCheckSeed(seed, mine);
            for (const { id, subject } of mine) {
              const { result, raw_folder } = found[subject] || { result: 'inconclusive', raw_folder: null };
              await pgdb.query(`UPDATE placement_tests SET result=$1, raw_folder=$2, checked_at=NOW() WHERE id=$3`, [result, raw_folder, id]);
            }
          } catch (err) { console.error(`[placement] batch IMAP fail ${seed.email}: ${err.message}`); }
        }
      } else if (smtpList.length === 1) {
        // Single domain: full polling mode
        const smtp = smtpList[0];
        _placementJob.current = smtp.domain;
        try { await ptRunDomain(pgdb, smtp, seeds, triggeredBy, false); }
        catch (err) { _placementJob.errors++; }
        _placementJob.done = 1;
      }
      _placementJob.status  = 'done';
      _placementJob.current = null;
      console.log(`[placement] run done: ${_placementJob.done} domains, ${_placementJob.errors} errors`);
    } catch (err) {
      _placementJob.status = 'failed';
      _placementJob.error  = err.message;
    }
  })();
});

app.get('/api/placement/run/status', requireSession, (req, res) => {
  res.json({ job: _placementJob });
});

// Seeds CRUD
app.get('/api/placement/seeds', requireSession, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const r = await pgdb.query('SELECT id, label, email, imap_host, imap_port, imap_user, active, created_at FROM placement_seed_accounts ORDER BY id');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/placement/seeds', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  const { label, email, imap_host, imap_port, imap_user, imap_password, active } = req.body || {};
  if (!email || !imap_host || !imap_user || !imap_password) {
    return res.status(400).json({ error: 'email, imap_host, imap_user, imap_password required' });
  }
  try {
    const r = await pgdb.query(`
      INSERT INTO placement_seed_accounts (label, email, imap_host, imap_port, imap_user, imap_password, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (email) DO UPDATE SET
        label=EXCLUDED.label, imap_host=EXCLUDED.imap_host, imap_port=EXCLUDED.imap_port,
        imap_user=EXCLUDED.imap_user, imap_password=EXCLUDED.imap_password, active=EXCLUDED.active
      RETURNING id, label, email, imap_host, imap_port, imap_user, active, created_at
    `, [label || email, email, imap_host, parseInt(imap_port) || 993, imap_user, imap_password, active !== false]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/placement/seeds/:id', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    await pgdb.query('DELETE FROM placement_seed_accounts WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SMTP CRUD
app.get('/api/placement/smtp', requireSession, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const r = await pgdb.query('SELECT id, domain, smtp_host, smtp_port, smtp_user, from_email, active, created_at FROM placement_smtp_accounts ORDER BY domain');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/placement/smtp', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  const { domain, smtp_host, smtp_port, smtp_user, smtp_password, from_email, active } = req.body || {};
  if (!domain || !smtp_host || !smtp_user || !smtp_password) {
    return res.status(400).json({ error: 'domain, smtp_host, smtp_user, smtp_password required' });
  }
  try {
    const r = await pgdb.query(`
      INSERT INTO placement_smtp_accounts (domain, smtp_host, smtp_port, smtp_user, smtp_password, from_email, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (domain) DO UPDATE SET
        smtp_host=EXCLUDED.smtp_host, smtp_port=EXCLUDED.smtp_port, smtp_user=EXCLUDED.smtp_user,
        smtp_password=EXCLUDED.smtp_password, from_email=EXCLUDED.from_email, active=EXCLUDED.active
      RETURNING id, domain, smtp_host, smtp_port, smtp_user, from_email, active, created_at
    `, [domain, smtp_host, parseInt(smtp_port) || 587, smtp_user, smtp_password, from_email || smtp_user, active !== false]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/placement/smtp/:id', requireAdmin, async (req, res) => {
  const pgdb = req.app.locals.pgDb;
  if (!pgdb) return res.status(503).json({ error: 'Database unavailable' });
  try {
    await pgdb.query('DELETE FROM placement_smtp_accounts WHERE id=$1', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Weekly placement test scheduler — runs every Sunday at 2am
function schedulePlacementTests(pgdb) {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  const daysUntilSun = now.getDay() === 0 ? 7 : 7 - now.getDay(); // always next Sunday
  next.setDate(now.getDate() + daysUntilSun);
  const msUntil = next - now;
  console.log(`[placement] next weekly sweep in ${Math.round(msUntil / 3600000)}h (${next.toISOString()})`);

  setTimeout(async () => {
    console.log('[placement] weekly sweep starting');
    if (!_placementJob || _placementJob.status !== 'running') {
      try {
        const seeds     = await ptGetSeeds(pgdb);
        const smtpList  = (await pgdb.query('SELECT * FROM placement_smtp_accounts WHERE active=true ORDER BY domain')).rows;
        if (seeds.length && smtpList.length) {
          _placementJob = { status: 'running', started_at: new Date().toISOString(), total: smtpList.length, done: 0, errors: 0, current: null };
          const allSent = [];
          for (const smtp of smtpList) {
            _placementJob.current = smtp.domain;
            try {
              const sent = await ptRunDomain(pgdb, smtp, seeds, 'scheduled', true);
              allSent.push(...sent);
            } catch (err) { _placementJob.errors++; }
            _placementJob.done++;
          }
          _placementJob.current = 'Waiting for delivery…';
          await new Promise(r => setTimeout(r, 12 * 60 * 1000));
          _placementJob.current = 'Checking inboxes…';
          for (const seed of seeds) {
            const mine = allSent.filter(t => t.seed.email === seed.email);
            if (!mine.length) continue;
            try {
              const found = await ptBatchCheckSeed(seed, mine);
              for (const { id, subject } of mine) {
                const { result, raw_folder } = found[subject] || { result: 'inconclusive', raw_folder: null };
                await pgdb.query(`UPDATE placement_tests SET result=$1, raw_folder=$2, checked_at=NOW() WHERE id=$3`, [result, raw_folder, id]);
              }
            } catch (err) { console.error(`[placement] weekly IMAP fail ${seed.email}: ${err.message}`); }
          }
          _placementJob.status = 'done';
          _placementJob.current = null;
          console.log(`[placement] weekly sweep done: ${_placementJob.done} domains`);
        }
      } catch (err) { console.error('[placement] weekly sweep failed:', err.message); }
    }
    schedulePlacementTests(pgdb);
  }, msUntil);
}

// ── Diagnostic startup backfill: seed last 30 days from email_events ─────
async function backfillDiagnosticSignals(pgdb, diagnostics) {
  try {
    // Check how many signals already exist — skip if already seeded
    const existing = await pgdb.query(
      `SELECT COUNT(*) AS n FROM diagnostic_signals WHERE timestamp > NOW() - INTERVAL '30 days'`
    );
    if (parseInt(existing.rows[0].n) > 100) {
      console.log('[diagnostics] startup backfill skipped — signals already present');
      return;
    }

    console.log('[diagnostics] seeding last 30 days of signals from perf_cache_daily…');

    // Same source as the Stats page: perf_cache_daily holds real per-day
    // sent/replies/bounces per workspace. Aggregate across all workspaces per day.
    const rows = await pgdb.query(`
      SELECT
        date,
        SUM(COALESCE((data->>'sent')::numeric, 0))    AS sends,
        SUM(COALESCE((data->>'replies')::numeric, 0)) AS replies,
        SUM(COALESCE((data->>'bounces')::numeric, 0)) AS bounces
      FROM perf_cache_daily
      WHERE date >= TO_CHAR(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')
      GROUP BY date
      HAVING SUM(COALESCE((data->>'sent')::numeric, 0)) >= 200
      ORDER BY date
    `);

    for (const r of rows.rows) {
      const ts = new Date(r.date + 'T23:30:00Z');
      const sends   = parseInt(r.sends)   || 0;
      const replies = parseInt(r.replies) || 0;
      const bounces = parseInt(r.bounces) || 0;
      const rr = sends > 0 ? Math.round((replies / sends) * 10000) / 100 : 0;
      const br = sends > 0 ? Math.round((bounces / sends) * 10000) / 100 : 0;

      diagnostics.logSignal({ timestamp: ts, signal_type: 'campaign_metrics',
        metric_key: 'daily_sends',          metric_value: sends,   unit: 'count' });
      diagnostics.logSignal({ timestamp: ts, signal_type: 'campaign_metrics',
        metric_key: 'daily_replies',        metric_value: replies, unit: 'count' });
      diagnostics.logSignal({ timestamp: ts, signal_type: 'campaign_metrics',
        metric_key: 'daily_reply_rate_pct', metric_value: rr,      unit: '%' });
      diagnostics.logSignal({ timestamp: ts, signal_type: 'bounce_analysis',
        metric_key: 'bounce_rate_pct',      metric_value: br,      unit: '%' });
      diagnostics.logSignal({ timestamp: ts, signal_type: 'bounce_analysis',
        metric_key: 'bounce_count',         metric_value: bounces, unit: 'count' });
    }

    await diagnostics._flush();
    console.log(`[diagnostics] backfill complete — ${rows.rows.length} days seeded`);
  } catch (err) {
    console.warn('[diagnostics] startup backfill failed:', err.message);
  }
}

// ── Auto-detect UK external factors via web search + Claude ───────────────
async function autoDetectUKExternalFactors(pgdb) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.log('[ext-factors] no ANTHROPIC_API_KEY, skipping auto-detect'); return; }

  const today = new Date().toISOString().split('T')[0];

  // Skip if already successfully scanned today (check app_settings for a scan-complete marker)
  try {
    const existing = await pgdb.query(
      `SELECT value FROM app_settings WHERE key = $1`, [`ext_factors_scanned_${today}`]
    );
    if (existing.rows.length) { console.log('[ext-factors] already scanned today, skipping'); return; }
  } catch(_) {}

  console.log('[ext-factors] scanning for UK disruptions on', today);

  // Build search queries — look for things that affect email campaign performance in the UK
  const queries = [
    `UK strike industrial action ${today}`,
    `Royal Mail strike ${today}`,
    `UK bank holiday public holiday June 2026`,
    `Gmail Outlook email deliverability issues ${today}`,
    `UK internet outage ISP ${today}`,
  ];

  // Fetch news snippets for each query (use a simple free news API approach via DuckDuckGo instant answers)
  const snippets = [];
  for (const q of queries) {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
      const r = await fetch(url, { headers: { 'User-Agent': 'ottaly-diagnostics/1.0' }, signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j = await r.json();
        const abstract = j.AbstractText || '';
        const related  = (j.RelatedTopics || []).slice(0, 3).map(t => t.Text || '').filter(Boolean).join(' | ');
        if (abstract || related) snippets.push(`Query: ${q}\n${abstract} ${related}`.trim());
      }
    } catch (_) {}
  }

  // Ask Claude to extract structured disruption events from the snippets
  const today_formatted = new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const userPrompt = `Today is ${today_formatted} (${today}).

You are analysing news to detect UK events that would reduce email campaign reply rates (strikes, postal disruptions, ISP outages, email provider issues, public holidays, major news events that distract people).

Search results:
${snippets.length ? snippets.join('\n\n') : 'No search results available — use your training knowledge for today\'s date.'}

Return a JSON array of disruption events for TODAY only. Empty array if none found.
Each event: {"factor_type": "strike|isp_outage|filter_change|bank_holiday|other", "description": "short description max 80 chars", "severity": "low|medium|high", "expected_impact": "brief expected effect on reply rates"}

Rules:
- Only include events happening TODAY (${today})
- Only include events that would materially affect UK email campaign reply rates
- Strikes: Royal Mail, transport, postal workers
- Bank holidays reduce reply rates ~30-50%
- ISP/Gmail/Outlook outages directly block delivery
- If nothing relevant today, return []

Return JSON array only, no explanation.`;

  try {
    const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 400,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      console.warn('[ext-factors] Claude API error', r.status, errBody.slice(0, 200));
      return;
    }
    const j = await r.json();
    const text = (j?.content?.[0]?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let events = [];
    try { events = JSON.parse(text); } catch(_) { console.warn('[ext-factors] could not parse Claude response:', text.slice(0, 200)); return; }

    if (!Array.isArray(events) || events.length === 0) {
      console.log('[ext-factors] no disruptions detected for today');
      return;
    }

    // Insert each event
    for (const ev of events) {
      if (!ev.factor_type || !ev.description) continue;
      try {
        await pgdb.query(
          `INSERT INTO diagnostic_external_factors (date, factor_type, description, severity, expected_impact, created_by)
           VALUES ($1, $2, $3, $4, $5, 'auto')
           ON CONFLICT DO NOTHING`,
          [today, ev.factor_type, ev.description.slice(0, 200), ev.severity || 'medium', ev.expected_impact || '']
        );
        console.log(`[ext-factors] logged: ${ev.factor_type} — ${ev.description}`);
      } catch(_) {}
    }

    // Mark scan complete so we don't re-run today (even if 0 events found)
    try {
      await pgdb.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [`ext_factors_scanned_${today}`, new Date().toISOString()]
      );
    } catch(_) {}
    console.log(`[ext-factors] auto-detect complete — ${events.length} event(s) found`);
  } catch (err) {
    console.warn('[ext-factors] auto-detect error:', err.message);
  }
}

// ── Diagnostic daily cron: warmup + bounce + workspace snapshots ──────────
function scheduleDiagnosticsDaily(pgdb, diagnostics) {
  const runAt = (hour, minute, fn) => {
    const fire = () => {
      const now = new Date();
      const next = new Date();
      next.setHours(hour, minute, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      setTimeout(async () => { try { await fn(); } catch(e) { console.warn('[diagnostics cron]', e.message); } fire(); }, next - now);
    };
    fire();
  };

  // 6:05am — collect warmup metrics from PlusVibe for all workspaces
  runAt(6, 5, async () => {
    console.log('[diagnostics] collecting warmup metrics');
    const workspaces = Object.values(campaignCache || {}).map(w => w.id || w.workspace_id).filter(Boolean);
    const seen = new Set();
    for (const wsId of workspaces) {
      if (seen.has(wsId)) continue;
      seen.add(wsId);
      try {
        var ea_list = await bisonListSenderEmails(wsId); // paginated (Bison caps ~15/page)
        var ea_data = ea_list.map(function(a) { return { _id: String(a.id), id: String(a.id), email: a.email || a.name, status: a.status === 'connected' ? 'active' : 'inactive', warmup_status: a.warmup_enabled ? 'ACTIVE' : 'PAUSED', daily_limit: a.daily_limit || 0, warmup_details: { inbox_pct: 0, spam_pct: 0 } }; });
        const accounts = ea_data;
        for (const acc of accounts) {
          if (acc.warmup_details) {
            diagnostics.logSignal({ signal_type: 'email_account_health', workspace_id: wsId,
              metric_key: 'warmup_inbox_pct', metric_value: acc.warmup_details.warmup_inbox_count ?? acc.warmup_details.inbox_pct ?? 0, unit: '%' });
            diagnostics.logSignal({ signal_type: 'email_account_health', workspace_id: wsId,
              metric_key: 'warmup_spam_pct',  metric_value: acc.warmup_details.warmup_spam_count  ?? acc.warmup_details.spam_pct  ?? 0, unit: '%' });
          }
          const status = acc.status || acc.connection_status || 'unknown';
          diagnostics.logSignal({ signal_type: 'email_account_health', workspace_id: wsId,
            metric_key: 'account_connected', metric_value: status === 'connected' ? 1 : 0 });
        }
      } catch(e) {
        console.warn('[diagnostics] warmup fetch failed for', wsId, e.message);
      }
    }
  });

  // 11:30pm — capture today's aggregate snapshot from perf_cache_daily
  //           (same source as the Stats page: real sent/replies/bounces per day)
  runAt(23, 30, async () => {
    console.log('[diagnostics] capturing daily snapshot from perf_cache_daily');
    try {
      const today = new Date().toISOString().split('T')[0];
      const r = await pgdb.query(`
        SELECT
          SUM(COALESCE((data->>'sent')::numeric, 0))    AS sends,
          SUM(COALESCE((data->>'replies')::numeric, 0)) AS replies,
          SUM(COALESCE((data->>'bounces')::numeric, 0)) AS bounces
        FROM perf_cache_daily
        WHERE date = $1
      `, [today]);
      const row = r.rows[0];
      const sends   = parseInt(row?.sends)   || 0;
      const replies = parseInt(row?.replies) || 0;
      const bounces = parseInt(row?.bounces) || 0;
      if (sends >= 200) {
        const rr = Math.round((replies / sends) * 10000) / 100;
        const br = Math.round((bounces / sends) * 10000) / 100;
        diagnostics.logSignal({ signal_type: 'campaign_metrics', metric_key: 'daily_sends',          metric_value: sends,   unit: 'count' });
        diagnostics.logSignal({ signal_type: 'campaign_metrics', metric_key: 'daily_replies',        metric_value: replies, unit: 'count' });
        diagnostics.logSignal({ signal_type: 'campaign_metrics', metric_key: 'daily_reply_rate_pct', metric_value: rr,      unit: '%' });
        diagnostics.logSignal({ signal_type: 'bounce_analysis',  metric_key: 'bounce_rate_pct',      metric_value: br,      unit: '%' });
        diagnostics.logSignal({ signal_type: 'bounce_analysis',  metric_key: 'bounce_count',         metric_value: bounces, unit: 'count' });
      }
    } catch(e) { console.warn('[diagnostics] snapshot failed:', e.message); }
  });

  // 7:00am — auto-detect UK external factors (strikes, bank holidays, outages)
  runAt(7, 0, () => autoDetectUKExternalFactors(pgdb));

  // 11:45pm — run daily intelligence classifier + update pattern library
  runAt(23, 45, async () => {
    const { runDailyIntelligence, updatePerformancePatterns } = require('./api-intelligence');
    const today = new Date().toISOString().split('T')[0];
    console.log('[intelligence] running daily classifier for', today);
    try {
      const result = await runDailyIntelligence(pgdb, today);
      console.log(`[intelligence] ${today} → ${result.tier} (${result.replyRate?.toFixed(1) ?? '?'}% RR)`);
      await updatePerformancePatterns(pgdb);
      console.log('[intelligence] pattern library updated');
    } catch (err) {
      console.warn('[intelligence] daily run failed:', err.message);
    }
  });
}

// ── Slack Bot — starts if env vars are present ───────────────────────────────
function startSlackBot() {
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN || !process.env.SLACK_CHANNEL_ID) {
    console.log('[slack-bot] Skipping — SLACK_BOT_TOKEN/SLACK_APP_TOKEN/SLACK_CHANNEL_ID not set');
    return;
  }
  const { spawn } = require('child_process');
  const bot = spawn('node', ['slack-bot/bot.js'], {
    cwd: __dirname,
    stdio: 'inherit',
    env: process.env,
  });
  bot.on('error', err => console.warn('[slack-bot] spawn error:', err.message));
  bot.on('close', code => {
    console.warn(`[slack-bot] exited ${code} — restarting in 10s`);
    setTimeout(startSlackBot, 10000);
  });
}

// ── ESP Sync — runs on startup then every hour ────────────────────────────────
function scheduleEspSync() {
  const { spawn } = require('child_process');
  function runSync() {
    const proc = spawn('node', ['esp-sync/sync.js'], {
      cwd: __dirname,
      stdio: 'inherit',
      env: process.env,
    });
    proc.on('error', err => console.warn('[esp-sync] spawn error:', err.message));
    proc.on('close', code => {
      if (code !== 0) console.warn(`[esp-sync] exited with code ${code}`);
    });
  }
  // Run immediately on startup
  runSync();
  // Then every hour
  setInterval(runSync, 60 * 60 * 1000);
}

// Daily 6am scheduler for audience scoring
function scheduleAudienceScoring(pgdb) {
  const now = new Date();
  const next = new Date();
  next.setHours(6, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1); // already past 6am today, aim for tomorrow
  const msUntil = next - now;
  console.log(`[audience] next scoring run in ${Math.round(msUntil / 60000)}m (${next.toISOString()})`);
  setTimeout(async () => {
    console.log('[audience] daily scoring run starting');
    try {
      const results = await runAudienceScoringAll(pgdb);
      const ok = results.filter(r => !r.error).length;
      console.log(`[audience] daily scoring done — ${ok}/${results.length} clients scored`);
    } catch (err) {
      console.error('[audience] daily scoring failed:', err.message);
    }
    scheduleAudienceScoring(pgdb); // schedule next day
  }, msUntil);
}

(async () => {
  let pgdb = null;

  // ── DataBase 1.0 connection ────────────────────────────────
  // Priority: PostgreSQL/Neon (production) → SQLite (local dev only)
  if (PostgresDatabase && (process.env.DATABASE_URL || process.env.DB_HOST)) {
    try {
      pgdb = new PostgresDatabase();
      await pgdb.init();
      const label = process.env.DATABASE_URL ? 'Neon/PostgreSQL' : 'PostgreSQL';
      console.log(`[DataBase 1.0] Connected via ${label}`);
    } catch (err) {
      console.error('[DataBase 1.0] PostgreSQL failed:', err.message);
      pgdb = null;
    }
  }

  // SQLite fallback — ONLY for local dev (no DATABASE_URL set).
  // In production (DATABASE_URL set) we never fall back: the SQLite contacts
  // schema is missing columns like snoozed_verticals, so falling back would
  // make webhook queries fail at parse time. Better to leave pgDb null so
  // the webhook retry loop queues events until Postgres comes back.
  const inProduction = !!process.env.DATABASE_URL;
  if (!pgdb && SqliteDatabase && !inProduction) {
    try {
      pgdb = new SqliteDatabase();
      await pgdb.init();
      console.warn('[DataBase 1.0] Using SQLite (LOCAL DEV ONLY — data will be lost on redeploy!)');
      console.warn('[DataBase 1.0] Set DATABASE_URL env var to connect to Neon for production.');
    } catch (err) {
      console.error('[DataBase 1.0] SQLite failed:', err.message);
      pgdb = null;
    }
  } else if (!pgdb && inProduction) {
    console.error('[DataBase 1.0] Postgres unavailable in production — refusing SQLite fallback. Webhooks will retry until Postgres is back.');
  }

  if (!pgdb) {
    console.warn('[DataBase 1.0] No database available. Set DATABASE_URL to enable contacts feature.');
  }

  if (pgdb) {
    app.locals.pgDb = pgdb;
    app.locals.sqliteDb = db;
    restorePausedJobs(db);

    // Hydrate the dashboard-set Bison API key (if any) so it takes precedence
    // over the env var. A key saved later via /api/admin/bison-key updates
    // _bisonKeyOverride directly, so no restart is needed.
    pgdb.getSetting('bison_api_key', null).then((saved) => {
      if (saved && typeof saved === 'string' && saved.trim()) {
        _bisonKeyOverride = saved.trim();
        console.log('[bison] using dashboard-set API key (…' + _bisonKeyOverride.slice(-4) + ')');
      }
    }).catch((e) => console.warn('[bison] key hydrate failed:', e.message));

    // Hydrate per-workspace Bison tokens (the logout fix). When present, _bisonRaw
    // and bisonFetch use these instead of switching the shared super-admin token.
    pgdb.getSetting('bison_ws_tokens', null).then((saved) => {
      if (saved && typeof saved === 'object') {
        _bisonWsTokens = saved;
        const n = Object.values(saved).filter((v) => v && String(v).trim()).length;
        if (n) console.log(`[bison] using ${n} per-workspace token(s) — crons will not switch-workspace for those`);
      }
    }).catch((e) => console.warn('[bison] ws-token hydrate failed:', e.message));

    // Hydrate the "fresh start" cutover date + show-historical toggle.
    hydrateFreshStart(pgdb).then(() => {
      if (_freshStartDate) console.log(`[fresh-start] cutover ${_freshStartDate}, historical ${_showHistorical ? 'ON' : 'OFF'}`);
    });

    // One-time backfill: copy existing SQLite client notes into Postgres.
    // ON CONFLICT DO NOTHING means this never overwrites a note that was
    // already saved via the new dual-write path.
    setTimeout(async () => {
      try {
        const withNotes = db.prepare(
          `SELECT workspace_id, notes FROM clients WHERE notes IS NOT NULL AND notes != ''`
        ).all();
        if (!withNotes.length) return;
        for (const { workspace_id, notes } of withNotes) {
          await pgdb.query(
            `INSERT INTO client_notes (workspace_id, notes, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (workspace_id) DO NOTHING`,
            [workspace_id, notes]
          );
        }
        console.log(`[startup] Backfilled notes for ${withNotes.length} client(s) into Postgres`);
      } catch (err) {
        console.warn('[startup] Client notes backfill failed:', err.message);
      }
    }, 3000);

    // Auto-resume any enrichment job that was running before a server restart
    setTimeout(async () => {
      try {
        await enrichDbState(pgdb);
        const job = await loadEnrichJob(pgdb);
        if (job && job.status === 'running' && !job.paused) {
          // Mark as stopped — require manual restart to avoid resuming stale jobs after deploy
          job.status = 'stopped';
          job.paused = true;
          await saveEnrichJob(pgdb, job).catch(() => {});
          console.log(`[enrich] Stale running job found on startup — marked stopped. Use UI to restart.`);
        }
      } catch (e) { console.warn('[enrich] auto-resume check failed:', e.message); }
    }, 5000);
    app.use('/api', contactsAPI(pgdb));
    app.get('/contacts', (req, res) => {
      res.sendFile(path.join(__dirname, 'contacts.html'));
    });
    // Sync technologies → email_* tags for all contacts. Fast single-pass
    // bulk UPDATE so Email Provider counts include tech-stack data.
    // Fire-and-forget — runs in background after server is up.
    setTimeout(() => {
      pgdb.backfillEmailProviders()
        .then(r => console.log(`[startup] Email provider backfill: ${r.updated} contacts tagged`))
        .catch(err => console.warn('[startup] Email provider backfill failed:', err.message));
    }, 15000);

    // Seed the true-MX domain cache from contacts already verified with a real
    // MX provider. One-time recovery of the back-catalogue: each domain's
    // verified provider is cached, then fanned out to its unclassified
    // contacts. Idempotent (ON CONFLICT DO NOTHING) so repeat boots are cheap.
    setTimeout(() => {
      pgdb.seedDomainMxCacheFromVerified()
        .then(r => console.log(`[startup] Domain MX cache seed: ${r.domainsSeeded} domains seeded, ${r.contactsFilled} contacts classified from verified domains`))
        .catch(err => console.warn('[startup] Domain MX cache seed failed:', err.message));
    }, 30000);

    // Audience scoring — daily at 6am
    scheduleAudienceScoring(pgdb);
    // Placement tests — weekly on Sunday at 2am
    schedulePlacementTests(pgdb);

    // ── Diagnostic Intelligence System ────────────────────────────────────
    const diagnostics = require('./api-diagnostics');
    diagnostics.init(pgdb);
    diagnostics.startInfraPolling(60_000); // memory + event-loop lag every 60s

    // Warmup metrics + bounce aggregation — daily at 6:05am (5 min after audience run)
    scheduleDiagnosticsDaily(pgdb, diagnostics);

    // Backfill last 30 days of campaign + bounce signals from email_events on startup
    setTimeout(() => backfillDiagnosticSignals(pgdb, diagnostics), 8000);
    // Scan for UK external factors on startup (catches today's events after deploy)
    setTimeout(() => autoDetectUKExternalFactors(pgdb), 15000);
    // Backfill + update intelligence logs and pattern library on startup
    setTimeout(async () => {
      const { ensureUniqueConstraint, backfillIntelligenceLogs } = require('./api-intelligence');
      await ensureUniqueConstraint(pgdb);
      // One-time cleanup: wipe corrupt intelligence data (reply rates > 100% are impossible)
      try {
        const corrupt = await pgdb.query(`SELECT COUNT(*) AS n FROM daily_intelligence_logs WHERE reply_rate > 100`);
        if (parseInt(corrupt.rows[0].n) > 0) {
          console.log('[intelligence] wiping corrupt logs (reply_rate > 100%)…');
          await pgdb.query(`TRUNCATE daily_intelligence_logs`);
          await pgdb.query(`TRUNCATE performance_patterns`);
          // Also delete orphan reply events that caused the corruption
          await pgdb.query(`
            DELETE FROM email_events
            WHERE event_type IN ('reply', 'interested', 'bounce')
              AND DATE(event_at) IN (
                SELECT DATE(event_at) FROM email_events
                GROUP BY DATE(event_at)
                HAVING COUNT(*) FILTER (WHERE event_type = 'sent') = 0
              )
          `);
          console.log('[intelligence] corrupt data cleared — re-backfilling…');
        }
      } catch(e) { console.warn('[intelligence] cleanup check failed:', e.message); }
      await backfillIntelligenceLogs(pgdb);
    }, 20000);
  }
  scheduleEspSync();
  startSlackBot();

  // Auto-register Bison webhooks on startup (idempotent — checks before creating)
  setTimeout(async function() {
    // Register the admin webhook for EVERY client workspace. Bison's
    // /api/workspaces/v1.1 only returns the token's own team (not all clients),
    // so we iterate the known BISON_TEAMS map instead — otherwise lead events
    // for most clients never fire and never reach the client dashboard.
    const adminUrl = process.env.BISON_WEBHOOK_ADMIN_URL || 'https://ottaly-git.oix3xv.easypanel.host/webhook/plusvibe-reply';
    for (const team of BISON_TEAMS) {
      try {
        const existing = await bisonReq('/api/webhook-url', { wsId: team.team_id }).catch(() => ({ data: [] }));
        const already = (existing.data || []).some(function(h) { return h.url === adminUrl; });
        if (!already) {
          await bisonReq('/api/webhook-url', { wsId: team.team_id, method: 'POST', body: { name: 'Ottaly Admin', url: adminUrl, events: ['lead_interested', 'lead_replied', 'email_sent', 'email_bounced', 'untracked_reply_received'] } });
          console.log(`[bison] webhook registered for ${team.name} (team ${team.team_id})`);
        } else {
          console.log(`[bison] webhook already exists for ${team.name} (team ${team.team_id})`);
        }
        await new Promise(r => setTimeout(r, 300)); // gentle pacing between workspaces
      } catch (e) {
        console.warn(`[bison] webhook register failed for ${team.name} (team ${team.team_id}):`, e.message);
      }
    }
  }, 5000);

  // Sentry error handler after routes, before the generic fallback (v8+ API).
  Sentry.setupExpressErrorHandler(app);
  app.use((err, req, res, next) => {
    console.error('[Server Error]', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(PORT, () => console.log(`Ottaly running on http://localhost:${PORT}`));

  server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/automation-browser')) {
    socket.destroy();
    return;
  }
  const targetPath = stripAutomationBrowserPrefix(req.url);
  const proxySocket = net.connect(Number(AUTOMATION_NOVNC_PORT), '127.0.0.1', () => {
    const headers = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      .join('\r\n');
    proxySocket.write(`${req.method} ${targetPath} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head && head.length) proxySocket.write(head);
    socket.pipe(proxySocket).pipe(socket);
  });
  proxySocket.on('error', () => socket.destroy());
  });
})();
