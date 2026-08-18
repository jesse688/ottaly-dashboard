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
const { roofImagePng, buildingInsights, roofImagery, panelOverlaySvg } = require('./lib/solar/google-solar');
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

  // ── Ad-hoc lookup from a Google Maps link ────────────────────────────────
  // POST /api/solar/lookup { url } | { lat, lng }
  //   -> { coords, roof:{...}, company:{ contacts:[...], solar:{...} } }
  //
  // For checking one site by hand: paste a Maps link, get the roof numbers and
  // everything we already hold on whoever is at that address. Deliberately
  // separate from /enrich, which is the batch cascade over stored contacts.

  // Maps URLs carry coordinates in several places, and they do NOT all mean the
  // same thing. The @lat,lng in the path is the CAMERA centre — panning the map
  // moves it away from the place you actually clicked — whereas !3dLAT!4dLNG
  // and the ?q=/query= parameters are the PIN. Prefer the pin, fall back to the
  // camera, so a link copied after scrolling still resolves to the right roof.
  function coordsFromMapsUrl(raw) {
    const url = String(raw || '').trim();
    if (!url) return null;
    const num = '(-?\\d+\\.\\d+)';
    const patterns = [
      new RegExp(`!3d${num}!4d${num}`),                      // pin (place pages)
      new RegExp(`[?&](?:q|query|destination)=${num},\\s*${num}`), // explicit query pin
      new RegExp(`[?&]ll=${num},${num}`),                    // legacy centre
      new RegExp(`@${num},${num}`),                          // camera centre
      new RegExp(`^\\s*${num},\\s*${num}\\s*$`),             // bare "lat,lng" paste
    ];
    for (const re of patterns) {
      const m = re.exec(url);
      if (!m) continue;
      const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { lat, lng };
      }
    }
    return null;
  }

  router.post('/lookup', async (req, res) => {
    const { url, lat: bodyLat, lng: bodyLng, panelWatts } = req.body || {};
    const coords = (bodyLat != null && bodyLng != null)
      ? { lat: Number(bodyLat), lng: Number(bodyLng) }
      : coordsFromMapsUrl(url);

    if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) {
      // A shortened maps.app.goo.gl / goo.gl link has no coordinates in it —
      // they only appear after the redirect, so say that rather than failing blankly.
      const shortened = /(?:maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(String(url || ''));
      return res.status(400).json({
        error: shortened
          ? 'That is a shortened link — open it in Maps and copy the full URL from the address bar (it contains the coordinates).'
          : 'Could not find coordinates in that link. Paste a full Google Maps URL, or "lat,lng".',
      });
    }

    try {
      const insights = await buildingInsights(coords.lat, coords.lng);
      if (insights.notFound) {
        return res.json({ coords, roof: null, note: 'Google has no building imagery for this location.' });
      }

      // kWp from panel count × panel wattage. Google's own panelCapacityWatts is
      // the module it modelled with, which is usually smaller than what actually
      // gets installed, so allow an override to match the spec being quoted.
      const watts = Number(panelWatts) || insights.panelWatts || 500;
      const maxKwp = insights.maxPanels != null
        ? Math.round((insights.maxPanels * watts) / 1000)
        : null;

      const roof = {
        roof_area_m2: insights.roofAreaM2,
        max_panels: insights.maxPanels,
        panel_watts: watts,
        max_kwp: maxKwp,
        // ~950 kWh per kWp/year is the standard UK yield assumption.
        annual_kwh: maxKwp != null ? Math.round(maxKwp * 950) : null,
        max_sunshine_hours: insights.maxSunshineHoursPerYear,
        has_solar_already: insights.hasSolar,
        imagery_date: insights.imageryDate,
      };

      // Everything we already hold on whoever sits at this location. Matched by
      // proximity on the coordinates we stored during past solar checks — the
      // reliable key, since the same building is written a dozen different ways
      // as an address string.
      let company = { contacts: [], matched_on: null };
      const db = req.app.locals.pgDb;
      if (db) {
        try {
          // ~150m box. Longitude degrees shrink with latitude, so scale by
          // cos(lat) or the box is far too wide in the UK.
          const dLat = 0.00135;
          const dLng = 0.00135 / Math.max(0.2, Math.cos(coords.lat * Math.PI / 180));
          const r = await db.query(
            `SELECT id, email, first_name, last_name, company_name, company_domain,
                    company_address, ch_postcode, company_status, num_employees, industry,
                    solar_status, solar_stop_reason, solar_roof_area_m2, solar_max_kwp,
                    solar_has_solar, solar_checked_at, owns_building, do_not_contact,
                    ROUND((point(solar_lng, solar_lat) <-> point($2, $1))::numeric, 6) AS dist
               FROM contacts
              WHERE solar_lat BETWEEN $1 - $3 AND $1 + $3
                AND solar_lng BETWEEN $2 - $4 AND $2 + $4
              ORDER BY dist
              LIMIT 25`,
            [coords.lat, coords.lng, dLat, dLng]
          );
          company = { contacts: r.rows, matched_on: r.rows.length ? 'coordinates' : null };
        } catch (e) {
          company = { contacts: [], matched_on: null, error: e.message };
        }
      }

      res.json({ coords, roof, company });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/solar/imagery { lat, lng }
  //   -> { rgb, flux, flux_over_rgb, panels_over_rgb, panel_count, imageryDate }
  //
  // Every visual Google can give for a roof. Separate from /lookup because it
  // is a second billed call (dataLayers) plus image processing — the numbers
  // come back instantly, the pictures are asked for only when wanted.
  router.post('/imagery', async (req, res) => {
    const { lat, lng, radiusMeters } = req.body || {};
    if (lat == null || lng == null) return res.status(400).json({ error: 'lat/lng required' });
    try {
      const img = await roofImagery(Number(lat), Number(lng), { radiusMeters });
      if (img.error) return res.json({ error: img.error });

      const out = {
        rgb: img.layers.rgb || null,
        flux: img.layers.flux || null,
        flux_over_rgb: img.layers.flux_over_rgb || null,
        panels_over_rgb: null,
        panel_count: 0,
        imageryDate: img.imageryDate || null,
        fluxError: img.fluxError || null,
      };

      // Panel positions come from buildingInsights, not dataLayers, so this is
      // a second (cheap, already-cached-by-Google) call. Drawn over the photo
      // rather than returned as bare geometry, because the point is to show
      // someone what their roof would look like.
      try {
        const bi = await buildingInsights(Number(lat), Number(lng));
        const sp = (bi && bi.raw && bi.raw.solarPotential) || {};
        const panels = sp.solarPanels;

        // Always the IMAGE's extent — roofImagery derives it from the request
        // centre and radius when dataLayers omits boundingBox. Deliberately not
        // buildingInsights.boundingBox: that is the building (~38m) not the
        // tile (~80m), and projecting into it magnified every panel ~2x and
        // scattered them over the trees and car park.
        const bounds = img.bounds || null;

        // Panels are square to their roof segment, so each needs its segment's
        // azimuth to be drawn at the right angle.
        const segmentAzimuths = {};
        (sp.roofSegmentStats || []).forEach((seg, i) => {
          if (seg && seg.azimuthDegrees != null) segmentAzimuths[i] = seg.azimuthDegrees;
        });

        if (!panels || !panels.length) out.panelsError = 'Google returned no panel geometry for this building';
        else if (!bounds) out.panelsError = 'no bounding box available to project panels into';
        const svg = panelOverlaySvg(panels, bounds, 768, {
          panelWidthM: sp.panelWidthMeters,
          panelHeightM: sp.panelHeightMeters,
          segmentAzimuths,
        });
        if (!svg && panels && panels.length && bounds) out.panelsError = 'panel projection produced no rectangles';

        // Which box the overlay used, and how big each is. The panels have to
        // be projected into the box that matches the IMAGE, not the building —
        // getting that wrong scatters them across the whole tile.
        if (req.body.debug) {
          const span = b => b && b.sw && b.ne ? {
            lat_deg: +(b.ne.latitude - b.sw.latitude).toFixed(6),
            lng_deg: +(b.ne.longitude - b.sw.longitude).toFixed(6),
            approx_m: Math.round((b.ne.latitude - b.sw.latitude) * 111320),
          } : null;
          out.debug = {
            image_box: span(img.bounds),
            image_box_source: img.boundsSource,
            buildingInsights_box: span(bi && bi.raw && bi.raw.boundingBox),
            panel_dims: { w: sp.panelWidthMeters, h: sp.panelHeightMeters },
            segments: (sp.roofSegmentStats || []).length,
          };
        }
        if (svg && img.layers.rgb) {
          const sharp = require('sharp');
          const base = Buffer.from(img.layers.rgb.split(',')[1], 'base64');
          const merged = await sharp(base)
            .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
            .png().toBuffer();
          out.panels_over_rgb = `data:image/png;base64,${merged.toString('base64')}`;
          out.panel_count = panels.length;
        }
      } catch (e) {
        out.panelsError = e.message;
      }

      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
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
