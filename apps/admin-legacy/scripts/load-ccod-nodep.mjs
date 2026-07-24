// Dependency-free CCOD loader (uses only `pg`, no pg-copy-streams). Runs anywhere
// that has `pg` + DATABASE_URL — e.g. the admin-legacy container, which has a
// mounted volume for the upload but lacks pg-copy-streams.
//
// Reads the gzipped TSV from ccod-to-tsv.mjs and batch-inserts into ch_ccod.
// Slower than COPY but fine for ~2.8M rows. TRUNCATEs first (full monthly reload).
//
// Usage: node load-ccod-nodep.mjs /data2/ccod-slim.tsv.gz [label]

import fs from 'node:fs'
import zlib from 'node:zlib'
import readline from 'node:readline'
import pg from 'pg'

const [input, label] = process.argv.slice(2)
if (!input) { console.error('Usage: node load-ccod-nodep.mjs <ccod-slim.tsv.gz> [label]'); process.exit(1) }
if (!fs.existsSync(input)) { console.error('Not found:', input); process.exit(1) }

const { Client } = pg
const client = new Client({ connectionString: process.env.DATABASE_URL })

const BATCH = 1000
let batch = []
let total = 0

async function flush() {
  if (!batch.length) return
  const vals = []
  const ph = batch.map((r, i) => {
    const b = i * 7
    vals.push(r[0], r[1] || null, r[2] || null, r[3] || null, r[4] || null, r[5] || null, r[6] || null)
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`
  })
  await client.query(
    `INSERT INTO ch_ccod (postcode,title_number,tenure,property_address,proprietor_name,company_reg_no,proprietor_category)
     VALUES ${ph.join(',')}`, vals)
  batch = []
}

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
  console.error('Truncating ch_ccod…')
  await client.query('TRUNCATE ch_ccod')

  const rl = readline.createInterface({ input: fs.createReadStream(input).pipe(zlib.createGunzip()), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    const f = line.split('\t')
    if (!f[0]) continue
    batch.push(f); total++
    if (batch.length >= BATCH) { await flush(); if (total % 100000 === 0) console.error(`  …${total} rows`) }
  }
  await flush()

  console.error('Building postcode index…')
  await client.query('CREATE INDEX IF NOT EXISTS idx_ch_ccod_postcode ON ch_ccod(postcode)')
  await client.query(
    `INSERT INTO ch_ccod_meta (id, loaded_at, snapshot, row_count) VALUES (1, now(), $1, $2)
     ON CONFLICT (id) DO UPDATE SET loaded_at=now(), snapshot=$1, row_count=$2`,
    [label || input.split('/').pop(), total])
  console.error(`Done. ${total} CCOD owner rows loaded into ch_ccod.`)
  await client.end()
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
