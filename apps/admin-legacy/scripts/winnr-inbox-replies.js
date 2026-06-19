#!/usr/bin/env node
// Pull replies for Winnr Generic mailboxes directly from the Winnr API.
// Pages through GET /v1/inbox?exclude_warmup=true, filters to the 34 generic
// root domains, prints a per-day breakdown + summary.
//
// Usage:
//   WINNR_TOKEN=wnr_... node scripts/winnr-inbox-replies.js
//   WINNR_TOKEN=wnr_... DAYS=7 node scripts/winnr-inbox-replies.js
//   WINNR_TOKEN=wnr_... DAYS=30 node scripts/winnr-inbox-replies.js

const TOKEN = process.env.WINNR_TOKEN;
if (!TOKEN) { console.error('Set WINNR_TOKEN=wnr_...'); process.exit(1); }

const DAYS = parseInt(process.env.DAYS || '0', 10); // 0 = lifetime
const BASE = 'https://api.winnr.app';

const GENERIC_ROOTS = new Set([
  'azurianstudio.biz','consultantscenter.org','consultantssystems.com','consultantstech.org',
  'findsolarsupportdept.net','getmktresearch.com','getprovenreports.com','getsolarsupportdept.com',
  'getsumterreports.com','gohoponstage.biz','goprovenresearch.com','juriscales.com',
  'juriscales.net','juriscales.org','marketresearchtech.org','mktanalyze.com','mktstudy.com',
  'nelsonrecords.com','radcliffeinquiry.com','radclifferesearchcenter.com','radcliffestudy.com',
  'realsolarsupportdept.net','redwoodcomplianceadvisor.com','redwoodcomplianceadvisors.com',
  'redwoodcomplianceconsultant.com','redwoodcompliancegroup.com','redwoodcomplianceservices.com',
  'saleslytalents.biz','saleslytalents.org','sokinfinancial.org','springavenue.org',
  'springdrivepro.com','springdrives.net','thereportspro.com',
]);

function isGeneric(mailbox) {
  const domain = (mailbox || '').toLowerCase().split('@')[1] || '';
  if (GENERIC_ROOTS.has(domain)) return true;
  // match subdomains like mail.saleslytalents.org
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (GENERIC_ROOTS.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

async function apiFetch(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return res.json();
}

// Warmup detection: body contains warmup noise patterns
function isWarmup(msg) {
  const body = (msg.body || '').toLowerCase();
  const subj = (msg.subject || '').toLowerCase();
  // Winnr warmup subjects are random words; check body for known warmup markers
  if (/\b(re:\s*)?(ice breaker|festival support|project update|quick question|following up)\b/.test(subj)) {
    // Could be real — don't auto-exclude by subject alone
  }
  // Classic warmup noise: random word pairs in body
  if (/[a-z]{6,}\s[a-z]{6,}\s*\n/.test(body) && msg.is_warmup) return true;
  return false;
}

(async () => {
  const dateFrom = DAYS > 0
    ? new Date(Date.now() - DAYS * 86400000).toISOString().split('T')[0]
    : null;

  console.log(`Fetching Winnr inbox${dateFrom ? ` from ${dateFrom}` : ' (lifetime)'}…`);

  const all = [];
  let cursor = null;
  let page = 0;

  do {
    page++;
    let url = `/v1/inbox?limit=100&exclude_warmup=true`;
    if (dateFrom) url += `&date_from=${dateFrom}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    const res = await apiFetch(url);
    const batch = res.data || [];
    all.push(...batch);
    cursor = res.pagination?.has_more ? res.pagination?.cursor : null;

    if (page % 5 === 0) process.stderr.write(`  … ${all.length} messages fetched (page ${page})\n`);
  } while (cursor);

  console.log(`Total inbox messages fetched: ${all.length.toLocaleString()}`);

  const generic = all.filter(m => isGeneric(m.mailbox));
  console.log(`Generic domain messages: ${generic.length.toLocaleString()}`);

  // Group by date
  const byDate = new Map();
  const mailboxSet = new Set();
  for (const m of generic) {
    const date = (m.received_at || '').split('T')[0];
    if (!date) continue;
    mailboxSet.add(m.mailbox);
    if (!byDate.has(date)) byDate.set(date, { total: 0, unique_mailboxes: new Set(), subjects: [] });
    const d = byDate.get(date);
    d.total++;
    d.unique_mailboxes.add(m.mailbox);
    d.subjects.push(m.subject || '(no subject)');
  }

  const dates = [...byDate.keys()].sort();
  if (!dates.length) {
    console.log('\nNo generic domain messages found in this period.');
  } else {
    console.log(`\n${'─'.repeat(64)}`);
    console.log(`WINNR GENERIC — inbox messages by day`);
    console.log(`${'─'.repeat(64)}`);
    console.log(`  date           msgs   unique_mailboxes`);
    for (const d of dates) {
      const x = byDate.get(d);
      console.log(`  ${d}   ${String(x.total).padStart(4)}   ${String(x.unique_mailboxes.size).padStart(4)}`);
    }
    console.log(`${'─'.repeat(64)}`);
    console.log(`  TOTAL          ${String(generic.length).padStart(4)}   ${String(mailboxSet.size).padStart(4)} unique mailboxes`);
  }

  // Sample the subjects for quality check
  if (generic.length) {
    console.log(`\nSample subjects (first 20):`);
    generic.slice(0, 20).forEach(m =>
      console.log(`  [${(m.received_at || '').split('T')[0]}] ${m.mailbox}  ← ${m.from_email || '?'}\n    "${m.subject}"`)
    );
  }
})().catch(e => { console.error(e); process.exit(1); });
