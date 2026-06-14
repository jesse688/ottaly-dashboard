#!/usr/bin/env node
'use strict'

/**
 * Lists every inbound HTTP route and every outbound Bison call in server.js.
 * Keeps ENDPOINTS.md honest — run after adding/removing endpoints:
 *
 *   node scripts/list-endpoints.js            # print to stdout
 *   node scripts/list-endpoints.js --md       # markdown tables
 *
 * Pure static scan (regex over source) — does not require a DB or boot.
 */

const fs = require('fs')
const path = require('path')

const SERVER = path.resolve(__dirname, '../server.js')
const src = fs.readFileSync(SERVER, 'utf8')
const lines = src.split('\n')

const md = process.argv.includes('--md')

// Inbound routes: app.get/post/put/delete('<path>', ...guards...)
const routeRe = /app\.(get|post|put|delete)\(\s*['"`]([^'"`]+)['"`]/
const guardRe = /,\s*(requireAdmin|requireSession|requireAuth)\b/
const routes = []
lines.forEach((line, i) => {
  const m = line.match(routeRe)
  if (!m) return
  const guard = (line.match(guardRe) || [])[1] || '—'
  routes.push({ method: m[1].toUpperCase(), path: m[2], guard, line: i + 1 })
})

// Outbound Bison calls: bisonReq/bisonFetch('<path>' ...)
const bisonRe = /bison(?:Req|Fetch)\(\s*['"`](\/api\/[^'"`]+)['"`]/
const bison = new Map()
lines.forEach((line, i) => {
  const m = line.match(bisonRe)
  if (!m) return
  const p = m[1].replace(/\$\{[^}]+\}/g, ':id') // normalise template ids
  if (!bison.has(p)) bison.set(p, [])
  bison.get(p).push(i + 1)
})

if (md) {
  console.log('### Inbound routes\n')
  console.log('| Method | Path | Guard | server.js |')
  console.log('|---|---|---|---|')
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    .forEach(r => console.log(`| ${r.method} | \`${r.path}\` | ${r.guard} | ${r.line} |`))
  console.log(`\n_${routes.length} routes._\n`)
  console.log('### Outbound Bison endpoints\n')
  console.log('| Bison path | call sites (lines) |')
  console.log('|---|---|')
  ;[...bison.keys()].sort().forEach(p => console.log(`| \`${p}\` | ${bison.get(p).join(', ')} |`))
} else {
  console.log(`\n=== INBOUND ROUTES (${routes.length}) ===`)
  routes.sort((a, b) => a.path.localeCompare(b.path))
    .forEach(r => console.log(`${r.method.padEnd(6)} ${r.path.padEnd(48)} ${r.guard.padEnd(15)} :${r.line}`))
  console.log(`\n=== OUTBOUND BISON ENDPOINTS (${bison.size}) ===`)
  ;[...bison.keys()].sort().forEach(p => console.log(`${p.padEnd(50)} lines ${bison.get(p).join(', ')}`))
}
