// Local pre-filter (run on the Mac). Streams the CH PSC snapshot .txt (JSON-lines,
// ~12.8GB) and writes a compact gzipped TSV of ONLY the columns ch_psc needs:
//   company_number \t name \t kind \t ceased_on \t natures(comma-joined)
// Cuts ~12.8GB → ~250MB gzip, so it's uploadable to the server, where a COPY
// loads it into Postgres fast.
//
// Usage:
//   node scripts/psc-to-tsv.mjs <input.txt-or-.zip> <output.tsv.gz>
// If given the .zip directly it streams via `unzip -p` (no 12.8GB extraction).

import fs from 'node:fs'
import zlib from 'node:zlib'
import readline from 'node:readline'
import { spawn } from 'node:child_process'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('Usage: node scripts/psc-to-tsv.mjs <input .txt|.zip> <output.tsv.gz>')
  process.exit(1)
}

// Source stream: unzip -p for .zip, else a plain read stream.
let src
if (input.endsWith('.zip')) {
  const u = spawn('unzip', ['-p', input])
  u.stderr.on('data', () => {})
  src = u.stdout
} else {
  src = fs.createReadStream(input)
}

const gzip = zlib.createGzip()
const out = fs.createWriteStream(output)
gzip.pipe(out)

const rl = readline.createInterface({ input: src, crlfDelay: Infinity })

// TSV-safe: strip tabs/newlines from free-text fields.
const clean = (s) => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim()

let n = 0, kept = 0
rl.on('line', (line) => {
  if (!line.trim()) return
  n++
  let j
  try { j = JSON.parse(line) } catch { return }
  const num = j.company_number
  const d = j.data || {}
  if (!num || !d.kind) return
  const row = [
    clean(num),
    clean(d.name),
    clean(d.kind),
    clean(d.ceased_on),
    clean(Array.isArray(d.natures_of_control) ? d.natures_of_control.join(',') : ''),
  ].join('\t')
  if (!gzip.write(row + '\n')) {
    rl.pause()
    gzip.once('drain', () => rl.resume())
  }
  kept++
  if (n % 500000 === 0) console.error(`  …${n} lines, ${kept} kept`)
})

rl.on('close', () => {
  gzip.end(() => console.error(`Done. ${n} lines read, ${kept} rows written to ${output}`))
})
