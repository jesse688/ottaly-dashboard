// CCOD ownership lookup for admin-legacy (better-sqlite3, read-only).
// Index built by lib/solar/index-ccod.js. Degrades to "no index" gracefully.

const fs = require('fs');
const path = require('path');
const { normPostcode, addressSimilarity, confidenceLabel } = require('./address-match');

const DB_PATH = process.env.CCOD_INDEX || path.join(__dirname, 'ccod-index.db');

// SQLite reader that works in BOTH environments:
//  - Production Docker (node:20-alpine, has python3/make/g++): better-sqlite3 compiles.
//  - Local dev on Node 22+/24: node:sqlite built-in (no native build needed).
// Try better-sqlite3 first (prod), fall back to node:sqlite (local). A small
// adapter normalises both to a .prepare(sql).all(...args) interface.
let _db = null, _tried = false;
function getDb() {
  if (_tried) return _db;
  _tried = true;
  if (!fs.existsSync(DB_PATH)) return null;

  // 1) better-sqlite3 (production)
  try {
    const Database = require('better-sqlite3');
    const raw = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    _db = { prepare: (sql) => raw.prepare(sql) }; // better-sqlite3 stmt.all(...args) matches
    return _db;
  } catch (e) { /* try the built-in next */ }

  // 2) node:sqlite (local dev, Node 22+)
  try {
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(DB_PATH, { readOnly: true });
    _db = { prepare: (sql) => { const st = raw.prepare(sql); return { all: (...a) => st.all(...a) }; } };
    return _db;
  } catch (e) { _db = null; }

  return _db;
}

function indexAvailable() { return !!getDb(); }

function lookupOwner(address, postcode) {
  const db = getDb();
  if (!db) return { available: false, owners: [], best: null };
  const pc = normPostcode(postcode);
  if (!pc) return { available: true, owners: [], best: null };

  const rows = db.prepare(
    `SELECT proprietor_name AS name, company_reg_no, proprietor_category AS category,
            proprietor_address, property_address, title_number, tenure, price_paid, date_added
     FROM owners WHERE postcode = ?`
  ).all(pc);
  if (!rows.length) return { available: true, owners: [], best: null };

  const single = rows.length === 1;
  const scored = rows.map((r) => {
    const similarity = addressSimilarity(address, r.property_address);
    return { ...r, similarity, confidence: confidenceLabel(similarity, single) };
  }).sort((a, b) => b.similarity - a.similarity);

  return { available: true, owners: scored, best: scored[0] };
}

module.exports = { lookupOwner, indexAvailable, DB_PATH };
