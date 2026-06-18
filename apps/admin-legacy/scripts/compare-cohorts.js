#!/usr/bin/env node
// Compare two mailbox cohorts — Winnr Generic vs all SMTP — by SENT + REPLIES.
//
// REPLIES are EXACT (per-mailbox, straight from unibox_replies) for both cohorts.
// SMTP SENT is EXACT (mailbox_daily_stats stores provider='smtp' directly).
// GENERIC SENT has no per-mailbox source in Bison (it must be apportioned from
// each workspace's Winnr total, which needs the live roster's workspace_id) — so
// this script pulls that one number from the winnr-generic-stats endpoint that
// already does it. Set BASE + COOKIE to enable, else it's skipped.
//
//   DATABASE_URL=... node scripts/compare-cohorts.js              # lifetime
//   DATABASE_URL=... DAYS=7 node scripts/compare-cohorts.js       # last 7 days
//   DATABASE_URL=... BASE=http://localhost:3000 COOKIE='session=…' node scripts/compare-cohorts.js
//
// NOTE: generic mailboxes are SMTP-type, so the "ALL SMTP" reply/sent totals
// INCLUDE the generic cohort — they overlap, they're not disjoint.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const DAYS = parseInt(process.env.DAYS || '0', 10); // 0 = lifetime
const lifetime = DAYS === 0;

// The 34 Winnr Generic root domains (mailboxes use them directly or via a
// mail./info. subdomain, e.g. s.wareing@mail.saleslytalents.org).
const GENERIC_ROOTS = [
  'azurianstudio.biz','consultantscenter.org','consultantssystems.com','consultantstech.org',
  'findsolarsupportdept.net','getmktresearch.com','getprovenreports.com','getsolarsupportdept.com',
  'getsumterreports.com','gohoponstage.biz','goprovenresearch.com','juriscales.com',
  'juriscales.net','juriscales.org','marketresearchtech.org','mktanalyze.com','mktstudy.com',
  'nelsonrecords.com','radcliffeinquiry.com','radclifferesearchcenter.com','radcliffestudy.com',
  'realsolarsupportdept.net','redwoodcomplianceadvisor.com','redwoodcomplianceadvisors.com',
  'redwoodcomplianceconsultant.com','redwoodcompliancegroup.com','redwoodcomplianceservices.com',
  'saleslytalents.biz','saleslytalents.org','sokinfinancial.org','springavenue.org',
  'springdrivepro.com','springdrives.net','thereportspro.com',
];

const HUMAN = ['interested','not_interested','question','unsubscribe'];
const AUTO  = ['ooo_auto_reply','auto_reply'];

// True when the mailbox's domain (or any sub.domain of it) is a generic root.
// $1 is the GENERIC_ROOTS array; $COL is the email column to test.
const genericDomainSQL = col => `EXISTS (
  SELECT 1 FROM unnest($1::text[]) r
  WHERE split_part(lower(${col}), '@', 2) = r
     OR split_part(lower(${col}), '@', 2) LIKE '%.' || r
)`;

(async () => {
  const repWin = lifetime ? '' : `AND received_at >= (CURRENT_DATE - ($2::int - 1))`;
  const repParams = lifetime ? [GENERIC_ROOTS] : [GENERIC_ROOTS, DAYS];

  // ── REPLIES (exact, per-mailbox) ───────────────────────────────────────────
  const genericReplies = (await pool.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(admin_label, category) = ANY('{${HUMAN.join(',')}}'))::int AS human,
           COUNT(*) FILTER (WHERE COALESCE(admin_label, category) = ANY('{${AUTO.join(',')}}'))::int  AS auto
    FROM unibox_replies
    WHERE ${genericDomainSQL('mailbox_email')} ${repWin}
  `, repParams)).rows[0];

  const smtpReplies = (await pool.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(r.admin_label, r.category) = ANY('{${HUMAN.join(',')}}'))::int AS human,
           COUNT(*) FILTER (WHERE COALESCE(r.admin_label, r.category) = ANY('{${AUTO.join(',')}}'))::int  AS auto
    FROM unibox_replies r
    JOIN mailbox_meta m ON lower(m.email) = lower(r.mailbox_email)
    WHERE lower(m.mailbox_type) = 'smtp'
      ${lifetime ? '' : 'AND r.received_at >= (CURRENT_DATE - ($1::int - 1))'}
  `, lifetime ? [] : [DAYS])).rows[0];

  // ── SENT ───────────────────────────────────────────────────────────────────
  const sentWin = lifetime ? '' : `AND date >= (CURRENT_DATE - ($1::int - 1))`;
  const sentParams = lifetime ? [] : [DAYS];

  // SMTP sent: exact — provider='smtp' is a native grain of mailbox_daily_stats.
  const smtpSent = (await pool.query(`
    SELECT COALESCE(SUM(sent),0)::int AS sent, COALESCE(SUM(bounced),0)::int AS bounced
    FROM mailbox_daily_stats WHERE provider = 'smtp' ${sentWin}
  `, sentParams)).rows[0];

  // Generic sent: from the endpoint that apportions per-workspace (optional).
  let genericSent = null, genericBounced = null;
  if (process.env.BASE) {
    try {
      const url = `${process.env.BASE}/api/mailboxes/winnr-generic-stats?days=${DAYS}`;
      const r = await fetch(url, { headers: process.env.COOKIE ? { Cookie: process.env.COOKIE } : {} });
      const j = await r.json();
      if (typeof j.sent === 'number') { genericSent = j.sent; genericBounced = j.bounced; }
    } catch (e) { /* leave null */ }
  }

  // ── Counts ─────────────────────────────────────────────────────────────────
  const genericCount = (await pool.query(
    `SELECT COUNT(*)::int n FROM mailbox_meta WHERE ${genericDomainSQL('email')}`, [GENERIC_ROOTS]
  )).rows[0].n;
  const smtpCount = (await pool.query(
    `SELECT COUNT(*)::int n FROM mailbox_meta WHERE lower(mailbox_type) = 'smtp'`
  )).rows[0].n;

  const rr = (n, d) => d > 0 ? (100 * n / d).toFixed(2) + '%' : '—';
  const block = (label, mbx, sent, bounced, rep) => {
    const sN = sent == null ? null : sent;
    console.log(`\n${label}  (${mbx} mailboxes)`);
    console.log(`  Sent:          ${sN == null ? 'n/a — read /api/mailboxes/winnr-generic-stats?days=' + DAYS + ' (set BASE/COOKIE to inline it)' : sN.toLocaleString()}`);
    if (bounced != null && sN) console.log(`  Bounced:       ${bounced.toLocaleString()}  (${rr(bounced, sN)})`);
    console.log(`  Replies total: ${rep.total}`);
    console.log(`    human:       ${rep.human}${sN ? '   RR ' + rr(rep.human, sN) : ''}`);
    console.log(`    auto/OOO:    ${rep.auto}${sN ? '   RR(incl) ' + rr(rep.human + rep.auto, sN) : ''}`);
  };

  console.log(`\n=== Cohort comparison — ${lifetime ? 'LIFETIME' : `last ${DAYS} days`} ===`);
  console.log(`(generic mailboxes are SMTP-type, so ALL SMTP figures INCLUDE the generic cohort)`);
  block('WINNR GENERIC', genericCount, genericSent, genericBounced, genericReplies);
  block('ALL SMTP',      smtpCount,    smtpSent.sent, smtpSent.bounced, smtpReplies);
  console.log('');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
