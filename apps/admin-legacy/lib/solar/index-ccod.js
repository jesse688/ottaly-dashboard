#!/usr/bin/env node
// Build the CCOD ownership index (postcode-keyed SQLite) from HM Land Registry's
// "UK companies that own property in England and Wales" full CSV.
//
// Run on the SERVER (or locally) whenever a fresh monthly CCOD file is downloaded:
//   node lib/solar/index-ccod.js /path/to/CCOD_FULL_YYYY_MM.csv [output.db]
//
// Default output = $CCOD_INDEX or lib/solar/ccod-index.db (point CCOD_INDEX at the
// persistent volume in production so the index survives redeploys).
//
// Adapts to better-sqlite3 (production Docker) or node:sqlite (local Node 22+).

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { normPostcode } = require('./address-match');

// --- adaptive SQLite writer (matches ccod.js reader strategy) ---
function openWritable(dbPath) {
  try {
    const Database = require('better-sqlite3');
    const raw = new Database(dbPath);
    return {
      exec: (s) => raw.exec(s),
      prepare: (s) => raw.prepare(s),
      close: () => raw.close(),
    };
  } catch (e) { /* fall back */ }
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  return { exec: (s) => raw.exec(s), prepare: (s) => raw.prepare(s), close: () => raw.close() };
}

function splitCsvLine(line) {
  const out = []; let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(f); f = ''; }
    else f += c;
  }
  out.push(f);
  return out;
}

async function main() {
  const src = process.argv[2];
  const dbPath = process.argv[3] || process.env.CCOD_INDEX || path.join(__dirname, 'ccod-index.db');
  if (!src || !fs.existsSync(src)) {
    console.error('Usage: node lib/solar/index-ccod.js <CCOD_FULL.csv> [output.db]');
    console.error('Download (free, after registering): https://use-land-property-data.service.gov.uk/datasets/ccod');
    process.exit(1);
  }

  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = openWritable(dbPath);
  db.exec(`
    PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
    CREATE TABLE owners (
      postcode TEXT, title_number TEXT, tenure TEXT, property_address TEXT, price_paid TEXT,
      proprietor_name TEXT, company_reg_no TEXT, proprietor_category TEXT,
      proprietor_address TEXT, date_added TEXT
    );
  `);
  const insert = db.prepare(`INSERT INTO owners
    (postcode,title_number,tenure,property_address,price_paid,proprietor_name,company_reg_no,proprietor_category,proprietor_address,date_added)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  const rl = readline.createInterface({ input: fs.createReadStream(src), crlfDelay: Infinity });
  let header = null, idx = {}, titles = 0, ownerRows = 0, skippedNoPc = 0;

  db.exec('BEGIN');
  for await (const line of rl) {
    if (!line.trim()) continue;
    const fields = splitCsvLine(line);
    if (!header) {
      header = fields.map((h) => h.trim());
      header.forEach((h, i) => (idx[h] = i));
      if (idx['Postcode'] == null || idx['Proprietor Name (1)'] == null) {
        console.error('Unexpected CCOD header — is this the CCOD full file?');
        process.exit(1);
      }
      continue;
    }
    if (fields.length < header.length - 2) continue; // footer / short rows
    const get = (name) => (idx[name] != null ? (fields[idx[name]] || '').trim() : '');
    const pc = normPostcode(get('Postcode'));
    if (!pc) { skippedNoPc++; continue; }
    titles++;
    const title = get('Title Number'), tenure = get('Tenure'), addr = get('Property Address'),
          price = get('Price Paid'), date = get('Date Proprietor Added');
    for (let n = 1; n <= 4; n++) {
      const name = get(`Proprietor Name (${n})`);
      if (!name) continue;
      const propAddr = [1, 2, 3].map((k) => get(`Proprietor (${n}) Address (${k})`)).filter(Boolean).join(', ');
      insert.run(pc, title, tenure, addr, price, name, get(`Company Registration No. (${n})`), get(`Proprietorship Category (${n})`), propAddr, date);
      ownerRows++;
    }
    if (titles % 200000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); process.stdout.write(`\r  indexed ${titles.toLocaleString()} titles…`); }
  }
  db.exec('COMMIT');
  process.stdout.write(`\r  indexed ${titles.toLocaleString()} titles           \n`);
  console.log('Creating postcode index…');
  db.exec('CREATE INDEX idx_pc ON owners(postcode)');
  const total = db.prepare('SELECT COUNT(*) c FROM owners').get().c;
  db.close();
  console.log(`\nDone. ${total.toLocaleString()} owner rows · ${skippedNoPc.toLocaleString()} titles skipped (no postcode)`);
  console.log(`Index: ${dbPath}`);
}

main().catch((e) => { console.error('\nIndex failed:', e.message); process.exit(1); });
