// Load the officers TSV (from officers-to-tsv.mjs) into ch_directors — the table
// admin-legacy already uses (so both apps benefit). These bulk officers are the
// current-appointments snapshot (resigned officers aren't in prod216), so we mark
// them fetched_by_svc_at = now() and resigned_on = NULL, which is exactly what the
// resolver's cachedOfficers() trusts.
//
// Usage (in container): node scripts/load-officers-tsv.mjs /app/officers.tsv.gz [label]
// Replaces the service-loaded officer set (rows with fetched_by_svc_at) via a
// staging swap; leaves admin-legacy's on-demand rows (fetched_by_svc_at IS NULL)
// untouched.

import fs from 'node:fs'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import pg from 'pg'
import copyFrom from 'pg-copy-streams'

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const [input, label] = positional
if (!input) { console.error('Usage: node scripts/load-officers-tsv.mjs [--append] <officers.tsv.gz> [label]'); process.exit(1) }
if (!fs.existsSync(input)) { console.error('Not found:', input); process.exit(1) }

const { Client } = pg
const client = new Client({ connectionString: process.env.DATABASE_URL })

async function main() {
  await client.connect()
  // ch_directors must exist (admin-legacy creates it). Ensure the columns we use.
  await client.query(`ALTER TABLE ch_directors ADD COLUMN IF NOT EXISTS fetched_by_svc_at TIMESTAMPTZ`).catch(() => {})
  await client.query(`CREATE TABLE IF NOT EXISTS ch_officers_meta (id INT PRIMARY KEY DEFAULT 1,
    loaded_at TIMESTAMPTZ, snapshot TEXT, row_count BIGINT)`)

  console.error('Staging…')
  await client.query(`DROP TABLE IF EXISTS ch_dir_stage`)
  await client.query(`CREATE UNLOGGED TABLE ch_dir_stage (company_number TEXT, name TEXT, role TEXT)`)

  console.error('COPY streaming', input, '…')
  const stream = client.query(copyFrom.from(
    `COPY ch_dir_stage (company_number,name,role) FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '')`
  ))
  await pipeline(fs.createReadStream(input), zlib.createGunzip(), stream)

  const { rows: c } = await client.query(`SELECT COUNT(*)::bigint AS n FROM ch_dir_stage`)
  console.error(`Staged ${c[0].n} rows. Swapping the service-loaded officer set in ch_directors…`)

  await client.query('BEGIN')
  // By default REPLACE the service officer set (full monthly reload). Pass
  // --append (env APPEND=1) to ADD to it instead — used to load ew_2..ew_7 on top
  // of an already-loaded ew_1 without re-parsing the first part.
  const append = process.argv.includes('--append') || /^(1|true|yes)$/i.test(process.env.APPEND || '')
  if (!append) await client.query(`DELETE FROM ch_directors WHERE fetched_by_svc_at IS NOT NULL`)
  // Insert fresh. resigned_on NULL (snapshot = current appointments only).
  // ch_directors has UNIQUE(company_number, name, role); the bulk snapshot contains
  // duplicate (company, person, role) combos, so dedupe in the SELECT and skip any
  // that still collide with admin-legacy's kept rows.
  // ch_directors: UNIQUE(company_number,name,role) AND a FK to ch_companies. So:
  //  - dedupe in-batch (bulk has duplicate person/role combos), role coalesced to ''
  //  - only insert officers whose company EXISTS in ch_companies (the FK) — orphan
  //    companies aren't in our data, so their officers can't match anything anyway
  //  - ON CONFLICT DO NOTHING for any that collide with admin-legacy's kept rows
  await client.query(`
    INSERT INTO ch_directors (company_number, name, role, resigned_on, fetched_by_svc_at)
    SELECT DISTINCT ON (s.company_number, s.name, COALESCE(NULLIF(s.role,''),''))
           s.company_number, s.name, COALESCE(NULLIF(s.role,''),''), NULL, now()
      FROM ch_dir_stage s
     WHERE s.company_number <> '' AND s.name <> ''
       AND EXISTS (SELECT 1 FROM ch_companies c WHERE c.company_number = s.company_number)
    ON CONFLICT (company_number, name, role) DO NOTHING`)
  const { rows: fin } = await client.query(`SELECT COUNT(*)::bigint AS n FROM ch_directors WHERE fetched_by_svc_at IS NOT NULL`)
  await client.query(`CREATE INDEX IF NOT EXISTS idx_ch_directors_company ON ch_directors(company_number)`)
  await client.query(
    `INSERT INTO ch_officers_meta (id, loaded_at, snapshot, row_count) VALUES (1, now(), $1, $2)
     ON CONFLICT (id) DO UPDATE SET loaded_at=now(), snapshot=$1, row_count=$2`,
    [label || input.split('/').pop(), fin[0].n])
  await client.query('COMMIT')
  await client.query(`DROP TABLE IF EXISTS ch_dir_stage`)
  console.error(`Done. ${fin[0].n} officers loaded into ch_directors (service set).`)
  await client.end()
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
