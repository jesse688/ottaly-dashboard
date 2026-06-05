#!/usr/bin/env node

/**
 * Generate synthetic email_events data for demo/testing
 *
 * Creates realistic 90+ days of event data with:
 * - Daily send volumes
 * - Realistic reply rates (8-15%)
 * - Bounce rates (2-5%)
 * - Multiple workspaces/campaigns
 * - Patterns: good days, bad days, trends
 *
 * Usage:
 *   node backfill-synthetic-data.js
 */

const PostgresDatabase = require('./db-postgres.js');

let db = null;

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
    return events.length;
  } catch (err) {
    console.error(`Error inserting events:`, err.message);
    return 0;
  }
}

function generateEventsForDay(date, workspace, campaign, config) {
  const events = [];
  const dayOfWeek = date.getDay();

  // Base send count (lower on weekends)
  const baselineDaily = config.dailyBaselineSends;
  const weekendFactor = (dayOfWeek === 0 || dayOfWeek === 6) ? 0.6 : 1.0;
  const sendCount = Math.floor(baselineDaily * weekendFactor * (0.8 + Math.random() * 0.4));

  // Reply rate varies day by day (7-15%)
  const replyRate = 0.07 + Math.random() * 0.08;
  const replyCount = Math.floor(sendCount * replyRate);

  // Bounce rate (1-5%)
  const bounceRate = 0.01 + Math.random() * 0.04;
  const bounceCount = Math.floor(sendCount * bounceRate);

  // Add sends
  for (let i = 0; i < sendCount; i++) {
    const hour = 8 + Math.floor(Math.random() * 8); // 8am-4pm
    const minute = Math.floor(Math.random() * 60);
    const eventDate = new Date(date);
    eventDate.setHours(hour, minute, 0);

    events.push({
      workspace_id: workspace,
      event_type: 'sent',
      event_at: eventDate,
      campaign_id: campaign,
      lead_email: null,
      raw: null
    });
  }

  // Add replies (1-2 days later)
  for (let i = 0; i < replyCount; i++) {
    const daysLater = 1 + Math.floor(Math.random() * 2);
    const replyDate = new Date(date);
    replyDate.setDate(replyDate.getDate() + daysLater);
    replyDate.setHours(10 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 60), 0);

    events.push({
      workspace_id: workspace,
      event_type: 'reply',
      event_at: replyDate,
      campaign_id: campaign,
      lead_email: null,
      raw: null
    });
  }

  // Add bounces (same day or next day)
  for (let i = 0; i < bounceCount; i++) {
    const daysLater = Math.random() > 0.7 ? 1 : 0;
    const bounceDate = new Date(date);
    bounceDate.setDate(bounceDate.getDate() + daysLater);
    bounceDate.setHours(8 + Math.floor(Math.random() * 12), Math.floor(Math.random() * 60), 0);

    events.push({
      workspace_id: workspace,
      event_type: 'bounce',
      event_at: bounceDate,
      campaign_id: campaign,
      lead_email: null,
      raw: null
    });
  }

  return events;
}

async function generateSyntheticData() {
  console.log('Generating synthetic email_events data for demo/testing...\n');

  const allEvents = [];
  let processedDays = 0;

  // Generate 90 days of data for Accrue workspace
  const workspace = '6912ddfef9582848982b9a62';
  const campaigns = ['accrue-cold', 'accrue-warm', 'accrue-nurture'];

  // Start 90 days ago
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);

  console.log(`Generating data from ${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Campaigns: ${campaigns.join(', ')}\n`);

  // Simulate a trend: starts at 12% RR, declines to 8%, recovers to 14%
  const dayCount = Math.floor((endDate - startDate) / (24 * 60 * 60 * 1000));

  for (let daysAgo = dayCount; daysAgo >= 0; daysAgo--) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);

    // Vary daily sends based on position in 90-day arc
    const dayIndex = dayCount - daysAgo;
    const pct = dayIndex / dayCount;

    // Trend shape: 1500 → 1200 → 1800 (starts high, dips, recovers)
    const dailyBaselineSends = 1500 - (300 * Math.sin(pct * Math.PI * 2.5));

    for (const campaign of campaigns) {
      const dayEvents = generateEventsForDay(
        date,
        workspace,
        campaign,
        { dailyBaselineSends: dailyBaselineSends / campaigns.length }
      );
      allEvents.push(...dayEvents);
    }

    processedDays++;
  }

  console.log(`Generated ${allEvents.length} events across ${processedDays} days`);
  console.log(`\nInserting into database...`);

  let inserted = 0;
  const batchSize = 1000;
  for (let i = 0; i < allEvents.length; i += batchSize) {
    const batch = allEvents.slice(i, i + batchSize);
    inserted += await insertEventBatch(batch);
    process.stdout.write('.');
  }

  console.log('\n\nVerifying data...');
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

  console.log(`\n✅ Synthetic data created:`);
  console.log(`  Total events: ${result.total_events}`);
  console.log(`  Workspaces: ${result.workspaces}`);
  console.log(`  Days with data: ${result.days_with_data}`);
  console.log(`  Date range: ${result.earliest_date} to ${result.latest_date}`);
  console.log(`  Sends: ${result.sends}`);
  console.log(`  Replies: ${result.replies} (${Math.round((result.replies / result.sends) * 100)}% RR)`);
  console.log(`  Bounces: ${result.bounces} (${Math.round((result.bounces / result.sends) * 100)}% bounce rate)`);

  // Calculate daily metrics
  const daily = await db.query(`
    SELECT
      DATE(event_at)::date as date,
      COUNT(*) FILTER (WHERE event_type = 'sent') as sends,
      COUNT(*) FILTER (WHERE event_type = 'reply') as replies,
      COUNT(*) FILTER (WHERE event_type = 'bounce') as bounces
    FROM email_events
    GROUP BY DATE(event_at)
    ORDER BY date DESC
    LIMIT 7
  `);

  console.log(`\n📊 Last 7 days:`);
  daily.rows.reverse().forEach(row => {
    const rr = row.sends > 0 ? Math.round((row.replies / row.sends) * 100) : 0;
    const br = row.sends > 0 ? Math.round((row.bounces / row.sends) * 100) : 0;
    console.log(`  ${row.date}: ${row.sends} sends, ${row.replies} replies (${rr}% RR), ${row.bounces} bounces (${br}% BR)`);
  });

  console.log(`\n✅ Ready for Phase 0 validation!\n`);
}

async function main() {
  try {
    console.log('Initializing database...');
    db = new PostgresDatabase();
    await db.init();
    console.log('✅ Database connected\n');

    await generateSyntheticData();

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
