#!/usr/bin/env node
/**
 * Backfill reply timestamps using get_emails API with source_modified_at
 *
 * source_modified_at = actual email timestamp from headers (when prospect hit send)
 * This is the accurate reply time, unlike modified_at on the lead record which
 * updates every time anyone touches the lead.
 *
 * Usage:
 *   node scripts/backfill-reply-times.js
 *   node scripts/backfill-reply-times.js <workspace_id>
 */

const { Pool } = require('pg');
const https = require('https');

const PLUSVIBE_KEY = process.env.PLUSVIBE_KEY || '6425e882-f33fb46a-2837ff5a-eb535a60';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let lastReq = 0;
async function pvPost(path, body) {
  const gap = lastReq + 700 - Date.now();
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  lastReq = Date.now();

  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const url = new URL(`https://api.plusvibe.ai${path}`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'x-api-key': PLUSVIBE_KEY,
        'Content-Type': 'application/json',
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function pvGet(path) {
  const gap = lastReq + 700 - Date.now();
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  lastReq = Date.now();

  return new Promise((resolve, reject) => {
    https.get(`https://api.plusvibe.ai${path}`, {
      headers: { 'x-api-key': PLUSVIBE_KEY },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const LEAD_LABELS    = new Set(['INTERESTED','MEETING_BOOKED','LEAD','ADDED_TO_ZOHO','INTERESTED_NONLEAD','FOLLOW_UP','CALL_BOOKED','POSITIVE_REPLY']);
const NONLEAD_LABELS = new Set(['NOT_INTERESTED','WRONG_PERSON','NOT_GOOD_LEAD','NON_LEAD','UNSUBSCRIBE','UNSUBSCIBE']);
const SKIP_LABELS    = new Set(['OUT_OF_OFFICE','AUTOMATIC_REPLY']);

function labelToEventType(label) {
  const l = (label || '').toUpperCase();
  if (SKIP_LABELS.has(l))    return null;           // exclude auto-replies entirely
  if (LEAD_LABELS.has(l))    return 'lead';
  if (NONLEAD_LABELS.has(l)) return 'not_interested';
  return 'reply';
}

async function fetchAllEmails(workspaceId, cutoff) {
  const emails = [];
  let pageTrail = null;
  let page = 0;

  while (true) {
    const qs = new URLSearchParams({
      workspace_id: workspaceId,
      email_type: 'received',
      preview_only: 'true',
      ...(pageTrail ? { page_trail: pageTrail } : {}),
    }).toString();

    let result;
    try {
      result = await pvGet(`/api/v1/unibox/emails?${qs}`);
    } catch (err) {
      console.warn(`  [warn] page ${page + 1} failed: ${err.message}`);
      break;
    }

    const batch = result?.data || [];
    if (!batch.length) break;

    // Filter to cutoff and only inbound (direction=IN)
    let added = 0;
    for (const email of batch) {
      if (email.direction !== 'IN') continue;
      const ts = email.source_modified_at || email.timestamp_created;
      if (!ts) continue;
      const date = new Date(ts);
      if (date < cutoff) continue;
      emails.push(email);
      added++;
    }

    page++;
    process.stdout.write(`\r  page ${page}: ${emails.length} emails in window...`);

    // Stop if we've gone past the cutoff (emails come newest-first)
    const oldest = batch[batch.length - 1];
    const oldestTs = oldest?.source_modified_at || oldest?.timestamp_created;
    if (oldestTs && new Date(oldestTs) < cutoff) break;

    pageTrail = result?.page_trail;
    if (!pageTrail) break;
  }

  console.log('');
  return emails;
}

async function getWorkspaces(targetWs) {
  if (targetWs) return [targetWs];
  const r = await pool.query(`
    SELECT DISTINCT workspace_id FROM campaign_templates
    WHERE workspace_id IS NOT NULL ORDER BY workspace_id
  `);
  return r.rows.map(r => r.workspace_id).filter(Boolean);
}

async function backfillWorkspace(workspaceId, client, cutoff) {
  console.log(`\n📥 Workspace ${workspaceId}`);
  const emails = await fetchAllEmails(workspaceId, cutoff);

  if (!emails.length) {
    console.log('  no emails in window');
    return 0;
  }

  // Clear previous backfill attempts for this workspace (both bad June 4-5 data and v1 backfill)
  await client.query(`
    DELETE FROM email_events
    WHERE workspace_id = $1
      AND event_type IN ('reply', 'lead', 'not_interested')
      AND raw::text LIKE '%backfill%'
  `, [workspaceId]);

  const events = [];
  for (const email of emails) {
    const leadEmail = (email.lead || email.from_address_email || '').toLowerCase();
    if (!leadEmail) continue;

    const ts = email.source_modified_at || email.timestamp_created;
    if (!ts) continue;

    const evType = labelToEventType(email.label);
    if (!evType) continue; // skip OOO / auto-replies

    events.push({
      workspace_id: workspaceId,
      campaign_id:  email.campaign_id || null,
      event_type:   evType,
      event_at:     new Date(ts),
      lead_email:   leadEmail,
      raw: JSON.stringify({
        source: 'backfill-reply-times-v2',
        email_id: email.id,
        label: email.label,
        source_modified_at: email.source_modified_at,
        timestamp_created: email.timestamp_created,
      }),
    });
  }

  if (!events.length) { console.log('  no valid events'); return 0; }

  const BATCH = 100;
  let inserted = 0;
  for (let i = 0; i < events.length; i += BATCH) {
    const chunk = events.slice(i, i + BATCH);
    const vals = [];
    const params = chunk.map((e, j) => {
      const b = j * 6;
      vals.push(e.workspace_id, e.campaign_id, e.event_type, e.event_at, e.lead_email, e.raw);
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`;
    });
    await client.query(`
      INSERT INTO email_events (workspace_id, campaign_id, event_type, event_at, lead_email, raw)
      VALUES ${params.join(',')}
    `, vals);
    inserted += chunk.length;
  }

  console.log(`  ✅ ${emails.length} emails → ${inserted} events`);
  return inserted;
}

async function main() {
  const targetWs = process.argv[2];
  const workspaces = await getWorkspaces(targetWs);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 3);
  console.log(`Workspaces: ${workspaces.length}`);
  console.log(`Cutoff: ${cutoff.toISOString().slice(0,10)} (3 months)`);

  const client = await pool.connect();
  let total = 0;
  try {
    for (const ws of workspaces) {
      total += await backfillWorkspace(ws, client, cutoff);
    }
  } finally {
    client.release();
  }

  console.log(`\n✅ Done — ${total} total events`);

  // Results
  const cov = await pool.query(`
    SELECT event_type, COUNT(*)::int AS total,
      MIN(event_at)::date AS earliest, MAX(event_at)::date AS latest
    FROM email_events
    WHERE event_type IN ('reply','lead','not_interested')
    GROUP BY event_type ORDER BY event_type
  `);
  console.log('\nCoverage:');
  console.table(cov.rows);

  console.log('\nReply rate by hour UK time (Mon-Fri, last 90 days):');
  const h = await pool.query(`
    SELECT
      EXTRACT(HOUR FROM event_at AT TIME ZONE 'Europe/London')::int AS hr,
      COUNT(*) FILTER (WHERE event_type IN ('reply','lead','not_interested'))::int AS replies,
      COUNT(*) FILTER (WHERE event_type = 'lead')::int AS leads,
      COUNT(*) FILTER (WHERE event_type = 'not_interested')::int AS not_interested
    FROM email_events
    WHERE event_at > NOW() - INTERVAL '90 days'
      AND event_type IN ('reply','lead','not_interested')
      AND EXTRACT(DOW FROM event_at AT TIME ZONE 'Europe/London') BETWEEN 1 AND 5
    GROUP BY 1 ORDER BY 1
  `);
  console.table(h.rows);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
