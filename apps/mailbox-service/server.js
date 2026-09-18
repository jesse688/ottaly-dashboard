/**
 * Mailbox service.
 *
 * Mailbox health for the Ottaly estate: what each mailbox has spent, how it is
 * placing, why it bounces, and what to do about it. Runs standalone so a
 * problem here cannot take the admin dashboard with it.
 *
 * Storage is SQLite on a mounted volume (MAILBOX_DB). The data is rebuildable
 * from PlusVibe, but only slowly: cumulative sends are stitched from 90-day
 * windows and a day that falls out of reach before it is banked is gone. So
 * the volume matters — losing it costs history, not just a resync.
 */

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json({ limit: '2mb' }));

// Health. Reports the commit so "is the fix live?" is answerable without
// guessing — a deploy that ships stale code is a known failure mode here.
app.get('/healthz', (req, res) => {
  const store = require('./mailbox/db');
  let mailboxes = null, lastIngest = null;
  try {
    const db = store.open();
    mailboxes = db.prepare('SELECT COUNT(*) c FROM mailbox').get().c;
    lastIngest = db.prepare(
      'SELECT finished_at FROM ingest_run WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1'
    ).get()?.finished_at || null;
    db.close();
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  res.json({
    ok: true,
    service: 'mailbox-service',
    sha: process.env.GIT_SHA || 'unset',
    mailboxes,
    last_ingest: lastIngest,
    now: new Date().toISOString(),
  });
});

app.use('/api/mailbox', require('./mailbox/routes'));

app.get('/', (req, res) => res.redirect('/mailboxes'));
app.get('/mailboxes', (req, res) =>
  res.sendFile(path.join(__dirname, 'mailbox-dashboard.html')));

app.listen(PORT, () => {
  console.log(`mailbox-service on :${PORT} (sha ${process.env.GIT_SHA || 'unset'})`);
});
