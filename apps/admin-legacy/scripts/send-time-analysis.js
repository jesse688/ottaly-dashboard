// Run in Easypanel terminal: node scripts/send-time-analysis.js
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

async function run() {
  const client = await pool.connect();
  try {
    console.log('\n=== COVERAGE ===');
    const cov = await client.query(`
      SELECT event_type, MIN(event_at)::date AS earliest, MAX(event_at)::date AS latest, COUNT(*)::int AS total
      FROM email_events
      WHERE event_type IN ('sent','reply','lead','positive_reply')
      GROUP BY event_type ORDER BY event_type
    `);
    console.table(cov.rows);

    console.log('\n=== BY DAY OF WEEK (0=Sun, 1=Mon ... 5=Fri, 6=Sat) ===');
    const daily = await client.query(`
      SELECT
        EXTRACT(DOW FROM event_at AT TIME ZONE 'Europe/London')::int AS dow,
        COUNT(*) FILTER (WHERE event_type IN ('reply','lead','positive_reply'))::int AS replies,
        COUNT(*) FILTER (WHERE event_type = 'sent')::int AS sent,
        ROUND(100.0 * COUNT(*) FILTER (WHERE event_type IN ('reply','lead','positive_reply'))
              / NULLIF(COUNT(*) FILTER (WHERE event_type = 'sent'), 0), 2) AS reply_rate_pct
      FROM email_events
      WHERE event_at > NOW() - INTERVAL '90 days'
      GROUP BY 1 ORDER BY 1
    `);
    console.table(daily.rows);

    console.log('\n=== BY HOUR (UK time, Mon-Fri only, last 90 days) ===');
    const hourly = await client.query(`
      SELECT
        EXTRACT(HOUR FROM event_at AT TIME ZONE 'Europe/London')::int AS hour,
        COUNT(*) FILTER (WHERE event_type IN ('reply','lead','positive_reply'))::int AS replies,
        COUNT(*) FILTER (WHERE event_type = 'sent')::int AS sent,
        ROUND(100.0 * COUNT(*) FILTER (WHERE event_type IN ('reply','lead','positive_reply'))
              / NULLIF(COUNT(*) FILTER (WHERE event_type = 'sent'), 0), 2) AS reply_rate_pct
      FROM email_events
      WHERE event_at > NOW() - INTERVAL '90 days'
        AND EXTRACT(DOW FROM event_at AT TIME ZONE 'Europe/London') BETWEEN 1 AND 5
      GROUP BY 1 ORDER BY 1
    `);
    console.table(hourly.rows);

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
