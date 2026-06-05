// One-off: reset owns_building back to 'unknown' for all auto-detected values.
// The reply detection regex had false positives (our building / own our matching
// replies that actually meant the contact does NOT own). Safe to wipe and let
// new replies re-classify correctly going forward.
//
// Run on Easypanel:  node scripts/clear-owns-building.js
// DRY_RUN=1 node scripts/clear-owns-building.js  — shows counts only, no writes

require('dotenv').config();
const { Pool } = require('pg');

const DRY_RUN = process.env.DRY_RUN === '1';

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        user:     process.env.DB_USER     || 'ottaly',
        password: process.env.DB_PASSWORD || 'ottaly_dev',
        host:     process.env.DB_HOST     || 'ottaly_ottaly-postgres',
        port:     parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME     || 'ottaly_contacts',
      }
);

async function main() {
  const { rows: before } = await pool.query(
    `SELECT owns_building, COUNT(*) AS n FROM contacts GROUP BY owns_building ORDER BY owns_building`
  );
  console.log('Current distribution:');
  before.forEach(r => console.log(`  ${r.owns_building || 'null'}: ${r.n}`));

  if (DRY_RUN) {
    console.log('\nDRY_RUN — no changes made.');
    return;
  }

  // Reset everything back to unknown so new replies re-classify cleanly.
  const { rowCount } = await pool.query(
    `UPDATE contacts SET owns_building = 'unknown', updated_at = CURRENT_TIMESTAMP
     WHERE owns_building IN ('yes', 'no')`
  );
  console.log(`\nReset ${rowCount} rows → 'unknown'.`);
}

main().catch(console.error).finally(() => pool.end());
