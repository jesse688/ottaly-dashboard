// Import the Companies House free PSC bulk snapshot into ch_psc.
//
// Source: http://download.companieshouse.gov.uk/en_pscdata.html
//   - Split into numbered zips (…_Nof26.zip); unzip to get JSON-lines .txt files.
//   - Each line: {"company_number":"...","data":{ kind, name, ceased_on, natures_of_control, ... }}
//   - kind "…-statement" lines carry a statement (e.g. "no individual … with control")
//     rather than a person — we keep those too (kind + name=null) so the resolver
//     can tell "filed no PSC" apart from "not in dataset".
//
// Usage (run on the server, against the same DATABASE_URL):
//   node scripts/import-psc-bulk.js /data/psc/psc-snapshot-1of26.txt [more files…]
//   node scripts/import-psc-bulk.js --truncate /data/psc/*.txt   # fresh load
//
// --truncate clears ch_psc first (use for a full monthly reload). Idempotent
// per file otherwise; run all parts in one invocation or successive ones.

import fs from 'node:fs'
import readline from 'node:readline'
import pg from 'pg'

const args = process.argv.slice(2)
const truncate = args.includes('--truncate')
const files = args.filter((a) => a !== '--truncate')
if (!files.length) {
  console.error('Usage: node scripts/import-psc-bulk.js [--truncate] <file.txt> [file2.txt …]')
  process.exit(1)
}

const { Client } = pg
const client = new Client({ connectionString: process.env.DATABASE_URL })

function parseLine(line) {
  let j
  try { j = JSON.parse(line) } catch { return null }
  const num = j.company_number
  const d = j.data || {}
  if (!num || !d.kind) return null
  return {
    company_number: num,
    name: d.name || null,
    kind: d.kind,
    ceased_on: d.ceased_on || null,
    natures: Array.isArray(d.natures_of_control) ? d.natures_of_control : null,
  }
}

async function flush(batch) {
  if (!batch.length) return
  const vals = []
  const ph = batch.map((r, i) => {
    const b = i * 5
    vals.push(r.company_number, r.name, r.kind, r.ceased_on, r.natures)
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`
  })
  await client.query(
    `INSERT INTO ch_psc (company_number, name, kind, ceased_on, natures) VALUES ${ph.join(',')}`,
    vals
  )
}

async function main() {
  await client.connect()
  // Ensure the table exists (mirrors ensureSchema so the script is standalone).
  await client.query(`
    CREATE TABLE IF NOT EXISTS ch_psc (
      company_number TEXT NOT NULL, name TEXT, kind TEXT, ceased_on TEXT,
      natures TEXT[], created_at TIMESTAMPTZ DEFAULT now());
    CREATE INDEX IF NOT EXISTS idx_ch_psc_company ON ch_psc(company_number);
    CREATE TABLE IF NOT EXISTS ch_psc_meta (id INT PRIMARY KEY DEFAULT 1,
      loaded_at TIMESTAMPTZ, snapshot TEXT, row_count BIGINT);
  `)
  if (truncate) { console.log('Truncating ch_psc…'); await client.query('TRUNCATE ch_psc') }

  let total = 0, kept = 0
  for (const file of files) {
    if (!fs.existsSync(file)) { console.error('skip (not found):', file); continue }
    console.log('Importing', file, '…')
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    let batch = []
    for await (const line of rl) {
      if (!line.trim()) continue
      total++
      const rec = parseLine(line)
      if (!rec) continue
      batch.push(rec); kept++
      if (batch.length >= 1000) { await flush(batch); batch = [] }
      if (total % 100000 === 0) console.log(`  …${total} lines, ${kept} kept`)
    }
    await flush(batch)
  }
  await client.query(
    `INSERT INTO ch_psc_meta (id, loaded_at, snapshot, row_count)
     VALUES (1, now(), $1, $2)
     ON CONFLICT (id) DO UPDATE SET loaded_at=now(), snapshot=$1, row_count=$2`,
    [files.map((f) => f.split('/').pop()).join(','), kept]
  )
  console.log(`Done. ${total} lines read, ${kept} PSC rows imported.`)
  await client.end()
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
