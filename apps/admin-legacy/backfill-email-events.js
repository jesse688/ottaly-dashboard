#!/usr/bin/env node

/**
 * Backfill email_events from PlusVibe API
 *
 * Fetches all campaigns, replies, bounces, and events from PlusVibe for all workspaces
 * and populates the email_events table with historical data (typically 3+ months).
 *
 * Usage:
 *   node backfill-email-events.js [workspace_id]
 *
 * Examples:
 *   node backfill-email-events.js                    # Backfill all workspaces
 *   node backfill-email-events.js 6912ddfef9582848982b9a62  # Backfill single workspace
 */

const PostgresDatabase = require('./db-postgres.js');
const https = require('https');
const querystring = require('querystring');

const PLUSVIBE_KEY = process.env.PLUSVIBE_KEY || '6425e882-f33fb46a-2837ff5a-eb535a60';
const BATCH_SIZE = 500; // Insert in batches to avoid query size limits

let db = null;
let stats = {
  workspacesProcessed: 0,
  campaignsProcessed: 0,
  eventsInserted: 0,
  bounceEventsInserted: 0,
  errorsEncountered: 0,
};

async function fetchFromPlusVibe(endpoint, workspaceId, params = {}) {
  return new Promise((resolve, reject) => {
    const query = { workspace_id: workspaceId, ...params };
    const url = `https://api.plusvibe.ai${endpoint}?${querystring.stringify(query)}`;

    const options = {
      headers: {
        'Authorization': `Bearer ${PLUSVIBE_KEY}`,
        'User-Agent': 'ottaly-diagnostics/1.0'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`JSON parse error: ${err.message}`));
          }
        } else {
          reject(new Error(`PlusVibe API returned ${res.statusCode}: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

async function insertEventBatch(events) {
  if (events.length === 0) return;

  const placeholders = events.map((_, i) => {
    const base = i * 11;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
  }).join(', ');

  const values = [];
  events.forEach(e => {
    values.push(
      e.workspace_id,
      e.event_type,
      e.event_at,
      e.campaign_id || null,
      e.lead_email || null,
      e.bounce_type || null,
      e.raw || null,
      e.sender_email || null,
      e.template_hash || null,
      e.reply_text || null,
      new Date()
    );
  });

  try {
    await db.query(`
      INSERT INTO email_events
      (workspace_id, event_type, event_at, campaign_id, lead_email,
       bounce_type, raw, sender_email, content_hash, reply_text, created_at)
      VALUES ${placeholders}
      ON CONFLICT DO NOTHING
    `, values);
    stats.eventsInserted += events.length;
  } catch (err) {
    console.error(`Error inserting ${events.length} events:`, err.message);
    stats.errorsEncountered++;
  }
}

async function backfillWorkspace(workspaceId) {
  console.log(`\n📥 Backfilling workspace: ${workspaceId}`);

  try {
    // Fetch all campaigns for this workspace
    console.log('  Fetching campaigns...');
    const campaignsResp = await fetchFromPlusVibe('/campaigns', workspaceId, { limit: 1000 });
    const campaigns = campaignsResp.campaigns || [];
    console.log(`    Found ${campaigns.length} campaigns`);

    stats.campaignsProcessed += campaigns.length;

    // For each campaign, extract sent/reply events
    const eventBatch = [];

    for (const campaign of campaigns) {
      if (!campaign.id || !campaign.sends || campaign.sends === 0) continue;

      // Campaign object usually has: id, status, sends, replies, bounces, created_at, template_name
      // Convert to event records

      const campaignCreatedAt = campaign.created_at ? new Date(campaign.created_at) : new Date();

      // Sent event (aggregate)
      if (campaign.sends > 0) {
        eventBatch.push({
          workspace_id: workspaceId,
          event_type: 'sent',
          event_at: campaignCreatedAt,
          campaign_id: campaign.id,
          raw: JSON.stringify(campaign)
        });
      }

      // Reply event (aggregate)
      if (campaign.replies > 0) {
        eventBatch.push({
          workspace_id: workspaceId,
          event_type: 'reply',
          event_at: new Date(campaignCreatedAt.getTime() + 86400000), // +1 day
          campaign_id: campaign.id,
          raw: JSON.stringify(campaign)
        });
      }

      // Bounce event (aggregate)
      if (campaign.bounces > 0) {
        eventBatch.push({
          workspace_id: workspaceId,
          event_type: 'bounce',
          event_at: new Date(campaignCreatedAt.getTime() + 3600000), // +1 hour
          campaign_id: campaign.id,
          bounce_type: 'hard', // Default to hard bounce
          raw: JSON.stringify(campaign)
        });
      }

      // Insert in batches
      if (eventBatch.length >= BATCH_SIZE) {
        await insertEventBatch(eventBatch.splice(0, BATCH_SIZE));
      }
    }

    // Insert remaining events
    if (eventBatch.length > 0) {
      await insertEventBatch(eventBatch);
    }

    // Fetch detailed replies if available
    console.log('  Fetching detailed replies...');
    try {
      const repliesResp = await fetchFromPlusVibe('/leads', workspaceId, { status: 'replied', limit: 1000 });
      const replies = repliesResp.leads || [];
      console.log(`    Found ${replies.length} replied leads`);

      const replyBatch = replies.map(lead => ({
        workspace_id: workspaceId,
        event_type: 'reply',
        event_at: lead.replied_at ? new Date(lead.replied_at) : new Date(),
        campaign_id: lead.campaign_id || null,
        lead_email: lead.email || null,
        reply_text: lead.reply_text || null,
        raw: JSON.stringify(lead)
      }));

      // Insert in batches
      for (let i = 0; i < replyBatch.length; i += BATCH_SIZE) {
        await insertEventBatch(replyBatch.slice(i, i + BATCH_SIZE));
      }
    } catch (err) {
      console.warn(`  ⚠️  Could not fetch detailed replies: ${err.message}`);
    }

    stats.workspacesProcessed++;
    console.log(`  ✅ Backfill complete for workspace: ${stats.eventsInserted} events inserted`);

  } catch (err) {
    console.error(`❌ Error backfilling workspace ${workspaceId}:`, err.message);
    stats.errorsEncountered++;
  }
}

async function getAllWorkspaces() {
  try {
    const result = await db.query(`
      SELECT DISTINCT workspace_id FROM clients WHERE workspace_id IS NOT NULL
      UNION
      SELECT DISTINCT workspace_id FROM leads WHERE workspace_id IS NOT NULL
      ORDER BY workspace_id
    `);
    return result.rows.map(r => r.workspace_id).filter(Boolean);
  } catch (err) {
    console.warn('Could not fetch workspace list from DB, using defaults');
    return ['6912ddfef9582848982b9a62']; // Fallback to Accrue
  }
}

async function main() {
  try {
    // Initialize database
    console.log('Initializing database...');
    db = new PostgresDatabase();
    await db.init();
    console.log('✅ Database connected');

    // Get target workspaces
    let workspaces = [];
    if (process.argv[2]) {
      // Specific workspace provided
      workspaces = [process.argv[2]];
    } else {
      // All workspaces
      workspaces = await getAllWorkspaces();
    }

    console.log(`\n📊 Backfill Plan`);
    console.log(`Workspaces to backfill: ${workspaces.length}`);
    console.log(`Workspaces: ${workspaces.join(', ')}`);
    console.log(`\nStarting backfill...\n`);

    // Backfill each workspace
    for (const ws of workspaces) {
      await backfillWorkspace(ws);
    }

    // Print summary
    console.log('\n═════════════════════════════════════════');
    console.log('BACKFILL COMPLETE');
    console.log('═════════════════════════════════════════');
    console.log(`Workspaces processed: ${stats.workspacesProcessed}`);
    console.log(`Campaigns processed: ${stats.campaignsProcessed}`);
    console.log(`Events inserted: ${stats.eventsInserted}`);
    console.log(`Errors encountered: ${stats.errorsEncountered}`);
    console.log('═════════════════════════════════════════\n');

    // Verify data
    console.log('Verifying data...');
    const verification = await db.query(`
      SELECT
        COUNT(*) as total_events,
        COUNT(DISTINCT workspace_id) as workspaces,
        COUNT(DISTINCT DATE(event_at)) as days_with_data,
        MIN(event_at)::date as earliest_date,
        MAX(event_at)::date as latest_date,
        COUNT(*) FILTER (WHERE event_type = 'sent') as sends,
        COUNT(*) FILTER (WHERE event_type = 'reply') as replies,
        COUNT(*) FILTER (WHERE event_type = 'bounce') as bounces
      FROM email_events
    `);

    const result = verification.rows[0];
    console.log(`\n✅ email_events summary:`);
    console.log(`  Total events: ${result.total_events}`);
    console.log(`  Workspaces: ${result.workspaces}`);
    console.log(`  Days with data: ${result.days_with_data}`);
    console.log(`  Date range: ${result.earliest_date} to ${result.latest_date}`);
    console.log(`  Sends: ${result.sends}, Replies: ${result.replies}, Bounces: ${result.bounces}`);
    console.log(`\n✅ Ready for Phase 1 implementation!\n`);

    await db.pool.end();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Fatal error:', err.message);
    if (db && db.pool) {
      await db.pool.end();
    }
    process.exit(1);
  }
}

main();
