/**
 * Re-run classification over stored bounces.
 *
 * The raw bounce text is kept precisely so a rule change can be applied to
 * history rather than only to new data. Safe to run repeatedly.
 *
 * Usage: node mailbox/bounce-reclassify.js
 */
const store = require('./db');
const { classify, statusCode } = require('./bounce');

function reclassify(db, { log = console.error } = {}) {
  const rows = db.prepare(`SELECT lead_id, bounce_msg FROM bounce_event`).all();
  const up = db.prepare(`UPDATE bounce_event SET cause=?, action=?, status_code=? WHERE lead_id=?`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const c = classify(r.bounce_msg);
      up.run(c.key, c.action, statusCode(r.bounce_msg), r.lead_id);
    }
  });
  tx();
  const unknown = db.prepare(`SELECT COUNT(*) c FROM bounce_event WHERE cause='unknown'`).get().c;
  log(`reclassified ${rows.length}, ${unknown} unclassified `
    + `(${Math.round((rows.length - unknown) / Math.max(1, rows.length) * 100)}% coverage)`);
  return { total: rows.length, unknown };
}

if (require.main === module) {
  const db = store.open();
  try { console.log(JSON.stringify(reclassify(db))); } finally { db.close(); }
}

module.exports = { reclassify };
