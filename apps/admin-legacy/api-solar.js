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

  // ── Server-side qualification JOB ────────────────────────────────────────
  // Runs the cascade in the SERVER process (survives page refresh/close) and
  // persists each result to solar_*. The page just starts it and polls status;
  // a refresh reconnects to the running job. Singleton — one job at a time.
  const job = { running:false, total:0, done:0, qualified:0, tenants:0, roof_small:0, already_solar:0, errors:0, started_at:null, finished_at:null, error:null };
  let jobStop = false;

  function mapForEnrich(c){
    return {
      id:c.id, email:c.email, first_name:c.first_name, last_name:c.last_name,
      company_name:c.company_name||c.organization_name||'',
      company_domain:c.company_domain||c.website||'',
      company_reg:c.ch_company_number||c.company_reg||'',
      company_address:c.company_address||[c.company_city,c.company_county,c.company_town].filter(Boolean).join(', ')||'',
      ccod_owns_building:c.ccod_owns_building, ccod_building_owner:c.ccod_building_owner, ccod_site_count:c.ccod_site_count,
      ch_postcode:c.ch_postcode, phone:c.phone||c.corporate_phone||c.company_phone||'',
      job_title:c.job_title, ch_verified:!!c.ch_verified_at,
    };
  }
  function countResult(status, stop, hasSolar){
    if(status==='qualified') job.qualified++;
    else if(stop==='tenant') job.tenants++;
    else if(String(stop||'').startsWith('roof_too_small')) job.roof_small++;
    else if(stop==='already_has_solar' || hasSolar==='yes') job.already_solar++;
  }
  async function runJob(db, ids, options){
    if(job.running) return;
    Object.assign(job,{running:true,total:ids.length,done:0,qualified:0,tenants:0,roof_small:0,already_solar:0,errors:0,started_at:new Date().toISOString(),finished_at:null,error:null});
    jobStop=false;
    try{
      const force=!!options.force;
      const CONC=Math.min(Number(options.concurrency)||6,10);
      const BATCH=200;
      for(let bi=0; bi<ids.length && !jobStop; bi+=BATCH){
        const slice=ids.slice(bi,bi+BATCH);
        let rows=[]; try{ rows=await db.getContactsById(slice); }catch(e){ job.errors+=slice.length; job.done+=slice.length; continue; }
        let cur=0;
        const worker=async()=>{
          while(cur<rows.length && !jobStop){
            const c=rows[cur++];
            try{
              if(!force && c.solar_checked_at){
                countResult(c.solar_status, c.solar_stop_reason, c.solar_has_solar); // reuse saved
              } else {
                const rec=await enrichContact(mapForEnrich(c), options);
                if(c.id && rec.stage!=='error'){ try{ await db.saveSolarResult(c.id, rec); }catch(e){} }
                countResult(rec.status, rec.stop_reason, rec.has_solar);
              }
            }catch(e){ job.errors++; }
            job.done++;
          }
        };
        await Promise.all(Array.from({length:Math.min(CONC,rows.length)},worker));
      }
    }catch(e){ job.error=e.message; }
    finally{ job.running=false; job.finished_at=new Date().toISOString(); }
  }

  // Start (returns immediately). Body: { ids:[], options:{} }.
  router.post('/enrich-job', (req,res)=>{
    const db=req.app.locals.pgDb;
    if(!db) return res.status(500).json({error:'DB not available'});
    const { ids, options={} } = req.body||{};
    if(!Array.isArray(ids)||!ids.length) return res.status(400).json({error:'ids[] required'});
    if(job.running) return res.json({ ok:true, already_running:true, status:{...job} });
    runJob(db, ids.filter(Boolean), options).catch(e=>console.error('[solar-job]',e.message));
    res.json({ ok:true, started:true, total:ids.length });
  });
  router.get('/enrich-job/status', (req,res)=>res.json({...job}));
  router.post('/enrich-job/stop', (req,res)=>{ jobStop=true; res.json({ ok:true }); });

  // Lean: qualified prospects for a set of ids (small payload → fast refresh).
  router.post('/job-prospects', async (req,res)=>{
    const db=req.app.locals.pgDb;
    const ids=Array.isArray(req.body&&req.body.ids)?req.body.ids.filter(Boolean).slice(0,50000):[];
    if(!db||!ids.length) return res.json({ prospects:[] });
    try{ res.json({ prospects: await db.getSolarProspects(ids) }); }
    catch(e){ res.status(500).json({ error:e.message }); }
  });

  router.get('/status', (req, res) => {
    const s = usage.maskedSettings();
    res.json({
      ccodIndex: indexAvailable(),
      chEnabled: chEnabled(),
      googleKey: s.googleKeySet,
      usage: usage.summary(),
    });
  });

  // Diagnostic for the persistence path: is the DB handle present, does the live
  // instance actually have the save/read methods (i.e. is the new db-postgres
  // deployed), do the solar_* columns exist, and how many rows are saved?
  router.get('/diag', async (req, res) => {
    const db = req.app.locals.pgDb;
    const out = {
      pgDb_present: !!db,
      has_saveSolarResult: !!(db && typeof db.saveSolarResult === 'function'),
      has_getSolarResults: !!(db && typeof db.getSolarResults === 'function'),
      columns: null, checked: null, total: null, error: null,
    };
    try {
      if (db) {
        const cols = await db.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name='contacts' AND column_name LIKE 'solar_%' ORDER BY column_name`);
        out.columns = cols.rows.map((r) => r.column_name);
        if (out.columns.includes('solar_checked_at')) {
          const c = await db.query(
            `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE solar_checked_at IS NOT NULL)::int AS checked FROM contacts`);
          out.total = c.rows[0].total; out.checked = c.rows[0].checked;
        }
      }
    } catch (e) { out.error = e.message; }
    res.json(out);
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

  // Rebuild a result record from a persisted solar row so a cached contact renders
  // identically to a freshly-enriched one (no Google calls spent).
  function cachedRec(row) {
    return {
      status: row.solar_status,
      stage: row.solar_status === 'qualified' ? 'done' : 'ownership',
      stop_reason: row.solar_stop_reason,
      owns_building: row.ccod_owns_building,          // engine stamp — still current
      owns_basis: 'engine_stamp',
      building_owner: row.ccod_building_owner,
      site_count: row.ccod_site_count,
      max_system_kwp: row.solar_max_kwp,
      max_panels_fit: row.solar_panels,
      est_annual_kwh: row.solar_annual_kwh,
      roof_area_m2: row.solar_roof_area_m2,
      has_solar: row.solar_has_solar,
      lat: row.solar_lat, lng: row.solar_lng,
      roof_address_used: row.solar_roof_address,
      maps_url: row.solar_maps_url,
      cached: true,
    };
  }

  router.post('/enrich', async (req, res) => {
    const { contacts, options = {} } = req.body || {};
    if (!Array.isArray(contacts) || !contacts.length) {
      return res.status(400).json({ error: 'contacts[] required' });
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });

    const db = req.app.locals.pgDb;
    const force = !!options.force; // re-check even contacts already done

    // PERSISTENCE: reuse prior results so a re-run doesn't re-spend Google calls (and
    // doesn't re-block the server on the offline CCOD scans). Preload the cached
    // rows for any contacts we've qualified before, unless the user asked to re-check.
    let cached = {};
    if (db && !force) {
      const ids = contacts.map((c) => c.id).filter(Boolean);
      if (ids.length) { try { cached = await db.getSolarResults(ids); } catch (e) { /* fall back to live */ } }
    }

    // Bounded concurrency — the cascade is network-bound on Google calls, so a few in
    // parallel. Ownership + CCOD stages are offline.
    const CONC = Math.min(Number(options.concurrency) || 6, 10);
    const queue = contacts.map((c, i) => ({ c, i }));
    let cursor = 0;
    async function worker() {
      while (cursor < queue.length) {
        const { c, i } = queue[cursor++];
        let rec;
        const hit = c.id && cached[String(c.id)];
        if (hit) {
          rec = cachedRec(hit); // reuse — no Google spend
        } else {
          try {
            rec = await enrichContact(c, options);
          } catch (e) {
            rec = { status: 'disqualified', stage: 'error', stop_reason: 'error', error: e.message, email: c.email, company_name: c.company_name };
          }
          // Persist the fresh result so the next run reuses it (skip pure errors).
          if (db && c.id && rec.stage !== 'error') {
            try { await db.saveSolarResult(c.id, rec); } catch (e) { /* non-fatal */ }
          }
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
