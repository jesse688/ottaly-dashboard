#!/usr/bin/env node
/**
 * Gateway deliverability analysis.
 *
 * Question: of all the inbound email gateways we send to (Mimecast, Proofpoint,
 * Barracuda, Cisco, plain Google/Microsoft, ...), which ones reply / convert /
 * bounce well, and which do badly?
 *
 * The gateway is NOT stored anywhere — contacts.mx_provider was collapsed to
 * google/outlook/other and the raw MX hostname was discarded. So we re-resolve
 * MX (dig) for each domain we've sent to, classify it, then join to per-contact
 * reply/lead/bounce signals.
 *
 * Data-model facts (see memory project_gateway_analysis):
 *   - "sent to"  = contacts.emailed_workspaces <> '{}'  (NOT email_events 'sent')
 *   - replies    = email_events keyed by lead_email; COUNT DISTINCT (rows are dup'd)
 *   - OOO/lead   = email_events.raw->>'label'
 *
 * Usage:
 *   node scripts/gateway-analysis.js [--sample N] [--full] [--bucket other]
 *     --sample N   resolve a random N-domain sample (default 2000)
 *     --full       resolve every sent-to domain (~64k, slow)
 *     --bucket X   restrict to contacts whose mx_provider = email_X (e.g. other)
 */

const { Pool } = require('pg');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── DATABASE_URL: lives in admin-new/.env.local, not this app's .env ──────────
function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(__dirname, '../../admin-new/.env.local');
  const line = fs.readFileSync(envPath, 'utf8')
    .split('\n').find(l => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL not found in ' + envPath);
  return line.slice('DATABASE_URL='.length).trim();
}

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? (args[i + 1] || true) : def;
};
const FULL   = args.includes('--full');
const SAMPLE = parseInt(getArg('sample', '2000'), 10);
const BUCKET = getArg('bucket', null); // e.g. 'other' -> email_other
const DNS_CONCURRENCY = 40;

const pool = new Pool({ connectionString: loadDatabaseUrl(), ssl: false });

// ── Gateway classification from MX hostname ──────────────────────────────────
// Each pattern is matched (lowercased) against the MX target host. Order matters
// only for readability; patterns are disjoint in practice.
const GATEWAY_PATTERNS = [
  ['Mimecast',           [/\.mimecast\./, /mimecast\.com$/, /mimecast\.co\.za/]],
  ['Proofpoint',         [/pphosted\.com$/, /ppe-hosted\.com$/, /\.pphosted\./]],
  ['Barracuda',          [/barracudanetworks\.com$/, /barracuda\.com$/, /\.ess\.barracuda/]],
  ['Cisco Ironport',     [/iphmx\.com$/, /\.cisco\.com$/, /ironport/]],
  ['Forcepoint/Mailcontrol', [/mailcontrol\.com$/, /forcepoint/]],
  ['Sophos',             [/sophos\.com$/, /\.hydra\.sophos/]],
  ['Trend Micro',        [/trendmicro\.com$/, /\.tmes\.trendmicro/]],
  ['FortiMail',          [/fortimail/, /fortinet\.com$/]],
  ['Sophos/Reflexion',   [/reflexion\.net$/]],
  ['Microsoft 365',      [/\.mail\.protection\.outlook\.com$/, /\.olc\.protection\.outlook\.com$/, /outlook\.com$/, /\.protection\.outlook/]],
  ['Google Workspace',   [/\.google\.com$/, /googlemail\.com$/, /aspmx\.l\.google/, /\.googlemail\./, /psmtp\.com$/]],
  ['Microsoft (on-prem hybrid)', [/\.protection\.partner\.outlook/]],
  ['Zoho',               [/zoho\.com$/, /zohomail/]],
  ['Fastmail',           [/messagingengine\.com$/, /fastmail/]],
];

function classifyGateway(mxHosts) {
  if (!mxHosts || mxHosts.length === 0) return 'NO MX / unresolved';
  const joined = mxHosts.map(h => h.toLowerCase()).join(' ');
  for (const [name, patterns] of GATEWAY_PATTERNS) {
    if (patterns.some(p => mxHosts.some(h => p.test(h.toLowerCase())) || p.test(joined))) {
      return name;
    }
  }
  return 'Other / self-hosted';
}

// ── DNS: resolve MX for a domain via system `dig` ────────────────────────────
// dig is bounded by its OWN flags (+time/+tries) AND by execFile timeout+SIGKILL.
// Belt-and-braces because at 64k domains a single hung lookup with no hard kill
// permanently starves a worker slot — that's what wedged the first full run.
function digMx(domain) {
  return new Promise((resolve) => {
    execFile(
      'dig', ['+short', '+time=3', '+tries=1', 'MX', domain],
      { timeout: 6000, killSignal: 'SIGKILL' },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);  // timeout/NXDOMAIN/etc -> no MX
        const hosts = stdout.trim().split('\n')
          .map(l => l.trim().split(/\s+/).pop())          // "10 mx.foo.com." -> "mx.foo.com."
          .filter(Boolean)
          .map(h => h.replace(/\.$/, ''));                 // strip trailing dot
        resolve(hosts);
      }
    );
  });
}

