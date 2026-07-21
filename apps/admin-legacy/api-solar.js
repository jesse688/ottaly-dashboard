// Solar enrichment API for admin-legacy.
//   POST /api/solar/enrich  { contacts:[{id,email,company_name,company_reg,company_domain,address}], options }
//        -> streams NDJSON, one enriched result per line (ownership-first cascade)
//   POST /api/solar/image   { lat, lng }  -> { png: dataURI }   (on-demand, paid)
//   GET  /api/solar/status  -> { ccodIndex, chEnabled, googleKey }
//
// Mounted in server.js via: app.use('/api/solar', require('./api-solar')())
// The PV push lives in server.js (reuses its pvApi/getPvKey helpers).

const express = require('express');
const { enrichContact } = require('./lib/solar/enrich');
const { roofImagePng } = require('./lib/solar/google-solar');
const { indexAvailable } = require('./lib/solar/ccod');
const { chEnabled } = require('./lib/solar/companies-house');

module.exports = function solarAPI() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json({
      ccodIndex: indexAvailable(),
      chEnabled: chEnabled(),
      googleKey: !!(process.env.GOOGLE_SOLAR_API_KEY || process.env.GOOGLE_API_KEY),
    });
  });

  router.post('/enrich', async (req, res) => {
    const { contacts, options = {} } = req.body || {};
    if (!Array.isArray(contacts) || !contacts.length) {
      return res.status(400).json({ error: 'contacts[] required' });
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });

    // Bounded concurrency — 4 at a time. Ownership stage is offline so the real
    // cost/latency is only the Google calls for contacts that pass ownership.
    const CONC = Math.min(Number(options.concurrency) || 4, 8);
    const queue = contacts.map((c, i) => ({ c, i }));
    let cursor = 0;
    async function worker() {
      while (cursor < queue.length) {
        const { c, i } = queue[cursor++];
        let rec;
        try {
          rec = await enrichContact(c, options);
        } catch (e) {
          rec = { status: 'disqualified', stage: 'error', stop_reason: 'error', error: e.message, email: c.email, company_name: c.company_name };
        }
        rec.index = i;
        const { raw, ...lean } = rec; // keep the heavy raw off the wire
        res.write(JSON.stringify(lean) + '\n');
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, worker));
    res.end();
  });

  router.post('/image', async (req, res) => {
    const { lat, lng } = req.body || {};
    if (lat == null || lng == null) return res.status(400).json({ error: 'lat/lng required' });
    try {
      const out = await roofImagePng(lat, lng);
      if (out.error) return res.json({ error: out.error });
      res.json({ png: `data:image/png;base64,${out.base64}` });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
