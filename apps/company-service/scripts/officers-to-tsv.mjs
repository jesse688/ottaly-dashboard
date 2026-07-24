// Parse the Companies House "Company Appointments" bulk snapshot (prod195/prod216,
// fixed-width + chevron format, ~8GB across jurisdiction files) into a compact
// gzipped TSV for ch_directors:  company_number \t name \t role
//
// Free public mirror: https://s3.companiescatalogue.co.uk/free/prod216/<date>/Prod216_*.dat
// Record layout (per line):
//   pos 0-7  = company number
//   pos 8    = record type: '1' = company header, '2' = officer/appointment
//   type-2 tail (chevron-delimited): <prefix…>TITLE<FORENAMES<SURNAME<<<<addr…<ROLE<NATIONALITY<…
// We keep officer records only, reconstructing the CH-style "SURNAME, Forenames"
// name that the resolver's parseCHName expects, plus the role.
//
// Usage: node scripts/officers-to-tsv.mjs <Prod216_*.dat> [more.dat …] <out.tsv.gz>
// (last arg is the output; all preceding args are input .dat files — pass all
//  jurisdiction parts at once, e.g. ew_1..7 + sc + ni)

import fs from 'node:fs'
import zlib from 'node:zlib'
import readline from 'node:readline'

const args = process.argv.slice(2)
if (args.length < 2) {
  console.error('Usage: node scripts/officers-to-tsv.mjs <in1.dat> [in2.dat …] <out.tsv.gz>')
  process.exit(1)
}
const output = args[args.length - 1]
const inputs = args.slice(0, -1)

const clean = (s) => String(s == null ? '' : s).replace(/[\x00-\x1f\u2028\u2029\\]+/g, ' ').replace(/\s+/g, ' ').trim()

// From a type-2 line, extract { name: "SURNAME, Forenames", role }.
// The name is the first three chevron fields (TITLE<FORENAMES<SURNAME) sitting just
// after a fixed prefix; the address follows after the "<<<<" gap; the role is the
// chevron field two before nationality. We locate by the name block, not fixed
// columns, since the prefix width varies.
function parseOfficer(line) {
  const companyNumber = line.slice(0, 8).trim()
  if (!companyNumber) return null
  const firstChev = line.indexOf('<')
  if (firstChev < 0) return null
  // Back up from the first chevron to the start of TITLE (skip the 4-char count
  // field, e.g. "0117"): title starts right after the last run of digits+spaces.
  let start = firstChev
  while (start > 0 && !/[0-9\s]/.test(line[start - 1]) === false) start-- // walk back over title chars? no — simpler below
  // Simpler & robust: the chevron block from the first '<' backward to the last
  // digit is TITLE. Take everything from the char after the trailing numeric
  // prefix. Find last digit before firstChev:
  let p = firstChev - 1
  while (p >= 0 && !/\d/.test(line[p])) p--        // skip title letters back to a digit
  const title = line.slice(p + 1, firstChev)        // e.g. "MR"
  const rest = line.slice(firstChev + 1)            // FORENAMES<SURNAME<<<<addr…<ROLE<NAT<…
  const parts = rest.split('<')
  const forenames = parts[0] || ''
  const surname = parts[1] || ''
  // Role: after the address block. Address is parts[2..] until we've passed the
  // empty separators; role is a later field. CH puts ROLE then NATIONALITY then
  // country. Heuristic: role is the 3rd-from-last non-empty field. Good enough —
  // the resolver only uses name for matching; role is informational.
  const nonEmpty = parts.filter((x) => x.trim())
  const role = nonEmpty.length >= 3 ? nonEmpty[nonEmpty.length - 3] : ''
  const name = surname ? (forenames ? `${surname.trim()}, ${forenames.trim()}` : surname.trim())
    : (forenames.trim() || title.trim())
  if (!name) return null
  return { companyNumber, name: clean(name), role: clean(role) }
}

const gzip = zlib.createGzip()
const out = fs.createWriteStream(output)
gzip.pipe(out)
for (const [nm, s] of [['gzip', gzip], ['out', out]]) s.on('error', (e) => { console.error(`FATAL ${nm}:`, e.message); process.exit(1) })

let paused = false
gzip.on('drain', () => { if (paused) { paused = false; if (currentRl) currentRl.resume() } })
let currentRl = null
let total = 0, kept = 0

async function processFile(file) {
  if (!fs.existsSync(file)) { console.error('skip (not found):', file); return }
  console.error('Parsing', file, '…')
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'latin1' }), crlfDelay: Infinity })
  currentRl = rl
  for await (const line of rl) {
    if (!line || line.length < 9) continue
    total++
    if (line[8] !== '2') continue // officer records only
    const o = parseOfficer(line)
    if (!o) continue
    const row = `${o.companyNumber}\t${o.name}\t${o.role}\n`
    if (!gzip.write(row) && !paused) { paused = true; rl.pause() }
    kept++
    if (total % 500000 === 0) console.error(`  …${total} lines, ${kept} officers`)
  }
}

for (const f of inputs) await processFile(f)
gzip.end(() => console.error(`Done. ${total} lines read, ${kept} officers written to ${output}`))
