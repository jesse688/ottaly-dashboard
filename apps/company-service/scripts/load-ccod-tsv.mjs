// Fast loader: COPY-streams the gzipped CCOD TSV (from ccod-to-tsv.mjs) into ch_ccod.
// Usage (in container): node scripts/load-ccod-tsv.mjs /app/ccod-slim.tsv.gz [label]
// Truncates ch_ccod first (CCOD is a full monthly replacement).

import fs from 'node:fs'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import pg from 'pg'
import copyFrom from 'pg-copy-streams'

const [input, label] = process.argv.slice(2)
if (!input) { console.error('Usage: node scripts/load-ccod-tsv.mjs <ccod-slim.tsv.gz> [label]'); process.exit(1) }
if (!fs.existsSync(input)) { console.error('Not found:', input); process.exit(1) }

const { Client } = pg
const client = new Client({ connectionString: process.env.DATABASE_URL })

async function main() {
  await client.connect()
  await client.query(`
    CREATE TABLE IF NOT EXISTS ch_ccod (
      postcode TEXT NOT NULL, title_number TEXT, tenure TEXT, property_address TEXT,
      proprietor_name TEXT, company_reg_no TEXT, proprietor_category TEXT,
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS ch_ccod_meta (id INT PRIMARY KEY DEFAULT 1,
      loaded_at TIMESTAMPTZ, snapshot TEXT, row_count BIGINT);
  `)
  console.error('Preparing staging…')
  await client.query(`DROP TABLE IF EXISTS ch_ccod_stage`)
  await client.query(`CREATE UNLOGGED TABLE ch_ccod_stage (
    postcode TEXT, title_number TEXT, tenure TEXT, property_address TEXT,
    proprietor_name TEXT, company_reg_no TEXT, proprietor_category TEXT)`)

  console.error('COPY streaming', input, '…')
  const stream = client.query(copyFrom.from(
    `COPY ch_ccod_stage (postcode,title_number,tenure,property_address,proprietor_name,company_reg_no,proprietor_category)
     FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '')`
  ))
  await pipeline(fs.createReadStream(input), zlib.createGunzip(), stream)

  const { rows: c } = await client.query(`SELECT COUNT(*)::bigint AS n FROM ch_ccod_stage`)
  console.error(`Staged ${c[0].n} rows. Swapping into ch_ccod…`)
  await client.query('BEGIN')
  await client.query('TRUNCATE ch_ccod')
  await client.query(`INSERT INTO ch_ccod (postcode,title_number,tenure,property_address,proprietor_name,company_reg_no,proprietor_category)
    SELECT postcode, NULLIF(title_number,''), NULLIF(tenure,''), NULLIF(property_address,''),
           NULLIF(proprietor_name,''), NULLIF(company_reg_no,''), NULLIF(proprietor_category,'')
      FROM ch_ccod_stage WHERE postcode <> ''`)
  await client.query(`CREATE INDEX IF NOT EXISTS idx_ch_ccod_postcode ON ch_ccod(postcode)`)
  const { rows: fin } = await client.query(`SELECT COUNT(*)::bigint AS n FROM ch_ccod`)
  await client.query(
    `INSERT INTO ch_ccod_meta (id, loaded_at, snapshot, row_count) VALUES (1, now(), $1, $2)
     ON CONFLICT (id) DO UPDATE SET loaded_at=now(), snapshot=$1, row_count=$2`,
    [label || input.split('/').pop(), fin[0].n])
  await client.query('COMMIT')
  await client.query(`DROP TABLE IF EXISTS ch_ccod_stage`)
  console.error(`Done. ${fin[0].n} CCOD owner rows loaded into ch_ccod.`)
  await client.end()
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
