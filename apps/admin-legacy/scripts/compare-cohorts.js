#!/usr/bin/env node
// Compare two mailbox cohorts — Winnr Generic vs all SMTP — by SENT + REPLIES,
// with a per-day date breakdown.
//
// REPLIES are EXACT (per-mailbox, straight from unibox_replies) for both cohorts.
// SMTP SENT is EXACT (mailbox_daily_stats, the "SMTP / Other" bucket = any
// provider that isn't Google/Microsoft — matches the dashboard).
// GENERIC SENT has no per-mailbox source in Bison, so it's pulled from the
// winnr-generic-stats endpoint when BASE/COOKIE are set (it also returns a
// per-day series); otherwise it's left n/a.
//
//   DATABASE_URL=... node scripts/compare-cohorts.js              # lifetime
//   DATABASE_URL=... DAYS=7 node scripts/compare-cohorts.js       # last 7 days
//   DATABASE_URL=... BASE=http://localhost:3000 COOKIE='session=…' node scripts/compare-cohorts.js
//
// NOTE: generic mailboxes are SMTP-type, so "ALL SMTP" INCLUDES the generic
// cohort — the two sets overlap, they are not disjoint.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const DAYS = parseInt(process.env.DAYS || '0', 10); // 0 = lifetime
const lifetime = DAYS === 0;

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

// Mailbox domain (or any sub.domain) belongs to a generic root. $1 = roots array.
const genericDomainSQL = col => `EXISTS (
  SELECT 1 FROM unnest($1::text[]) r
  WHERE split_part(lower(${col}), '@', 2) = r
     OR split_part(lower(${col}), '@', 2) LIKE '%.' || r
)`;
// The dashboard "SMTP / Other" bucket: anything that isn't Google/Microsoft.
const isSmtp = `lower(coalesce(mailbox_type,'')) NOT IN ('google','microsoft')`;