async function resolveAll(domains, cache, onBatch) {
  const todo = domains.filter(d => !cache.has(d));
  console.error(`  ${cache.size} cached, ${todo.length} to resolve via DNS...`);
  let done = 0;
  const queue = [...todo];
  const justDone = [];                  // domains resolved since last flush
  const SAVE_EVERY = 1000;              // persist progress so a crash loses <1k
  async function flush() {
    if (!justDone.length || !onBatch) return;
    const batch = justDone.splice(0, justDone.length);
    try { await onBatch(batch); } catch (e) { console.error('  save failed:', e.message); }
  }
  async function worker() {
    while (queue.length) {
      const d = queue.pop();
      const hosts = await digMx(d);
      cache.set(d, hosts);
      justDone.push(d);
      if (++done % 200 === 0) {
        console.error(`    resolved ${done}/${todo.length} (${new Date().toISOString()})`);
      }
      if (justDone.length >= SAVE_EVERY) await flush();
    }
  }
  await Promise.all(Array.from({ length: DNS_CONCURRENCY }, worker));
  await flush();
  return cache;
}

// ── MX cache table — so we only ever resolve a domain once ───────────────────
async function ensureCacheTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gateway_mx_cache (
      domain     TEXT PRIMARY KEY,
      mx_hosts   TEXT[],
      gateway    TEXT,
      resolved_at TIMESTAMP DEFAULT now()
    )`);
}

async function loadCache() {
  const { rows } = await pool.query(`SELECT domain, mx_hosts FROM gateway_mx_cache`);
  const cache = new Map();
  for (const r of rows) cache.set(r.domain, r.mx_hosts || []);
  return cache;
}

async function saveCache(domains, cache) {
  // upsert only the domains we touched this run
  const fresh = domains.filter(d => cache.has(d));
  for (let i = 0; i < fresh.length; i += 500) {
    const chunk = fresh.slice(i, i + 500);
    const values = [];
    const params = [];
    chunk.forEach((d, j) => {
      const b = j * 3;
      const hosts = cache.get(d);
      values.push(`($${b + 1}, $${b + 2}::text[], $${b + 3})`);
      params.push(d, hosts, classifyGateway(hosts));
    });
    await pool.query(`
      INSERT INTO gateway_mx_cache (domain, mx_hosts, gateway)
      VALUES ${values.join(',')}
      ON CONFLICT (domain) DO UPDATE
        SET mx_hosts = EXCLUDED.mx_hosts,
            gateway  = EXCLUDED.gateway,
            resolved_at = now()`, params);
  }
}

// ── Pull the per-contact fact table: domain + sent + reply/lead/ooo/bounce ────
async function loadContactFacts() {
  const bucketFilter = BUCKET ? `AND c.mx_provider = 'email_${BUCKET}'` : '';
  // One row per contact we sent to, with their domain and outcome flags.
  // Replies/labels come from email_events (deduped to the contact level).
  const sql = `
    WITH sent AS (
      SELECT c.id,
             lower(split_part(c.email,'@',2)) AS domain,
             c.email,
             c.bounced_at,
             c.status
      FROM contacts c
      WHERE COALESCE(c.emailed_workspaces,'{}'::jsonb) <> '{}'::jsonb
        AND c.email LIKE '%@%'
        ${bucketFilter}
    ),
    ev AS (
      SELECT lower(lead_email) AS email,
             bool_or(event_type IN ('reply','positive_reply','all_email_replies')) AS replied,
             -- substantive = at least one reply NOT labelled out-of-office/auto.
             -- (label is blank on most real replies, OOO/AUTOMATIC_REPLY on bots.)
             bool_or(event_type IN ('reply','positive_reply','all_email_replies')
                     AND COALESCE(raw->>'label','') NOT IN ('OUT_OF_OFFICE','AUTOMATIC_REPLY')) AS replied_substantive,
             bool_or(event_type = 'lead'
                     OR raw->>'label' IN ('LEAD','INTERESTED_NONLEAD'))            AS is_lead,
             bool_or(event_type = 'bounce')                                         AS bounced_ev
      FROM email_events
      GROUP BY 1
    )
    SELECT s.domain,
           count(*)                                              AS sent,
           count(*) FILTER (WHERE e.replied)                     AS replied,
           count(*) FILTER (WHERE e.replied_substantive)        AS replied_no_ooo,
           count(*) FILTER (WHERE e.is_lead)                     AS leads,
           count(*) FILTER (WHERE e.bounced_ev
                               OR s.bounced_at IS NOT NULL)      AS bounced
    FROM sent s
    LEFT JOIN ev e ON e.email = lower(s.email)
    GROUP BY s.domain`;
  const { rows } = await pool.query(sql);
  return rows;
}

function pct(n, d) { return d ? (100 * n / d) : 0; }

async function main() {
  console.error('Loading contact facts (sent / reply / lead / bounce per domain)...');
  const facts = await loadContactFacts();
  console.error(`  ${facts.length} distinct sent-to domains`);

  await ensureCacheTable();
  const cache = await loadCache();

  // Choose domains to resolve: full, or a sample weighted by send volume.
  let domains;
  if (FULL) {
    domains = facts.map(f => f.domain);
  } else {
    // weight by sent count so the sample reflects real volume, but cap so a few
    // huge domains don't dominate — simple: sort by sent desc, take a spread.
    const sorted = [...facts].sort((a, b) => b.sent - a.sent);
    // take all already-cached + fill the rest up to SAMPLE with highest-volume uncached
    const cached = sorted.filter(f => cache.has(f.domain));
    const uncached = sorted.filter(f => !cache.has(f.domain));
    domains = [...cached, ...uncached.slice(0, Math.max(0, SAMPLE - cached.length))]
      .map(f => f.domain);
    console.error(`Sample mode: analysing ${domains.length} domains ` +
      `(${cached.length} cached + up to ${SAMPLE} target).`);
  }

  // Persist incrementally as batches resolve, so a crash/stall keeps progress
  // (and the dashboard page starts populating mid-run).
  await resolveAll(domains, cache, (batch) => saveCache(batch, cache));
  await saveCache(domains, cache);  // final sweep-up for anything not yet flushed

  // ── Aggregate by gateway over the resolved domains ─────────────────────────
  const domainSet = new Set(domains);
  const byGw = new Map();
  let totalSent = 0;
  for (const f of facts) {
    if (!domainSet.has(f.domain)) continue;
    const gw = classifyGateway(cache.get(f.domain) || []);
    const a = byGw.get(gw) || { gateway: gw, domains: 0, sent: 0, replied: 0, replied_no_ooo: 0, leads: 0, bounced: 0 };
    a.domains += 1;
    a.sent += +f.sent;
    a.replied += +f.replied;
    a.replied_no_ooo += +f.replied_no_ooo;
    a.leads += +f.leads;
    a.bounced += +f.bounced;
    byGw.set(gw, a);
    totalSent += +f.sent;
  }

  const rows = [...byGw.values()].sort((a, b) => b.sent - a.sent);

  // ── Print ──────────────────────────────────────────────────────────────────
  const fmt = (s, w) => String(s).padEnd(w);
  const fmtR = (s, w) => String(s).padStart(w);
  console.log('\n' + '='.repeat(110));
  console.log(`GATEWAY DELIVERABILITY — ${FULL ? 'FULL' : 'SAMPLE'} run` +
    (BUCKET ? ` (mx_provider=email_${BUCKET} only)` : '') +
    `  •  ${rows.length} gateways  •  ${totalSent.toLocaleString()} sends`);
  console.log('='.repeat(110));
  console.log(
    fmt('Gateway', 28) + fmtR('Domains', 8) + fmtR('Sent', 9) +
    fmtR('Reply%', 9) + fmtR('Reply%-OOO', 12) + fmtR('Lead%', 8) +
    fmtR('RTL', 8) + fmtR('Bounce%', 9));
  console.log('-'.repeat(110));
  for (const r of rows) {
    const replyP   = pct(r.replied, r.sent);
    const replyNo  = pct(r.replied_no_ooo, r.sent);
    const leadP    = pct(r.leads, r.sent);
    const rtl      = r.sent ? (1000 * r.leads / r.sent) : 0;  // leads per 1000 sent
    const bounceP  = pct(r.bounced, r.sent);
    console.log(
      fmt(r.gateway, 28) +
      fmtR(r.domains.toLocaleString(), 8) +
      fmtR(r.sent.toLocaleString(), 9) +
      fmtR(replyP.toFixed(2), 9) +
      fmtR(replyNo.toFixed(2), 12) +
      fmtR(leadP.toFixed(2), 8) +
      fmtR(rtl.toFixed(1), 8) +
      fmtR(bounceP.toFixed(2), 9));
  }
  console.log('-'.repeat(110));
  console.log('Reply% = any reply / sent.  Reply%-OOO = replies excluding out-of-office/auto.');
  console.log('Lead% = positive leads / sent.  RTL = leads per 1,000 sent.  Bounce% = bounced / sent.');
  console.log('Note: SAMPLE skews to high-volume domains; run --full for the true picture.\n');

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
