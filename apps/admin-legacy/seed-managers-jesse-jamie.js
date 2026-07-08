#!/usr/bin/env node
// One-off, idempotent seed: add Jesse and Jamie as campaign managers with 0% commission
// and NO login password (commission-tracking placeholders, not login accounts).
//
// Run on the live host from apps/admin-legacy (same dir the server runs in so DB_PATH resolves):
//   DB_PATH=/path/to/ottaly.db node seed-managers-jesse-jamie.js
//
// password_hash is stored as '' — the column is NOT NULL so it can't be NULL, and an
// empty hash can never match (manager login also rejects an empty password field), so
// these accounts are unusable for login by design. Give them a password later via
// Admin Settings → Managers if they ever need to sign in.
//
// Safe to re-run: existing rows are left untouched except commission_rate, which is
// forced to 0. It never modifies client_managers, so existing commission history and
// CM performance numbers are completely unaffected.

const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || 'ottaly.db';
const db = new Database(DB_PATH);

const people = ['Jesse', 'Jamie'];

const findByName     = db.prepare('SELECT id, name, commission_rate FROM managers WHERE name = ?');
const insertMgr      = db.prepare("INSERT INTO managers (name, password_hash, commission_rate) VALUES (?, '', 0)");
const zeroCommByName = db.prepare('UPDATE managers SET commission_rate = 0 WHERE name = ?');

for (const name of people) {
  const existing = findByName.get(name);
  if (existing) {
    if (existing.commission_rate !== 0) {
      zeroCommByName.run(name);
      console.log(`↺ ${name} already exists — commission set to 0 (was ${existing.commission_rate})`);
    } else {
      console.log(`= ${name} already exists with commission 0 — no change`);
    }
    continue;
  }
  insertMgr.run(name);
  console.log(`+ Added ${name} (commission 0, no login password)`);
}

console.log('\nManagers now:');
for (const m of db.prepare('SELECT name, commission_rate FROM managers ORDER BY name').all()) {
  console.log(`  ${m.name.padEnd(10)} commission_rate=${m.commission_rate}`);
}

db.close();
