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
const usage = require('./lib/solar/usage');

module.exports = function solarAPI() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const s = usage.maskedSettings();
    res.json({
      ccodIndex: indexAvailable(),
      chEnabled: chEnabled(),
      googleKey: s.googleKeySet,
      usage: usage.summary(),
    });
  });

  // Current-month Google usage vs free-tier limits.
  router.get('/usage', (req, res) => res.json(usage.summary()));

  // Settings: view masked keys / save (rotate) keys without a redeploy.
  router.get('/settings', (req, res) => res.json(usage.maskedSettings()));
  router.post('/settings', (req, res) => {
    const { googleKey, chKey } = req.body || {};
    // Only overwrite a key when a non-empty value is provided (blank = leave as-is).
    const patch = {};
    if (typeof googleKey === 'string' && googleKey.trim()) patch.googleKey = googleKey.trim();
    if (typeof chKey === 'string' && chKey.trim()) patch.chKey = chKey.trim();
    usage.setKeys(patch);
    res.json({ ok: true, ...usage.maskedSettings() });
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

  // Diagnostic: geocode any address and show exactly where it lands + precision.
  // Lets us verify "Hercules House, Merlin Quay…" resolves to the right building
  // vs the postcode centroid. ?address=... (&precise=1 to use building-level path).
  router.get('/geocode-test', async (req, res) => {
    const { geocode, geocodePrecise, geocodeGoogleRaw, geocodePlacesRaw } = require('./lib/solar/geocode');
    const address = (req.query.address || '').toString();
    if (!address) return res.status(400).json({ error: 'address required' });
    try {
      const plain = await geocode(address);
      const precise = await geocodePrecise(address);
      res.json({ address, plain, precise });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Compare cheap Geocoding ($5/1k) across several cleaned address formats vs
  // Places ($32/1k) — to find the cheapest that lands on the right building.
  router.get('/geocode-compare', async (req, res) => {
    const g = require('./lib/solar/geocode');
    const address = (req.query.address || '').toString();
    if (!address) return res.status(400).json({ error: 'address required' });
    const out = {};
    try {
      // Several cleaned variants through the CHEAP Geocoding API.
      const variants = [
        address,
        address.replace(/\(([^)]+)\)/, '$1'),                 // unwrap "(SO19 7GB)"
        address.split(',').slice(1).join(',').trim(),         // drop the building name (1st part)
        address.split(',').slice(1, -1).join(',').trim() + ', ' + (g.extractPostcode(address) || ''), // middle + postcode
      ];
      out.geocoding = [];
      for (const v of [...new Set(variants)]) {
        const r = await g.geocodeGoogleRaw ? await g.geocodeGoogleRaw(v) : null;
        out.geocoding.push({ query: v, result: r });
      }
      out.places = g.geocodePlacesRaw ? await g.geocodePlacesRaw(address) : null;
    } catch (e) { out.error = e.message; }
    res.json(out);
  });

  return router;
};
