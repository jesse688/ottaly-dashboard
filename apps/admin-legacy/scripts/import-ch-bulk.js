'use strict';
const readline = require('readline');
const fs = require('fs');
const { Client } = require('pg');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/import-ch-bulk.js <path-to-csv>'); process.exit(1); }
if (!fs.existsSync(file)) { console.error('File not found:', file); process.exit(1); }

function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  fields.push(cur);
  return fields;
}

function extractSic(raw) {
  if (!raw || !raw.trim()) return null;
  const m = raw.trim().match(/^(\d+)/);
  return m ? m[1] : null;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

  let headers = null;
  let batch = [];
  let total = 0, imported = 0, skipped = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const vals = [];
    const placeholders = batch.map((row, i) => {
      const base = i * 12;
      vals.push(
        row.company_number, row.company_name, row.company_status, row.company_type,
        row.sic_codes, row.postcode, row.address_line1, row.address_line2,
        row.post_town, row.county, row.country_of_origin, row.incorporated_on
      );
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},NOW())`;
    });
    await client.query(`
      INSERT INTO ch_companies
        (company_number,company_name,company_status,company_type,sic_codes,postcode,address_line1,address_line2,post_town,county,country_of_origin,incorporated_on,updated_at)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (company_number) DO UPDATE SET
        company_name=EXCLUDED.company_name,
        company_status=EXCLUDED.company_status,
        company_type=EXCLUDED.company_type,
        sic_codes=EXCLUDED.sic_codes,
        postcode=EXCLUDED.postcode,
        address_line1=EXCLUDED.address_line1,
        address_line2=EXCLUDED.address_line2,
        post_town=EXCLUDED.post_town,
        county=EXCLUDED.county,
        country_of_origin=EXCLUDED.country_of_origin,
        incorporated_on=EXCLUDED.incorporated_on,
        updated_at=NOW()
    `, vals);
    imported += batch.length;
    batch = [];
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (!headers) {
      headers = fields.map(h => h.trim());
      continue;
    }
    total++;
    const get = (col) => { const i = headers.indexOf(col); return i >= 0 ? (fields[i] || '').trim() : ''; };

    const status = get('CompanyStatus');
    if (status !== 'Active') { skipped++; if (total % 10000 === 0) console.log(`[progress] ${total} rows | imported ${imported} | skipped ${skipped}`); continue; }

    const sics = [get('SICCode.SicText_1'), get('SICCode.SicText_2'), get('SICCode.SicText_3'), get('SICCode.SicText_4')]
      .map(extractSic).filter(Boolean).join(',');

    batch.push({
      company_number: get('CompanyNumber'),
      company_name: get('CompanyName'),
      company_status: status,
      company_type: get('CompanyCategory'),
      sic_codes: sics || null,
      postcode: get('RegAddress.PostCode') || null,
      address_line1: get('RegAddress.AddressLine1') || null,
      address_line2: get('RegAddress.AddressLine2') || null,
      post_town: get('RegAddress.PostTown') || null,
      county: get('RegAddress.County') || null,
      country_of_origin: get('CountryOfOrigin') || null,
      incorporated_on: get('IncorporationDate') || null,
    });

    if (total % 10000 === 0) console.log(`[progress] ${total} rows | imported ${imported} | skipped ${skipped}`);
    if (batch.length >= 500) await flush();
  }

  await flush();
  await client.end();
  console.log(`\nDone. Total: ${total} | Imported: ${imported} | Skipped: ${skipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
