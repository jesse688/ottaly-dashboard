#!/usr/bin/env node

/**
 * Backfill email_events from PlusVibe API (v2)
 *
 * Fetches leads with status (REPLIED, INTERESTED, MEETING_BOOKED, etc.)
 * and creates event records in email_events table.
 *
 * Usage:
 *   node backfill-email-events-v2.js [workspace_id]
 *
 * Examples:
 *   node backfill-email-events-v2.js                    # Backfill all workspaces
 *   node backfill-email-events-v2.js 6912ddfef9582848982b9a62  # Backfill single workspace
 */

const PostgresDatabase = require('./db-postgres.js');
const https = require('https');
const querystring = require('querystring');

const PLUSVIBE_KEY = process.env.PLUSVIBE_KEY || '6425e882-f33fb46a-2837ff5a-eb535a60';
const BATCH_SIZE = 100; // Insert in batches

let db = null;
let stats = {
  workspacesProcessed: 0,
  leadsProcessed: 0,
  eventsInserted: 0,
  errorsEncountered: 0,
};

// Throttle to respect PlusVibe 100 req/min limit
let lastRequestTime = 0;
const MIN_REQUEST_GAP_MS = 700; // 600ms + buffer

async function throttledFetch(url, options) {
  const now = Date.now();
  const gap = lastRequestTime + MIN_REQUEST_GAP_MS - now;
  if (gap > 0) {
    await new Promise(r => setTimeout(r, gap));
  }
  lastRequestTime = Date.now();

  return new Promise((resolve, reject) => {
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
          reject(new Error(`PlusVibe API returned ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

async function fetchLeadsPage(workspaceId, label, page) {
  const query = {
    workspace_id: workspaceId,
    label: label,
    page: page,
    limit: 100
  };

  const url = `https://api.plusvibe.ai/api/v1/lead/workspace-leads?${querystring.stringify(query)}`;
  const options = {
    headers: {
      'x-api-key': PLUSVIBE_KEY,
      'User-Agent': 'ottaly-diagnostics/2.0'
    }
  };

  const result = await throttledFetch(url, options);
  return Array.isArray(result) ? result : (result?.leads || result?.data || []);
}

async function insertEventBatch(events) {
  if (events.length === 0) return;

  const placeholders = events.map((_, i) => {
    const base = i * 6;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  }).join(', ');

  const values = [];
  events.forEach(e => {
    values.push(
      e.workspace_id,
      e.event_type,
      e.event_at,
      e.campaign_id || null,
      e.lead_email || null,
      e.raw || null
    );
  });

  try {
    await db.query(`
      INSERT INTO email_events
      (workspace_id, event_type, event_at, campaign_id, lead_email, raw)
      VALUES ${placeholders}
      ON CONFLICT DO NOTHING
    `, values);
    stats.eventsInserted += events.length;
  } catch (err) {
    console.error(`Error inserting ${events.length} events:`, err.message);
    stats.errorsEncountered++;
  }
}

async function backfillLabelForWorkspace(workspaceId, label) {
  console.log(`    ${label}...`);
  let page = 1;
  let totalLeads = 0;
  const eventBatch = [];

  try {
    while (true) {
      const leads = await fetchLeadsPage(workspaceId, label, page);
      if (leads.length === 0) break;

      totalLeads += leads.length;

      // Convert lead records to event records
      leads.forEach(lead => {
        // Each lead with a status is an event
        const eventType = mapLabelToEventType(label);
        const eventDate = lead.first_opened_at || lead.clicked_at || lead.replied_at || lead.updated_at || new Date();

        eventBatch.push({
          workspace_id: workspaceId,
          event_type: eventType,
          event_at: new Date(eventDate),
          campaign_id: lead.campaign_id || null,
          lead_email: lead.email || null,
          raw: JSON.stringify(lead)
        });

        // Also create a 'sent' event if not already present
        if (lead.created_at && eventType !== 'sent') {
          eventBatch.push({
            workspace_id: workspaceId,
            event_type: 'sent',
            event_at: new Date(lead.created_at),
            campaign_id: lead.campaign_id || null,
            lead_email: lead.email || null,
            raw: null
          });
        }
      });

      // Insert in batches
      while (eventBatch.length >= BATCH_SIZE) {
        await insertEventBatch(eventBatch.splice(0, BATCH_SIZE));
      }

      page++;
    }

    // Insert remaining events
    if (eventBatch.length > 0) {
      await insertEventBatch(eventBatch);
    }

    console.log(`      ${totalLeads} leads → ${totalLeads * 2} events (sent + event type)`);
    stats.leadsProcessed += totalLeads;

  } catch (err) {
    console.warn(`    ⚠️  Error fetching ${label}: ${err.message}`);
  }
}

function mapLabelToEventType(label) {
  const labelUpper = label.toUpperCase();
  if (labelUpper.includes('REPLIED')) return 'reply';
  if (labelUpper.includes('BOUNCE')) return 'bounce';
  if (labelUpper.includes('INTERESTED')) return 'interested';
  if (labelUpper.includes('MEETING')) return 'meeting_booked';
  return 'event';
}

async function backfillWorkspace(workspaceId) {
  console.log(`\n📥 Backfilling workspace: ${workspaceId}`);

  try {
    // Fetch leads with different statuses
    const labels = [
      'REPLIED',
      'BOUNCED',
      'INTERESTED',
      'MEETING_BOOKED',
      'UNSUBSCRIBED'
    ];

    for (const label of labels) {
      await backfillLabelForWorkspace(workspaceId, label);
    }

    stats.workspacesProcessed++;
    console.log(`  ✅ Workspace backfill complete`);

  } catch (err) {
    console.error(`❌ Error backfilling workspace ${workspaceId}:`, err.message);
    stats.errorsEncountered++;
  }
}

async function getAllWorkspaces() {
  try {
    const result = await db.query(`
      SELECT DISTINCT workspace_id FROM clients WHERE workspace_id IS NOT NULL
      ORDER BY workspace_id
    `);
    const workspaces = result.rows.map(r => r.workspace_id).filter(Boolean);
    return workspaces.length > 0 ? workspaces : ['6912ddfef9582848982b9a62'];
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
    console.log('✅ Database connected\n');

    // Get target workspaces
    let workspaces = [];
    if (process.argv[2]) {
      // Specific workspace provided
      workspaces = [process.argv[2]];
    } else {
      // All workspaces
      workspaces = await getAllWorkspaces();
    }

    console.log(`📊 Backfill Plan`);
    console.log(`Workspaces: ${workspaces.length}`);
    console.log(`Labels: REPLIED, BOUNCED, INTERESTED, MEETING_BOOKED, UNSUBSCRIBED`);
    console.log(`This will fetch all leads from PlusVibe and create event records.\n`);

    const startTime = Date.now();

    // Backfill each workspace
    for (const ws of workspaces) {
      await backfillWorkspace(ws);
    }

    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);

    // Print summary
    console.log('\n═════════════════════════════════════════');
    console.log('BACKFILL COMPLETE');
    console.log('═════════════════════════════════════════');
    console.log(`Time elapsed: ${elapsedSeconds}s`);
    console.log(`Workspaces processed: ${stats.workspacesProcessed}`);
    console.log(`Leads processed: ${stats.leadsProcessed}`);
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
        COUNT(*) FILTER (WHERE event_type = 'bounce') as bounces,
        COUNT(*) FILTER (WHERE event_type = 'interested') as interested,
        COUNT(*) FILTER (WHERE event_type = 'meeting_booked') as meetings
      FROM email_events
    `);

    const result = verification.rows[0];
    console.log(`\n✅ email_events summary:`);
    console.log(`  Total events: ${result.total_events}`);
    console.log(`  Workspaces: ${result.workspaces}`);
    console.log(`  Days with data: ${result.days_with_data}`);
    console.log(`  Date range: ${result.earliest_date} to ${result.latest_date}`);
    console.log(`  Sends: ${result.sends}`);
    console.log(`  Replies: ${result.replies}`);
    console.log(`  Bounces: ${result.bounces}`);
    console.log(`  Interested: ${result.interested}`);
    console.log(`  Meetings: ${result.meetings}`);

    if (result.total_events > 100000 && result.days_with_data > 30) {
      console.log(`\n✅ Ready for Phase 1 implementation!\n`);
    } else {
      console.log(`\n⚠️  Limited data. May need manual PlusVibe export or more time for leads to accumulate.\n`);
    }

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
