// Fast loader (run in the container). Bulk-COPYs the compact gzipped TSV produced
// by psc-to-tsv.mjs into ch_psc. COPY is ~orders of magnitude faster than
// row-by-row INSERT for 11M rows.
//
// Usage (in the company-service container, same DATABASE_URL):
//   node scripts/load-psc-tsv.mjs /app/psc/psc-slim.tsv.gz [snapshot-label]
//
// Truncates ch_psc first (a PSC snapshot is a full replacement each month).

import fs from 'node:fs'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import pg from 'pg'
import copyFrom from 'pg-copy-streams'

const [input, label] = process.argv.slice(2)
if (!input) {
  console.error('Usage: node scripts/load-psc-tsv.mjs <psc-slim.tsv.gz> [label]')
  process.exit(1)
}
if (!fs.existsSync(input)) { console.error('Not found:', input); process.exit(1) }

const { Client } = pg
const client = new Client({ connectionString: process.env.DATABASE_URL })

async function main() {
  await client.connect()
  await client.query(`
    CREATE TABLE IF NOT EXISTS ch_psc (
      company_number TEXT NOT NULL, name TEXT, kind TEXT, ceased_on TEXT,
      natures TEXT[], created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS ch_psc_meta (id INT PRIMARY KEY DEFAULT 1,
      loaded_at TIMESTAMPTZ, snapshot TEXT, row_count BIGINT);
  `)

  // Load into a staging table (COPY can't build arrays inline), then transform.
  console.error('Preparing staging table…')
  await client.query(`DROP TABLE IF EXISTS ch_psc_stage`)
  await client.query(`CREATE UNLOGGED TABLE ch_psc_stage (
    company_number TEXT, name TEXT, kind TEXT, ceased_on TEXT, natures_csv TEXT)`)

  console.error('COPY streaming', input, '…')
  const stream = client.query(copyFrom.from(
    `COPY ch_psc_stage (company_number,name,kind,ceased_on,natures_csv)
     FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '')`
  ))
  await pipeline(fs.createReadStream(input), zlib.createGunzip(), stream)

  const { rows: cnt } = await client.query(`SELECT COUNT(*)::bigint AS n FROM ch_psc_stage`)
  console.error(`Staged ${cnt[0].n} rows. Transforming into ch_psc…`)

  await client.query('BEGIN')
  await client.query('TRUNCATE ch_psc')
  await client.query(`
    INSERT INTO ch_psc (company_number, name, kind, ceased_on, natures)
    SELECT company_number, NULLIF(name,''), kind, NULLIF(ceased_on,''),
           CASE WHEN natures_csv = '' THEN NULL ELSE string_to_array(natures_csv, ',') END
      FROM ch_psc_stage
     WHERE company_number <> '' AND kind <> ''`)
  await client.query(`CREATE INDEX IF NOT EXISTS idx_ch_psc_company ON ch_psc(company_number)`)
  const { rows: final } = await client.query(`SELECT COUNT(*)::bigint AS n FROM ch_psc`)
  await client.query(
    `INSERT INTO ch_psc_meta (id, loaded_at, snapshot, row_count)
     VALUES (1, now(), $1, $2)
     ON CONFLICT (id) DO UPDATE SET loaded_at=now(), snapshot=$1, row_count=$2`,
    [label || input.split('/').pop(), final[0].n])
  await client.query('COMMIT')
  await client.query(`DROP TABLE IF EXISTS ch_psc_stage`)

  console.error(`Done. ${final[0].n} PSC rows loaded into ch_psc.`)
  await client.end()
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
