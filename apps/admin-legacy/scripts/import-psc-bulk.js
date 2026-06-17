'use strict';
// Import CH Persons with Significant Control (PSC) bulk snapshot into ch_directors.
// Usage: node scripts/import-psc-bulk.js /path/to/persons-with-significant-control-snapshot-*.json
// The file is newline-delimited JSON — one record per line.
// Records with kind = "individual-person-with-significant-control" are imported.
// Joins to ch_companies on company_number — records with no matching company are skipped.

const readline = require('readline');
const fs = require('fs');
const { Client } = require('pg');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/import-psc-bulk.js <path-to-json>'); process.exit(1); }
if (!fs.existsSync(file)) { console.error('File not found:', file); process.exit(1); }

function extractCompanyNumber(data) {
  // company_number field, or parse from company_uri e.g. /company/12345678/persons-with-significant-control/...
  if (data.company_number) return data.company_number;
  const uri = data.links && (data.links.self || '');
  const m = uri.match(/\/company\/([A-Z0-9]{6,8})\//i);
  return m ? m[1] : null;
}

function formatName(nameElements) {
  if (!nameElements) return null;
  const { forename, other_forenames, surname } = nameElements;
  const parts = [forename, other_forenames, surname].filter(Boolean);
  return parts.join(' ').trim() || null;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Build a set of known company numbers for fast dedup check
  console.log('[psc-import] Loading known company numbers…');
  const { rows: knownRows } = await client.query('SELECT company_number FROM ch_companies');
  const knownCompanies = new Set(knownRows.map(r => r.company_number));
  console.log(`[psc-import] ${knownCompanies.size.toLocaleString()} companies in DB`);

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

  let batch = [];
  let total = 0, imported = 0, skipped_kind = 0, skipped_no_company = 0, skipped_no_name = 0;

  const flush = async () => {
    if (!batch.length) return;
    const vals = [];
    const placeholders = batch.map((row, i) => {
      const b = i * 6;
      vals.push(row.company_number, row.name, row.role, row.appointed_on, row.address, row.dob);
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5}::jsonb,$${b+6})`;
    });
    await client.query(`
      INSERT INTO ch_directors (company_number, name, role, appointed_on, address, dob_year_month)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (company_number, name, role) DO UPDATE SET
        appointed_on = EXCLUDED.appointed_on,
        address = EXCLUDED.address,
        dob_year_month = EXCLUDED.dob_year_month
    `, vals).catch(e => console.warn('[psc-import] batch insert error:', e.message));
    imported += batch.length;
    batch = [];
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '[' || trimmed === ']') continue;
    // Strip trailing comma if present (some exports wrap in array)
    const jsonStr = trimmed.replace(/,$/, '');
    total++;

    let outer;
    try { outer = JSON.parse(jsonStr); } catch { continue; }

    // Format: { company_number, data: { kind, name, name_elements, ... } }
    const companyNumber = outer.company_number;
    const rec = outer.data || outer;

    // Only import individual PSCs (not corporate entities)
    if (rec.kind !== 'individual-person-with-significant-control') { skipped_kind++; continue; }

    if (!companyNumber || !knownCompanies.has(companyNumber)) { skipped_no_company++; continue; }

    const name = formatName(rec.name_elements) || rec.name;
    if (!name) { skipped_no_name++; continue; }

    const addr = rec.address ? JSON.stringify(rec.address) : null;
    const dob = rec.date_of_birth ? `${rec.date_of_birth.year}-${String(rec.date_of_birth.month).padStart(2,'0')}` : null;
    const appointed = rec.notified_on || null;
    const natures = (rec.natures_of_control || []).join(', ');

    batch.push({
      company_number: companyNumber,
      name,
      role: 'psc' + (natures ? ` (${natures.slice(0, 80)})` : ''),
      appointed_on: appointed,
      address: addr,
      dob: dob,
    });

    if (total % 10000 === 0) console.log(`[progress] ${total.toLocaleString()} lines | imported ${imported.toLocaleString()} | skipped_kind ${skipped_kind.toLocaleString()} | no_company ${skipped_no_company.toLocaleString()}`);
    if (batch.length >= 500) await flush();
  }

  await flush();
  await client.end();
  console.log(`\nDone.`);
  console.log(`  Total lines:       ${total.toLocaleString()}`);
  console.log(`  Imported:          ${imported.toLocaleString()}`);
  console.log(`  Skipped (not individual): ${skipped_kind.toLocaleString()}`);
  console.log(`  Skipped (company not in DB): ${skipped_no_company.toLocaleString()}`);
  console.log(`  Skipped (no name): ${skipped_no_name.toLocaleString()}`);
}

main().catch(e => { console.error(e); process.exit(1); });