(async () => {
  // ── REPLIES per day (exact, per-mailbox) ───────────────────────────────────
  const repWin = lifetime ? '' : `AND received_at >= (CURRENT_DATE - ($2::int - 1))`;
  const genericRepDaily = (await pool.query(`
    SELECT (received_at AT TIME ZONE 'UTC')::date::text AS date,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(admin_label, category) = ANY('{${HUMAN.join(',')}}'))::int AS human,
           COUNT(*) FILTER (WHERE COALESCE(admin_label, category) = ANY('{${AUTO.join(',')}}'))::int  AS auto
    FROM unibox_replies
    WHERE ${genericDomainSQL('mailbox_email')} ${repWin}
    GROUP BY 1 ORDER BY 1
  `, lifetime ? [GENERIC_ROOTS] : [GENERIC_ROOTS, DAYS])).rows;

  const smtpRepDaily = (await pool.query(`
    SELECT (r.received_at AT TIME ZONE 'UTC')::date::text AS date,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(r.admin_label, r.category) = ANY('{${HUMAN.join(',')}}'))::int AS human,
           COUNT(*) FILTER (WHERE COALESCE(r.admin_label, r.category) = ANY('{${AUTO.join(',')}}'))::int  AS auto
    FROM unibox_replies r
    JOIN mailbox_meta m ON lower(m.email) = lower(r.mailbox_email)
    WHERE ${isSmtp} ${lifetime ? '' : 'AND r.received_at >= (CURRENT_DATE - ($1::int - 1))'}
    GROUP BY 1 ORDER BY 1
  `, lifetime ? [] : [DAYS])).rows;

  // ── SMTP SENT per day (exact) ──────────────────────────────────────────────
  const sentWin = lifetime ? '' : `AND date >= (CURRENT_DATE - ($1::int - 1))`;
  const smtpSentDaily = (await pool.query(`
    SELECT date::text AS date, SUM(sent)::int AS sent, SUM(bounced)::int AS bounced
    FROM mailbox_daily_stats
    WHERE lower(coalesce(provider,'')) NOT IN ('google','microsoft') ${sentWin}
    GROUP BY 1 ORDER BY 1
  `, lifetime ? [] : [DAYS])).rows;

  // ── GENERIC SENT per day (from endpoint, optional) ─────────────────────────
  let genericSentDaily = null; // [{date,sent}]
  let genericSentTotal = null, genericBounceTotal = null;
  if (process.env.BASE) {
    try {
      const url = `${process.env.BASE}/api/mailboxes/winnr-generic-stats?days=${DAYS}`;
      const j = await (await fetch(url, { headers: process.env.COOKIE ? { Cookie: process.env.COOKIE } : {} })).json();
      if (typeof j.sent === 'number') { genericSentTotal = j.sent; genericBounceTotal = j.bounced; }
      if (Array.isArray(j.series) && Array.isArray(j.dates))
        genericSentDaily = j.dates.map((d, i) => ({ date: d, sent: j.series[i]?.sent ?? 0 }));
    } catch (e) { /* leave null */ }
  }

  // ── Counts ─────────────────────────────────────────────────────────────────
  const genericCount = (await pool.query(
    `SELECT COUNT(*)::int n FROM mailbox_meta WHERE ${genericDomainSQL('email')}`, [GENERIC_ROOTS]
  )).rows[0].n;
  const smtpCount = (await pool.query(`SELECT COUNT(*)::int n FROM mailbox_meta WHERE ${isSmtp}`)).rows[0].n;

  // ── Render ─────────────────────────────────────────────────────────────────
  const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const rr = (n, d) => d > 0 ? (100 * n / d).toFixed(2) + '%' : '—';

  function cohort(label, mbx, sentDaily, repDaily) {
    const sentTotal = sentDaily ? sum(sentDaily, 'sent') : null;
    const bounceTotal = sentDaily ? sum(sentDaily, 'bounced') : null;
    const repTotal = sum(repDaily, 'total'), human = sum(repDaily, 'human'), auto = sum(repDaily, 'auto');

    console.log(`\n${'─'.repeat(64)}\n${label}  (${mbx} mailboxes)`);
    console.log(`  Sent:    ${sentTotal == null ? 'n/a (set BASE/COOKIE to inline from endpoint)' : sentTotal.toLocaleString()}`);
    if (bounceTotal != null) console.log(`  Bounced: ${bounceTotal.toLocaleString()}  (${rr(bounceTotal, sentTotal)})`);
    console.log(`  Replies: ${repTotal} total  ·  human ${human} (${rr(human, sentTotal)})  ·  auto/OOO ${auto}`);

    // Per-day table, merging sent + replies on date.
    const byDate = new Map();
    for (const r of (sentDaily || [])) byDate.set(r.date, { ...byDate.get(r.date), sent: r.sent });
    for (const r of repDaily) byDate.set(r.date, { ...byDate.get(r.date), total: r.total, human: r.human, auto: r.auto });
    const dates = [...byDate.keys()].sort();
    if (dates.length) {
      console.log(`  ── by date ──`);
      console.log(`    date         sent   replies  human  auto`);
      for (const d of dates) {
        const x = byDate.get(d);
        const c = (v, w) => String(v ?? 0).padStart(w);
        console.log(`    ${d}  ${c(x.sent, 6)}   ${c(x.total, 6)}  ${c(x.human, 5)}  ${c(x.auto, 4)}`);
      }
    }
  }

  console.log(`\n=== Cohort comparison — ${lifetime ? 'LIFETIME' : `last ${DAYS} days`} (generated ${new Date().toISOString()}) ===`);
  console.log(`(generic mailboxes are SMTP-type → ALL SMTP figures INCLUDE the generic cohort)`);
  cohort('WINNR GENERIC', genericCount, genericSentDaily, genericRepDaily);
  cohort('ALL SMTP',      smtpCount,    smtpSentDaily,    smtpRepDaily);
  console.log('');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
