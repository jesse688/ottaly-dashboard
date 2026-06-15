#!/usr/bin/env node
/**
 * Safely suppress contacts on genuinely-dead domains.
 *
 * A single MX lookup returning empty is NOT reliable — ~20-25% of the
 * gateway scan's "NO MX" domains are false positives (transient DNS
 * timeouts, or domains that accept mail via an A-record fallback). So this
 * script RE-VERIFIES each candidate twice (MX + A, with a gap) and only
 * confirms a domain dead when BOTH checks show no MX AND no A record.
 *
 * Confirmed-dead domains are recorded in dead_domains (auditable/reversible).
 * With --suppress, affected contacts get do_not_contact=true + a reply_notes
 * marker. Dry-run by default — prints counts, changes nothing.
 *
 * Usage:
 *   node scripts/suppress-dead-domains.js              # dry run: verify + report
 *   node scripts/suppress-dead-domains.js --suppress   # also set do_not_contact
 */

const { Pool } = require('pg');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(__dirname, '../../admin-new/.env.local');
  const line = fs.readFileSync(envPath, 'utf8')
    .split('\n').find(l => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL not found in ' + envPath);
  return line.slice('DATABASE_URL='.length).trim();
}

const SUPPRESS = process.argv.includes('--suppress');
const CONCURRENCY = 30;
const pool = new Pool({ connectionString: loadDatabaseUrl(), ssl: false });

function dig(type, domain) {
  return new Promise((resolve) => {
    execFile('dig', ['+short', `+time=4`, '+tries=2', type, domain],
      { timeout: 9000, killSignal: 'SIGKILL' }, (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const lines = stdout.trim().split('\n')
          .map(l => l.trim())
          .filter(l => l && !/connection timed out|no servers/i.test(l));
        resolve(lines);
      });
  });
}

// A domain is dead only if it has NO MX and NO A record, confirmed on a
// second pass. Two passes guard against a single transient DNS failure.
async function isDead(domain) {
  const mx1 = await dig('MX', domain);
  if (mx1.length) return false;                 // has MX -> alive, stop early
  const a1 = await dig('A', domain);
  if (a1.length) return false;                  // A-record fallback -> can receive
  // first pass says dead — confirm with a second pass before trusting it
  const mx2 = await dig('MX', domain);
  if (mx2.length) return false;
  const a2 = await dig('A', domain);
  if (a2.length) return false;
  return true;                                  // no MX, no A, twice -> dead
}

async function ensureDeadTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dead_domains (
      domain      TEXT PRIMARY KEY,
      confirmed_at TIMESTAMP DEFAULT now(),
      contacts    INT
    )`);
}

async function main() {
  await ensureDeadTable();

  // Candidates = scan said NO MX, and not already confirmed dead.
  const { rows: candidates } = await pool.query(`
    SELECT g.domain, COUNT(c.id) AS contacts
    FROM gateway_mx_cache g
    JOIN contacts c ON lower(split_part(c.email,'@',2)) = g.domain
    LEFT JOIN dead_domains d ON d.domain = g.domain
    WHERE g.gateway = 'NO MX / unresolved' AND d.domain IS NULL
    GROUP BY g.domain`);

  console.error(`${candidates.length} candidate dead domains to re-verify (2-pass MX+A)...`);

  const confirmed = [];
  let checked = 0;
  const queue = [...candidates];
  async function worker() {
    while (queue.length) {
      const c = queue.pop();
      if (await isDead(c.domain)) confirmed.push(c);
      if (++checked % 100 === 0) console.error(`  verified ${checked}/${candidates.length} — ${confirmed.length} dead so far`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const deadContacts = confirmed.reduce((s, c) => s + Number(c.contacts), 0);
  const falsePositives = candidates.length - confirmed.length;
  console.log('');
  console.log(`Candidates re-verified : ${candidates.length}`);
  console.log(`Confirmed dead         : ${confirmed.length} domains (${deadContacts} contacts)`);
  console.log(`Rescued (false dead)   : ${falsePositives} domains were actually alive`);

  // Record newly confirmed-dead domains (idempotent). Note: candidates already
  // in dead_domains were excluded above, so `confirmed` is only NEW ones — but
  // suppression below acts on the FULL dead_domains table, not just this run.
  for (let i = 0; i < confirmed.length; i += 500) {
    const chunk = confirmed.slice(i, i + 500);
    const vals = []; const params = [];
    chunk.forEach((c, j) => { const b = j * 2; vals.push(`($${b+1}, $${b+2})`); params.push(c.domain, Number(c.contacts)); });
    await pool.query(
      `INSERT INTO dead_domains (domain, contacts) VALUES ${vals.join(',')}
       ON CONFLICT (domain) DO UPDATE SET contacts = EXCLUDED.contacts, confirmed_at = now()`, params);
  }
  if (confirmed.length) console.log(`Recorded ${confirmed.length} newly-dead domains in dead_domains.`);

  const { rows: [{ total }] } = await pool.query(`SELECT count(*)::int total FROM dead_domains`);
  console.log(`Total confirmed-dead domains on record: ${total}`);

  if (!SUPPRESS) {
    console.log('\nDRY RUN — no contacts suppressed. Re-run with --suppress to set do_not_contact.');
    await pool.end();
    return;
  }

  // Suppress: do_not_contact=true + note. Only flips contacts not already DNC.
  const res = await pool.query(`
    UPDATE contacts SET
      do_not_contact = true,
      reply_notes = COALESCE(reply_notes || ' | ', '') || 'dead-domain (no MX/A, 2-pass verified) ' || to_char(now(),'YYYY-MM-DD'),
      updated_at = CURRENT_TIMESTAMP
    WHERE lower(split_part(email,'@',2)) IN (SELECT domain FROM dead_domains)
      AND COALESCE(do_not_contact,false) = false`);
  console.log(`\nSuppressed ${res.rowCount} contacts (do_not_contact=true).`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
