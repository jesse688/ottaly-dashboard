'use strict';
// Import CH Persons with Significant Control (PSC) bulk snapshot into ch_directors.
// Usage: node scripts/import-psc-bulk.js /path/to/persons-with-significant-control-snapshot-*.txt
// The file is newline-delimited JSON — one record per line, shape:
//   { "company_number": "...", "data": { "kind": "...", "name_elements": {...}, ... } }
// Only kind === "individual-person-with-significant-control" is imported.
// Joins to ch_companies on company_number — records with no matching company are skipped.

const readline = require('readline');
const fs = require('fs');
const { Client } = require('pg');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/import-psc-bulk.js <path>'); process.exit(1); }
if (!fs.existsSync(file)) { console.error('File not found:', file); process.exit(1); }

function formatName(ne) {
  if (!ne) return null;
  return [ne.forename, ne.middle_name, ne.surname].filter(Boolean).join(' ').trim() || null;
}

// --skip-existing: skip companies that already have a PSC in ch_directors.
// Massively faster on a resume — no upsert churn on already-imported rows.
const skipExisting = process.argv.includes('--skip-existing');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('[psc-import] Loading known company numbers…');
  const { rows } = await client.query('SELECT company_number FROM ch_companies');
  const known = new Set(rows.map(r => r.company_number));
  console.log(`[psc-import] ${known.size.toLocaleString()} companies in DB`);

  let already = new Set();
  if (skipExisting) {
    console.log('[psc-import] --skip-existing: loading companies that already have a PSC…');
    const { rows: er } = await client.query('SELECT DISTINCT company_number FROM ch_directors');
    already = new Set(er.map(r => r.company_number));
    console.log(`[psc-import] ${already.size.toLocaleString()} companies already have an owner — will skip`);
  }

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let batch = [], total = 0, imported = 0, skipped_kind = 0, skipped_co = 0, skipped_name = 0;

  const flush = async () => {
    if (!batch.length) return;
    // Dedup within batch — two PSCs with the same (cn,name,role) in one INSERT
    // trips "ON CONFLICT DO UPDATE cannot affect row a second time".
    const seen = new Set();
    batch = batch.filter(r => { const k = r.cn + '|' + r.name + '|' + r.role; if (seen.has(k)) return false; seen.add(k); return true; });
    if (!batch.length) return;
    const vals = [];
    const ph = batch.map((r, i) => { const b = i * 6; vals.push(r.cn, r.name, r.role, r.appointed, r.addr, r.dob); return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5}::jsonb,$${b+6})`; });
    await client.query(`INSERT INTO ch_directors (company_number,name,role,appointed_on,address,dob_year_month) VALUES ${ph.join(',')} ON CONFLICT (company_number,name,role) DO UPDATE SET appointed_on=EXCLUDED.appointed_on,address=EXCLUDED.address,dob_year_month=EXCLUDED.dob_year_month`, vals)
      .catch(e => console.warn('[psc-import] batch err:', e.message));
    imported += batch.length;
    batch = [];
  };

  for await (const line of rl) {
    const t = line.trim();
    if (!t || t === '[' || t === ']') continue;
    total++;
    let outer;
    try { outer = JSON.parse(t.endsWith(',') ? t.slice(0, -1) : t); } catch { continue; }
    const cn = outer.company_number;
    const rec = outer.data || outer;
    if (rec.kind !== 'individual-person-with-significant-control') { skipped_kind++; continue; }
    if (!cn || !known.has(cn)) { skipped_co++; continue; }
    if (skipExisting && already.has(cn)) { skipped_co++; continue; }
    const name = formatName(rec.name_elements) || rec.name;
    if (!name) { skipped_name++; continue; }
    const dob = rec.date_of_birth ? `${rec.date_of_birth.year}-${String(rec.date_of_birth.month).padStart(2, '0')}` : null;
    batch.push({ cn, name, role: 'psc', appointed: rec.notified_on || null, addr: rec.address ? JSON.stringify(rec.address) : null, dob });
    if (total % 10000 === 0) console.log(`[progress] ${total.toLocaleString()} | imported ${imported.toLocaleString()} | skipped_kind ${skipped_kind.toLocaleString()}`);
    if (batch.length >= 500) await flush();
  }
  await flush();
  await client.end();
  console.log(`\nDone. Total: ${total.toLocaleString()} | Imported: ${imported.toLocaleString()} | Skipped kind: ${skipped_kind.toLocaleString()} | No company: ${skipped_co.toLocaleString()} | No name: ${skipped_name.toLocaleString()}`);
}

main().catch(e => { console.error(e); process.exit(1); });
