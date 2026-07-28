// Find the LEAD company's OWN other sites in CCOD — i.e. other postcodes where
// the *same operating company* is the registered proprietor. This is NOT the
// building owner's portfolio (which is often a landlord/diocese with 100s of
// unrelated properties); it's the company we're emailing owning multiple premises.
//
// Match strategy, precise on purpose (no landlord noise):
//   - reg number (exact, normalised) when we have one, else
//   - a strong normalised-name equality on the proprietor.

const fs = require('fs');
const path = require('path');
const { normRegNo, normName } = require('./company-match');

const DB_PATH = process.env.CCOD_INDEX || path.join(__dirname, 'ccod-index.db');
let _db = null, _tried = false;
function getDb() {
  if (_tried) return _db;
  _tried = true;
  if (!fs.existsSync(DB_PATH)) return null;
  try { const D = require('better-sqlite3'); _db = wrap(new D(DB_PATH, { readonly: true, fileMustExist: true })); return _db; } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); _db = wrap(new DatabaseSync(DB_PATH, { readOnly: true })); } catch { _db = null; }
  return _db;
}
function wrap(raw) { return { all: (sql, ...a) => { const st = raw.prepare(sql); return st.all(...a); } }; }

// Returns [{ postcode, property_address }] for the company's own sites.
// lead = { name, reg } — reg is the CH-resolved reg if we have it.
function findOwnSites(lead) {
  const db = getDb();
  if (!db || (!lead.name && !lead.reg)) return [];

  let rows = [];
  const reg = normRegNo(lead.reg);
  if (reg) {
    // Match on reg number regardless of stored formatting/leading zeros. Narrow the
    // scan with a LIKE on the significant digits (distinctive), THEN exact-normalise
    // in JS — same correctness as before but WITHOUT pulling every reg-bearing row
    // into JS. The old `WHERE company_reg_no != ''` full pull materialised millions
    // of rows from the 2.8M-row CCOD index PER contact (~90s each) and, once every
    // owner carried a CH reg, dominated the whole Solar run.
    const digits = reg.replace(/^[A-Z]+/, '').replace(/^0+/, '') || reg.replace(/^[A-Z]+/, '');
    if (digits) {
      const cand = db.all(
        `SELECT DISTINCT postcode, property_address, proprietor_name, company_reg_no
         FROM owners WHERE company_reg_no LIKE ?`, `%${digits}%`
      );
      rows = cand.filter((r) => normRegNo(r.company_reg_no) === reg);
    }
  }

  // If no reg (or no reg hits), fall back to strong name equality — but only
  // when the name is distinctive enough to avoid matching generic words.
  if (!rows.length && lead.name) {
    const target = normName(lead.name);
    if (target && target.split(' ').length >= 2) {
      // Narrow the scan with a LIKE on the first meaningful token, then exact-normalise.
      const firstTok = target.split(' ')[0];
      const cand = db.all(
        `SELECT DISTINCT postcode, property_address, proprietor_name, company_reg_no
         FROM owners WHERE proprietor_name LIKE ?`, `%${firstTok}%`
      );
      rows = cand.filter((r) => normName(r.proprietor_name) === target);
    }
  }

  // Dedupe by postcode+address, return a clean site list.
  const seen = new Set();
  const sites = [];
  for (const r of rows) {
    const key = `${r.postcode}|${(r.property_address || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sites.push({ postcode: r.postcode, property_address: r.property_address || '' });
  }
  return sites;
}

module.exports = { findOwnSites };
