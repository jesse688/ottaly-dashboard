// Pre-filter the HM Land Registry CCOD full CSV ("UK companies that own property
// in England and Wales") into a compact gzipped TSV for ch_ccod:
//   postcode \t title_number \t tenure \t property_address \t proprietor_name \t company_reg_no \t proprietor_category
// One output row per (title, proprietor) — CCOD lists up to 4 proprietors per title.
//
// Usage: node scripts/ccod-to-tsv.mjs <CCOD_FULL.csv> <out.tsv.gz>
// Download (free, after registering): https://use-land-property-data.service.gov.uk/datasets/ccod

import fs from 'node:fs'
import zlib from 'node:zlib'
import readline from 'node:readline'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('Usage: node scripts/ccod-to-tsv.mjs <CCOD_FULL.csv> <out.tsv.gz>')
  process.exit(1)
}

function splitCsv(line) {
  const out = []; let f = '', q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c } else if (c === '"') q = true
    else if (c === ',') { out.push(f); f = '' } else f += c
  }
  out.push(f); return out
}

const normPostcode = (pc) => String(pc || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const clean = (s) => String(s == null ? '' : s).replace(/[\x00-\x1f\u2028\u2029\\]+/g, ' ').replace(/\s+/g, ' ').trim()

const gzip = zlib.createGzip()
const out = fs.createWriteStream(output)
gzip.pipe(out)
for (const [nm, s] of [['gzip', gzip], ['out', out]]) s.on('error', (e) => { console.error(`FATAL ${nm}:`, e.message); process.exit(1) })

const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity })
let header = null, idx = {}, titles = 0, rows = 0
let paused = false
gzip.on('drain', () => { if (paused) { paused = false; rl.resume() } })

rl.on('line', (line) => {
  if (!line) return
  const f = splitCsv(line)
  if (!header) {
    header = f.map((h) => h.trim()); header.forEach((h, i) => (idx[h] = i))
    if (idx['Postcode'] == null || idx['Proprietor Name (1)'] == null) {
      console.error('Unexpected CCOD header — is this the CCOD full CSV?'); process.exit(1)
    }
    return
  }
  if (f.length < header.length - 2) return // footer/short
  const get = (name) => (idx[name] != null ? (f[idx[name]] || '').trim() : '')
  const pc = normPostcode(get('Postcode'))
  if (!pc) return
  titles++
  const title = clean(get('Title Number')), tenure = clean(get('Tenure')), addr = clean(get('Property Address'))
  for (let n = 1; n <= 4; n++) {
    const name = get(`Proprietor Name (${n})`)
    if (!name) continue
    const row = [pc, title, tenure, addr, clean(name), clean(get(`Company Registration No. (${n})`)), clean(get(`Proprietorship Category (${n})`))].join('\t')
    if (!gzip.write(row + '\n') && !paused) { paused = true; rl.pause() }
    rows++
  }
  if (titles % 200000 === 0) console.error(`  …${titles} titles, ${rows} owner rows`)
})

rl.on('close', () => {
  gzip.end(() => console.error(`Done. ${titles} titles, ${rows} owner rows written to ${output}`))
})
