#!/usr/bin/env node
// Reconciler: pull replies from Bison /api/replies per workspace, compare against
// unibox_replies, and INSERT any missing rows. Run manually or as a cron.
//
// Usage:
//   DATABASE_URL=... BISON_API_KEY=... node scripts/reconcile-bison-replies.js
//   DATABASE_URL=... BISON_API_KEY=... DAYS=2 node scripts/reconcile-bison-replies.js
//   DATABASE_URL=... BISON_API_KEY=... DRY_RUN=1 node scripts/reconcile-bison-replies.js

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BISON_BASE = process.env.BISON_API_URL || 'https://send.ottaly.co.uk';
const BISON_KEY  = process.env.BISON_API_KEY;
const DAYS       = parseInt(process.env.DAYS || '2', 10);
const DRY_RUN    = !!process.env.DRY_RUN;

if (!BISON_KEY) { console.error('Set BISON_API_KEY'); process.exit(1); }

// Bison category → unibox category mapping
const CAT_MAP = {
  interested:          'interested',
  automated_reply:     'auto_reply',
  not_automated_reply: 'not_interested',
};

let _bisonGate = Promise.resolve();
async function bisonReq(path, wsId, params = {}) {
  _bisonGate = _bisonGate.then(async () => {
    await fetch(`${BISON_BASE}/api/workspaces/v1.1/switch-workspace`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${BISON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: wsId }),
    });
  });
  await _bisonGate;
  const url = new URL(`${BISON_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { headers: { Authorization: `Bearer ${BISON_KEY}` } });
  return r.json();
}

async function getAllReplies(wsId, since, folder = 'all') {
  const all = [];
  let prevSig = '';
  for (let page = 1; page <= 200; page++) {
    const d = await bisonReq('/api/replies', wsId, { folder, page, per_page: 100 });
    const batch = d.data ?? [];
    if (!batch.length) break;
    const sig = batch.map(r => r.id).join(',');
    if (sig === prevSig) break;
    prevSig = sig;
    // Bison returns replies newest-first — stop as soon as we hit older than our window
    const inWindow = batch.filter(r => (r.created_at || '') >= since);
    all.push(...inWindow);
    if (inWindow.length < batch.length) break; // hit the cutoff
    if (batch.length < 10) break;
  }
  return all;
}

(async () => {
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  console.log(`Reconciling Bison replies since ${since.split('T')[0]} (last ${DAYS} days)${DRY_RUN ? ' [DRY RUN]' : ''}`);

  // Get all workspaces
  const wsResp = await fetch(`${BISON_BASE}/api/workspaces/v1.1`, {
    headers: { Authorization: `Bearer ${BISON_KEY}` },
  });
  const workspaces = (await wsResp.json()).data ?? [];
  console.log(`Workspaces: ${workspaces.length}`);

  // Known PV workspace_id by Bison team_id (from memory)
  const BISON_TEAMS = {
    '4':  '6912ddfef9582848982b9a62', // AccrueAccounting
    '5':  '69a9db307af7ef2854f57637', // ButterflyEco
    '6':  null,                        // ByboDigital
    '7':  '695259b0d1677bc04d5a3aa8', // Shire→Stribe
    '8':  null,                        // MDH
    '9':  null,                        // Meades
    '10': '6964c76a36e2bd2af31c7adf', // Lending Team
    '11': null,                        // Bubble
    '12': null,                        // MagnaMoney
    '13': null,                        // Bruud
    '14': '69c43d1e07bf312ff0026643', // GXI Furniture
    '15': '69c43d1407bf312ff0026642', // GXI
    '16': null,                        // LVM
    '17': '695259c3d6154e27d164bcf7', // Indigo
    '18': '699714b02f0830a7148fcf3e', // Enviro
    '19': '695259dc8de377db7577dc45', // PPC
    '20': '697e20f02db8460f8ba68792', // Jumping Spider
    '21': '69525a0eceae00718efdaeaa', // Hydration
    '22': '69a686632f5aaca7d9602c1f', // Animo
    '23': null,                        // butterflySOP
    '24': '6989ac90bb085fcd05167fc9', // Josh Flooring
    '25': null,                        // BlueHawk
    '26': null,                        // Hayes&Co
  };

  // Bulk-fetch all existing unibox_replies in the window — dedup in memory, no per-row queries
  const existing = await pool.query(`
    SELECT lower(sender_email) AS sender_email,
           round(extract(epoch FROM received_at))::bigint AS ts
    FROM unibox_replies
    WHERE received_at >= $1
  `, [since]);
  // Key: "email|ts_rounded_to_5min"
  const existingKeys = new Set(
    existing.rows.map(r => `${r.sender_email}|${Math.round(Number(r.ts) / 300)}`)
  );
  console.log(`Existing unibox_replies in window: ${existingKeys.size}`);

  let totalInserted = 0, totalSkipped = 0, totalErrors = 0;

  for (const ws of workspaces) {
    const wsId = String(ws.id);
    const workspaceId = BISON_TEAMS[wsId] || wsId;

    process.stderr.write(`  ${ws.name} (team ${wsId})… `);

    try {
      const replies = await getAllReplies(wsId, since);
      const recent = replies;
      process.stderr.write(`${replies.length} total, ${recent.length} in window\n`);

      for (const reply of recent) {
        const senderEmail = (reply.from_email || reply.reply_email || '').toLowerCase().trim();
        const mailboxEmail = (reply.to_email || reply.sender_email_address || '').toLowerCase().trim();
        const subject = reply.subject || '';
        const receivedAt = reply.created_at || reply.updated_at;
        const category = CAT_MAP[reply.status || ''] || 'other';
        const folder = reply.folder || 'inbox';

        if (!senderEmail || !receivedAt) continue;

        const ts5 = Math.round(new Date(receivedAt).getTime() / 1000 / 300);
        const key = `${senderEmail}|${ts5}`;
        if (existingKeys.has(key)) { totalSkipped++; continue; }

        if (DRY_RUN) {
          console.log(`  [DRY] ${receivedAt?.slice(0,16)} ${senderEmail} → ${mailboxEmail} [${category}] "${subject}"`);
          existingKeys.add(key);
          totalInserted++;
          continue;
        }

        await pool.query(`
          INSERT INTO unibox_replies
            (workspace_id, sender_email, mailbox_email, subject, category, folder, received_at, raw)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT DO NOTHING
        `, [workspaceId, senderEmail, mailboxEmail, subject, category, folder, receivedAt, JSON.stringify(reply)]);

        existingKeys.add(key);
        totalInserted++;
        console.log(`  [INSERT] ${receivedAt?.slice(0,16)} ${senderEmail} → ${mailboxEmail} [${category}] "${subject}"`);
      }
    } catch (err) {
      process.stderr.write(`  ERROR: ${err.message}\n`);
      totalErrors++;
    }
  }

  console.log(`\nDone. Inserted: ${totalInserted}  Skipped (already present): ${totalSkipped}  Errors: ${totalErrors}`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
