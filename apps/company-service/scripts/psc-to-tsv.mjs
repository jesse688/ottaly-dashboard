// Pre-filter the CH PSC snapshot (JSON-lines, ~12.8GB) into a compact gzipped TSV
// of ONLY the columns ch_psc needs:
//   company_number \t name \t kind \t ceased_on \t natures(comma-joined)
// Cuts ~12.8GB → ~270MB gzip. Run on the Mac or in the container.
//
// Usage:
//   node scripts/psc-to-tsv.mjs <input.txt|.zip> <output.tsv.gz>
// A .zip input is streamed via `unzip -p` (no full extraction).

import fs from 'node:fs'
import zlib from 'node:zlib'
import readline from 'node:readline'
import { spawn } from 'node:child_process'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('Usage: node scripts/psc-to-tsv.mjs <input .txt|.zip> <output.tsv.gz>')
  process.exit(1)
}

let src
if (input.endsWith('.zip')) {
  const child = spawn('unzip', ['-p', input])
  child.stderr.on('data', () => {})
  child.on('error', (e) => { console.error('FATAL unzip:', e.message); process.exit(1) })
  src = child.stdout
} else {
  src = fs.createReadStream(input)
}

const gzip = zlib.createGzip()
const out = fs.createWriteStream(output)
gzip.pipe(out)
for (const [name, s] of [['src', src], ['gzip', gzip], ['out', out]]) {
  s.on('error', (e) => { console.error(`FATAL ${name} stream:`, e.message); process.exit(1) })
}

const rl = readline.createInterface({ input: src, crlfDelay: Infinity })

// Field sanitiser. Strips control chars, unicode line/paragraph separators
// (U+2028 / U+2029) and backslashes, all of which corrupt COPY's text format:
// an embedded newline splits one row into two ("missing data for column") and
// backslash is COPY's escape char. Every field ends up single-line and tab-free,
// so each emitted row has exactly 5 tab-separated columns.
const clean = (s) => String(s == null ? '' : s)
  .replace(/[\x00-\x1f\u2028\u2029\\]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

// Single reusable backpressure handler (a per-line .once('drain') piled up
// thousands of listeners on the slower container disk and thrashed to a halt).
let paused = false
gzip.on('drain', () => { if (paused) { paused = false; rl.resume() } })

let n = 0, kept = 0
rl.on('line', (line) => {
  if (!line) return
  n++
  let j
  try { j = JSON.parse(line) } catch { return }
  const num = j.company_number
  const d = j.data || {}
  if (num && d.kind) {
    const row = [
      clean(num), clean(d.name), clean(d.kind), clean(d.ceased_on),
      clean(Array.isArray(d.natures_of_control) ? d.natures_of_control.join(',') : ''),
    ].join('\t')
    if (!gzip.write(row + '\n') && !paused) { paused = true; rl.pause() }
    kept++
  }
  if (n % 500000 === 0) console.error(`  …${n} lines, ${kept} kept`)
})

rl.on('close', () => {
  gzip.end(() => console.error(`Done. ${n} lines read, ${kept} rows written to ${output}`))
})
