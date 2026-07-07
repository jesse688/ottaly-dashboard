const express = require('express');
const path = require('path');
const fs = require('fs');
const ApolloCSVImporter = require('./csv-importer');
const SIC_CODES = require('./sic-codes'); // [ [code, description], ... ]

module.exports = (db) => {
  const router = express.Router();
  const importer = new ApolloCSVImporter(db);
  const { parse } = require('csv-parse/sync');

  // ── Middleware ──────────────────────────────────────────────────────────
  const DEFAULT_WORKSPACE = 'ottaly-global';

  const setWorkspace = (req, res, next) => {
    req.workspaceId = req.user?.workspace_id || req.headers['x-workspace-id'] || DEFAULT_WORKSPACE;
    next();
  };

  router.use(setWorkspace);

  // ── Import job tracking ──────────────────────────────────────────────────
  const importJobs = new Map();

  router.get('/import/jobs', (req, res) => {
    const jobs = [...importJobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
    res.json({ jobs });
  });

  router.get('/import/jobs/:id', (req, res) => {
    const job = importJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  });

  // POST /api/import/csv — chunked import (handles 120MB+ files)
  // Chunk 1: ?fileName=x&totalRows=N  → creates job, returns jobId
  // Chunk 2+: ?jobId=xxx              → appends to existing job
  router.post('/import/csv', async (req, res) => {
    try {
      const csvText = typeof req.body === 'string' ? req.body : req.body?.csvText;
      if (!csvText) return res.status(400).json({ error: 'csvText required' });

      const existingJobId = req.query.jobId;
      const fileName = req.query.fileName || 'import.csv';
      const totalRows = parseInt(req.query.totalRows || '0');

      // Get or create job
      let job = existingJobId ? importJobs.get(existingJobId) : null;
      if (!job) {
        const jobId = require('crypto').randomUUID();
        job = {
          id: jobId, fileName,
          status: 'processing', startedAt: Date.now(),
          total: totalRows || 1,
          imported: 0, duplicates: 0, errors: 0,
          processed: 0, progress: 0
        };
        importJobs.set(jobId, job);
        const all = [...importJobs.entries()].sort((a,b) => b[1].startedAt - a[1].startedAt);
        if (all.length > 50) all.slice(50).forEach(([id]) => importJobs.delete(id));
        res.json({ jobId: job.id, message: 'Import started' });
      } else {
        res.json({ jobId: job.id, message: 'Chunk received' });
      }

      // Process chunk asynchronously after responding
      setImmediate(async () => {
        try {
          let rows;
          try {
            rows = parse(csvText, { columns: true, skip_empty_lines: true, relax_quotes: true, trim: true });
          } catch (e) {
            job.errors += 1;
            console.error('[Import] Parse error:', e.message.slice(0, 200));
            return;
          }

          // Free/consumer email domains must never reach B2B campaigns.
          // Flag them at import so they fail the push gate and are visible in the table.
          const FREE_EMAIL_DOMAINS_IMPORT = new Set([
            'gmail.com','googlemail.com',
            'yahoo.com','yahoo.co.uk','yahoo.fr','yahoo.de','yahoo.es','yahoo.it',
            'hotmail.com','hotmail.co.uk','hotmail.fr','hotmail.de','hotmail.es',
            'outlook.com','outlook.co.uk','live.com','live.co.uk','msn.com',
            'icloud.com','me.com','mac.com','aol.com','aim.com',
            'protonmail.com','proton.me','zoho.com',
            'mail.com','email.com','usa.com','post.com',
            'btinternet.com','btopenworld.com','sky.com','talk21.com','talktalk.net',
            'ntlworld.com','virgin.net','virginmedia.com','blueyonder.co.uk',
            'yopmail.com','mailinator.com','guerrillamail.com','10minutemail.com',
            'throwaway.email','tempmail.com','temp-mail.org','dispostable.com',
            'example.com','test.com','sample.com',
          ]);
          const contacts = [];
          for (const row of rows) {
            const contact = importer.mapApolloRow(row);
            if (!contact.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) continue;
            if (!contact.firstName && !contact.lastName) continue;
            // Flag free-domain contacts as invalid at import time
            const importDomain = (contact.email.split('@')[1] || '').toLowerCase();
            if (FREE_EMAIL_DOMAINS_IMPORT.has(importDomain)) {
              contact.email_status = 'invalid';
              contact.do_not_contact = true;
            }
            contacts.push(contact);
          }

          const workspaceId = req.workspaceId;
          const batchSize = 200;
          for (let i = 0; i < contacts.length; i += batchSize) {
            const batch = contacts.slice(i, i + batchSize);
            try {
              const result = await db.bulkCreateContacts(workspaceId, batch);
              job.imported  += result.inserted || 0;
              job.duplicates += result.updated || 0;
              // Rows lost to within-batch email duplicates are reported as
              // errors so the UI's "skipped" count surfaces them.
              job.errors    += result.withinBatchDupes || 0;
              // Anything that didn't insert, update, or get deduped was lost
              // to a SQL failure — count those as errors too.
              const accounted = (result.inserted || 0) + (result.updated || 0) + (result.withinBatchDupes || 0);
              if (accounted < batch.length) job.errors += batch.length - accounted;
            } catch (e) {
              job.errors += batch.length;
              console.error('[Import] Batch error:', e.message.slice(0, 150));
            }
            job.processed += batch.length;
            job.progress = job.total > 0
              ? Math.min(99, Math.round((job.processed / job.total) * 100))
              : 50;
          }

          // Mark done when last chunk finishes
          if (!existingJobId || job.processed >= job.total * 0.95) {
            job.status = 'done';
            job.progress = 100;
            console.log(`[Import] ${job.fileName}: ${job.imported} new, ${job.duplicates} updated, ${job.errors} errors`);
          }
        } catch (err) {
          console.error('[Import] Chunk processing error:', err.message);
        }
      });

    } catch (err) {
      console.error('[Import] Error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // ── Contacts API ──────────────────────────────────────────────────────────

  // GET /api/contacts/distinct-values
  router.get('/contacts/distinct-values', async (req, res) => {
    try {
      const { field, limit = 5000 } = req.query;
      if (!field) return res.status(400).json({ error: 'field parameter required' });
      const values = await db.getDistinctValues(req.workspaceId, field, Math.min(parseInt(limit) || 5000, 10000));
      res.json({ field, values });
    } catch (err) {
      console.error('[API] Distinct values error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Common-term → SIC aliases. Official SIC wording often doesn't match how
  // people search ("care home" vs "Residential care activities…", "solar" which
  // has no dedicated code). Each alias term promotes a set of codes to the top.
  const SIC_ALIASES = {
    'care home':      ['87100','87200','87300','87900'],
    'care homes':     ['87100','87200','87300','87900'],
    'nursing home':   ['87100','86102'],
    'residential care':['87100','87200','87300','87900'],
    'domiciliary':    ['88100','88990'],
    'home care':      ['88100','88990'],
    'solar':          ['43210','35110','27900'],
    'renewable':      ['35110','35140'],
    'plumber':        ['43220'],
    'electrician':    ['43210'],
    'roofing':        ['43910'],
    'dentist':        ['86230'],
    'dental':         ['86230'],
    'gp':             ['86210'],
    'doctor':         ['86210'],
    'vet':            ['75000'],
    'restaurant':     ['56101','56102'],
    'cafe':           ['56103'],
    'pub':            ['56302'],
    'hotel':          ['55100'],
    'recruitment':    ['78109','78200','78300'],
    'estate agent':   ['68310'],
    'accountant':     ['69201','69202','69203'],
    'solicitor':      ['69101','69102','69109'],
    'law firm':       ['69101','69102','69109'],
    'construction':   ['41201','41202','43999'],
    'builder':        ['41201','41202'],
    'manufacturing':  [],
    'logistics':      ['49410','52103','52290'],
    'haulage':        ['49410'],
    'gym':            ['93130'],
    'fitness':        ['93130'],
  };

  // GET /api/contacts/sic-search?q=… — typeahead over the full UK SIC 2007 list
  // (by code, description, or common-term alias) for the Industry (SIC) filter.
  router.get('/contacts/sic-search', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ results: SIC_CODES.slice(0, 40).map(([code, label]) => ({ code, label })) });
    const digits = q.replace(/[^0-9]/g, '');
    // Alias boost: any alias term containing (or contained by) the query promotes its codes.
    const aliasCodes = new Set();
    for (const [term, codes] of Object.entries(SIC_ALIASES)) {
      if (term.includes(q) || q.includes(term)) codes.forEach(c => aliasCodes.add(c));
    }
    const scored = [];
    for (const [code, label] of SIC_CODES) {
      const ll = label.toLowerCase();
      let score = 0;
      if (aliasCodes.has(code)) score = 110;                       // common-term alias — top
      if (digits && code.startsWith(digits)) score = Math.max(score, 100);
      else if (digits && code.includes(digits)) score = Math.max(score, 60);
      if (ll.startsWith(q)) score = Math.max(score, 90);
      else if (ll.includes(q)) score = Math.max(score, 50);
      if (score) scored.push({ code, label, score });
    }
    scored.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
    res.json({ results: scored.slice(0, 40).map(({ code, label }) => ({ code, label })) });
  });

  // GET /api/contacts/email-providers
  // Build the same `filters` object /contacts/search uses, so the count
  // endpoints honour the live filter state. Caller pre-strips the filter
  // it's reporting on (numEmployeesRanges / emailProviders) so each row
  // count answers "what would I add by ticking this?"
  function filtersFromQuery(q) {
    return {
      search: q.q,
      status: q.status, seniority: q.seniority,
      firstName: q.firstName, lastName: q.lastName,
      jobTitle: q.jobTitle, jobTitleExclude: q.jobTitleExclude,
      department: q.department, subDepartments: q.subDepartments,
      company: q.company,
      industry: q.industry, industryExclude: q.industryExclude,
      keywords: q.keywords, keywordsExclude: q.keywordsExclude,
      sicCodes: q.sicCodes,
      technologies: q.technologies, technologiesExclude: q.technologiesExclude,
      website: q.website, companyLinkedin: q.companyLinkedin,
      city: q.city, state: q.state, country: q.country,
      personRegion: q.personRegion, personCounty: q.personCounty, personTown: q.personTown,
      companyCity: q.companyCity, companyState: q.companyState, companyCountry: q.companyCountry,
      // Normalised location hierarchy filters (Country>Region>County>City>Town)
      companyRegion: q.companyRegion, companyCounty: q.companyCounty, companyTown: q.companyTown,
      locationNeedsReview: q.locationNeedsReview,
      email: q.email, phone: q.phone, linkedinUrl: q.linkedinUrl,
      emailProviders: q.emailProviders,
      excludeMicrosoft: q.excludeMicrosoft,
      gatewayExclude: q.gatewayExclude,
      gateway: q.gateway,
      ownsBuilding: q.ownsBuilding,
      worksRemote: q.worksRemote, excludeRemote: q.excludeRemote, excludeDNC: q.excludeDNC,
      notExportedToApollo: q.notExportedToApollo, exportedToApollo: q.exportedToApollo,
      sentToPV: q.sentToPV, notSentToPV: q.notSentToPV,
      vertical: q.vertical,
      numEmployeesRanges: q.numEmployeesRanges,
    };
  }

  router.get('/contacts/email-providers', async (req, res) => {
    try {
      const filters = filtersFromQuery(req.query);
      const stats = await db.getEmailProviderStats(req.workspaceId, filters);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/contacts/employee-counts — bucket counts for the # Employees
  // filter, scoped to the current filter set so the numbers move as
  // other filters change. Doubles as a diagnostic for "is num_employees
  // actually populated?" when every bucket but 'unknown' is zero.
  router.get('/contacts/employee-counts', async (req, res) => {
    try {
      const filters = filtersFromQuery(req.query);
      const counts = await db.getEmployeeBucketCounts(req.workspaceId, filters);
      res.json({ counts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/contacts/backfill-employees — manual rerun of the
  // num_employees backfill (the startup one can be killed by pool
  // exhaustion during multi-instance situations).
  router.post('/contacts/backfill-employees', async (req, res) => {
    try {
      const result = await db.backfillNumEmployees();
      res.json({ updated: result.updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/contacts/backfill-email-providers
  router.post('/contacts/backfill-email-providers', async (req, res) => {
    try {
      const result = await db.backfillEmailProviders();
      res.json({ message: 'Backfill completed', processed: result.processed, updated: result.updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── MX provider verification (live DNS, authoritative) ───────────────────
  // Re-resolves each contact's TRUE email provider (Google / Microsoft / Other)
  // from the domain's actual MX records — the most accurate signal, since the
  // MX is where mail physically routes. Gateway-fronted Microsoft (Mimecast/
  // Proofpoint/…) is unmasked via SPF so it isn't mislabelled 'Other'.
  //
  //   POST /api/contacts/mx-scan   — start the background scan (409 if running)
  //                                  body { reverify:true } re-resolves ALL
  //                                  contacts (not just NULL) to catch provider
  //                                  migrations; otherwise only the unknowns.
  //   GET  /api/contacts/mx-scan   — { running, stats } poll for progress
  //   GET  /api/contacts/mx-coverage — { google, outlook, other, unknown }
  //   POST /api/contacts/mx-reseed — instant: fan known domain→provider from
  //                                  domain_mx_cache across NULL contacts (no DNS)
  if (!global.__mxScanJob) global.__mxScanJob = { running: false, stats: null, startedAt: 0, error: null };
  const mxJob = global.__mxScanJob;

  router.post('/contacts/mx-scan', async (req, res) => {
    if (mxJob.running) return res.status(409).json({ error: 'A provider scan is already running', running: true, stats: mxJob.stats });
    const reverify = req.body && (req.body.reverify === true || req.body.reverify === 'true');
    mxJob.running = true; mxJob.stats = null; mxJob.error = null; mxJob.startedAt = Date.now();
    // Fire-and-forget; the GET endpoint reports progress.
    (async () => {
      try {
        if (reverify && db.reverifyAllMxProvider) {
          mxJob.stats = await db.reverifyAllMxProvider({ onProgress: s => { mxJob.stats = s; } });
        } else {
          mxJob.stats = await db.scanContactsMxProvider({ onProgress: s => { mxJob.stats = s; } });
        }
      } catch (err) {
        mxJob.error = err.message;
        console.error('[mx-scan] failed:', err.message);
      } finally {
        mxJob.running = false;
      }
    })();
    res.json({ started: true, reverify });
  });

  router.get('/contacts/mx-scan', (req, res) => {
    res.json({ running: mxJob.running, stats: mxJob.stats, error: mxJob.error, startedAt: mxJob.startedAt });
  });

  router.get('/contacts/mx-coverage', async (req, res) => {
    try {
      const stats = await db.getEmailProviderStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/contacts/mx-reseed', async (req, res) => {
    try {
      const result = db.reseedMxFromDomainCache ? await db.reseedMxFromDomainCache() : { updated: 0 };
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin-configurable filter defaults (persisted in app_settings, so they apply
  // for everyone, not per-browser). Controls which provider/gateway exclusions
  // are pre-applied when the Contacts page loads.
  //   { excludeMicrosoft: bool, excludeGateways: [gatewayName, …] }
  const FILTER_DEFAULTS_KEY = 'contact_filter_defaults';
  const FILTER_DEFAULTS_FALLBACK = {
    excludeMicrosoft: false,                              // MS converts (Bruud) — off by default now
    excludeGateways: ['Mimecast','Barracuda','Proofpoint'], // the cold-email blockers — off by default
  };
  router.get('/contacts/filter-defaults', async (req, res) => {
    try {
      const v = await db.getSetting(FILTER_DEFAULTS_KEY, null);
      res.json(v && typeof v === 'object' ? { ...FILTER_DEFAULTS_FALLBACK, ...v } : FILTER_DEFAULTS_FALLBACK);
    } catch (err) {
      res.json(FILTER_DEFAULTS_FALLBACK);
    }
  });
  router.post('/contacts/filter-defaults', async (req, res) => {
    try {
      const body = req.body || {};
      const next = {
        excludeMicrosoft: !!body.excludeMicrosoft,
        excludeGateways: Array.isArray(body.excludeGateways) ? body.excludeGateways.filter(Boolean) : [],
      };
      await db.setSetting(FILTER_DEFAULTS_KEY, next);
      res.json({ ok: true, defaults: next });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/contacts/reset-apollo-exports — clear all exported_to_apollo_at stamps
  // Done in 5k-row chunks so live exports/webhooks don't deadlock with us
  // on the 200k-row update. Each chunk takes its own lock, releases it,
  // then the next chunk picks up rows that are still stamped.
  router.post('/contacts/reset-apollo-exports', async (req, res) => {
    try {
      const BATCH = 5000;
      let cleared = 0;
      while (true) {
        const result = await db.query(
          `UPDATE contacts SET exported_to_apollo_at = NULL
           WHERE id IN (
             SELECT id FROM contacts
             WHERE workspace_id = $1 AND exported_to_apollo_at IS NOT NULL
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )`,
          [req.workspaceId, BATCH]
        );
        const n = result.rowCount || 0;
        cleared += n;
        if (n < BATCH) break;
      }
      res.json({ cleared, message: `Cleared export stamps from ${cleared} contacts` });
    } catch (err) {
      console.error('[Reset Exports] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/contacts/backfill-locations
  router.post('/contacts/backfill-locations', async (req, res) => {
    try {
      const updated = await db.backfillLocations(req.workspaceId);
      res.json({ updated, message: `Backfilled location data for ${updated} contacts` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/contacts/cleanup-noname
  router.post('/contacts/cleanup-noname', async (req, res) => {
    try {
      const deleted = await db.deleteNoNameContacts(req.workspaceId);
      res.json({ deleted, message: `Removed ${deleted} contacts with no name` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/contacts/delete-all
  router.post('/contacts/delete-all', async (req, res) => {
    try {
      const result = await db.deleteAllContacts();
      res.json({ message: 'All contacts deleted', deleted: result.deleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/contacts/delete-from-csv
  // Body: raw CSV (text/csv). Query: ?dryRun=1 to preview.
  // Used after exporting "needs enrichment" contacts from Apollo — we delete
  // the stale rows here, then the user re-scrapes fresh data and re-imports
  // via the normal /api/import/csv path. No history is kept on purpose:
  // the whole point is a clean fresh record.
  router.post('/contacts/delete-from-csv', async (req, res) => {
    try {
      const csvText = typeof req.body === 'string' ? req.body : '';
      if (!csvText.trim()) return res.status(400).json({ error: 'Empty CSV body' });

      let rows;
      try {
        rows = parse(csvText, { columns: true, skip_empty_lines: true, relax_quotes: true, trim: true });
      } catch (parseErr) {
        return res.status(400).json({ error: `CSV parse failed: ${parseErr.message}` });
      }
      if (!rows.length) return res.status(400).json({ error: 'CSV has no data rows' });

      const emails    = [];
      const apolloIds = [];
      for (const row of rows) {
        const email = (row['Email'] || row['email'] || '').trim().toLowerCase();
        if (email) emails.push(email);
        const apid = (row['Apollo Contact Id'] || row['Apollo ID'] || row['apollo_id'] || '').trim();
        if (apid) apolloIds.push(apid);
      }
      if (!emails.length && !apolloIds.length) {
        return res.status(400).json({ error: 'CSV has no Email or Apollo Contact Id columns' });
      }

      const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
      const result = await db.deleteByCsvKeys({ emails, apolloIds, dryRun });
      res.json({
        dryRun,
        csvRows: rows.length,
        uniqueEmails: new Set(emails).size,
        uniqueApolloIds: new Set(apolloIds).size,
        matched: result.matched,
        deleted: result.deleted,
        sampleEmails: [...new Set(emails)].slice(0, 5)
      });
    } catch (err) {
      console.error('[delete-from-csv]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Saved views ───────────────────────────────────────────────────────
  // Named filter sets per workspace. Filter blob is the same hash string the
  // UI writes to location.hash, so save / load symmetry is trivial.

  router.get('/contacts/views', async (req, res) => {
    try {
      const views = await db.listSavedViews(req.workspaceId);
      res.json({ views });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/contacts/views', async (req, res) => {
    try {
      const name = (req.body?.name || '').toString().trim();
      const filters = (req.body?.filters || '').toString();
      if (!name) return res.status(400).json({ error: 'name required' });
      if (name.length > 80) return res.status(400).json({ error: 'name too long (max 80)' });
      const view = await db.saveView(req.workspaceId, name, filters);
      res.json({ view });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/contacts/views/:id', async (req, res) => {
    try {
      const deleted = await db.deleteSavedView(req.workspaceId, req.params.id);
      res.json({ deleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/contacts/search
  router.get('/contacts/search', async (req, res) => {
    try {
      const { q, sortBy = 'created_at', sortDir = 'desc', limit = 50, offset = 0, ...rest } = req.query;
      // maxPerCompany caps how many contacts per company come back — used by
      // the "Select…" popover to grab e.g. 1500 leads spread across companies
      // without piling 30 from one. 0/empty disables the cap.
      const maxPerCompany = Math.max(0, parseInt(rest.maxPerCompany || '0', 10) || 0);

      const filters = {
        search: q, sortBy, sortDir,
        status: rest.status, seniority: rest.seniority,
        firstName: rest.firstName, lastName: rest.lastName,
        jobTitle: rest.jobTitle, jobTitleExclude: rest.jobTitleExclude,
        department: rest.department, subDepartments: rest.subDepartments,
        company: rest.company,
        industry: rest.industry, industryExclude: rest.industryExclude,
        keywords: rest.keywords, keywordsExclude: rest.keywordsExclude,
        sicCodes: rest.sicCodes,
        technologies: rest.technologies, technologiesExclude: rest.technologiesExclude,
        website: rest.website, companyLinkedin: rest.companyLinkedin,
        city: rest.city, state: rest.state, country: rest.country,
        personRegion: rest.personRegion, personCounty: rest.personCounty, personTown: rest.personTown,
        companyCity: rest.companyCity, companyState: rest.companyState, companyCountry: rest.companyCountry,
        // Normalised location hierarchy filters (Country>Region>County>City>Town)
        companyRegion: rest.companyRegion, companyCounty: rest.companyCounty, companyTown: rest.companyTown,
        locationNeedsReview: rest.locationNeedsReview,
        email: rest.email, phone: rest.phone, linkedinUrl: rest.linkedinUrl,
        tags: rest.tags, source: rest.source,
        emailProviders: rest.emailProviders,
        gatewayExclude: rest.gatewayExclude,
        gateway: rest.gateway,
        emailStatus: rest.emailStatus,
        ownsBuilding: rest.ownsBuilding,
        worksRemote: rest.worksRemote,
        excludeRemote: rest.excludeRemote,
        excludeDNC: rest.excludeDNC,
        notExportedToApollo: rest.notExportedToApollo,
        exportedToApollo: rest.exportedToApollo,
        sentToPV: rest.sentToPV,
        notSentToPV: rest.notSentToPV,
        vertical: rest.vertical,
        cooldownWorkspace: rest.cooldownWorkspace,
        numEmployeesRanges: rest.numEmployeesRanges,
        maxPerCompany,
        chStatus: rest.chStatus,
        chInsolvency: rest.chInsolvency,
        chCharges: rest.chCharges,
        chOverdue: rest.chOverdue,
        chOnlyEnriched: rest.chOnlyEnriched,
      };

      // Master exclusions per client — when a target client is selected, load
      // their always-on exclusion lists from SQLite (client_verticals) and
      // merge into the filter object. User-typed excludes layer on top;
      // master exclusions can't be turned off from the contacts UI.
      if (rest.cooldownWorkspace) {
        try {
          const sq = req.app.locals.sqliteDb;
          if (sq) {
            const row = sq.prepare(`
              SELECT excluded_industries, excluded_company_sizes, excluded_keywords,
                     excluded_counties, excluded_cities, excluded_job_titles
                FROM client_verticals WHERE workspace_id = ?
            `).get(rest.cooldownWorkspace);
            if (row) {
              const merge = (a, b) => {
                const aa = (a || '').split(',').map(s => s.trim()).filter(Boolean);
                const bb = (b || '').split(',').map(s => s.trim()).filter(Boolean);
                return [...new Set([...aa, ...bb])].join(',');
              };
              filters.industryExclude  = merge(filters.industryExclude,  row.excluded_industries);
              filters.keywordsExclude  = merge(filters.keywordsExclude,  row.excluded_keywords);
              filters.jobTitleExclude  = merge(filters.jobTitleExclude,  row.excluded_job_titles);
              filters.cityExclude      = merge(rest.cityExclude,         row.excluded_cities);
              filters.stateExclude     = merge(rest.stateExclude,        row.excluded_counties);
              filters.numEmployeesExcludeRanges = merge(rest.numEmployeesExcludeRanges, row.excluded_company_sizes);
            }
          }
        } catch (e) {
          console.warn('[search] master-exclusion lookup failed:', e.message);
        }
      }

      // Cap raised from 1000 → 200k so Apollo-style bulk selection works.
      // Browser still pulls only what's needed; this is the upper bound
      // searchContacts will honour.
      const cappedLimit = Math.min(parseInt(limit) || 50, 200000);

      // Run search + count in parallel — they're independent queries and
      // serialising them doubled the wall-clock for every search.
      const [contacts, total] = await Promise.all([
        db.searchContacts(req.workspaceId, filters, cappedLimit, parseInt(offset)),
        db.getContactsCount(req.workspaceId, filters)
      ]);
      res.json({ contacts, total, limit: cappedLimit, offset: parseInt(offset) });
    } catch (err) {
      console.error('[API] Search error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/contacts/by-email/:email
  router.get('/contacts/by-email/:email', async (req, res) => {
    try {
      const contact = await db.getContact(req.workspaceId, req.params.email);
      if (!contact) return res.status(404).json({ error: 'Contact not found' });
      res.json(contact);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/contacts
  router.post('/contacts', async (req, res) => {
    try {
      const contact = await db.createContact(req.workspaceId, req.body);
      res.status(201).json(contact);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/contacts/:email/status
  router.patch('/contacts/by-email/:email/status', async (req, res) => {
    try {
      const { status } = req.body;
      if (!status) return res.status(400).json({ error: 'Status required' });
      const contact = await db.updateContactStatus(req.workspaceId, req.params.email, status);
      res.json(contact);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/contacts/:id — update editable fields
  router.patch('/contacts/:id', async (req, res) => {
    try {
      const allowed = ['first_name','last_name','phone','linkedin_url','job_title','job_title_cleaned',
        'seniority','department','company_name','company_domain','status',
        'owns_building','works_remote','do_not_contact'];
      const sets = [], vals = [];
      let p = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(`${key} = $${p++}`);
          vals.push(req.body[key] === '' ? null : req.body[key]);
        }
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      sets.push('updated_at = CURRENT_TIMESTAMP');
      vals.push(req.params.id);
      await db.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $${p}`, vals);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/import/batch
  router.post('/import/batch', async (req, res) => {
    try {
      const { dirPath } = req.body;
      if (!dirPath || !fs.existsSync(dirPath)) return res.status(400).json({ error: 'Invalid directory path' });
      res.json({ message: 'Batch import started', dirPath });
      importer.importBatchFromDirectory(req.workspaceId, dirPath)
        .then(results => console.log('[API] Batch import completed:', results.length, 'files'))
        .catch(err => console.error('[API] Batch import failed:', err));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/contacts/export — size + count capped CSV export
  // Each file is at most 45MB OR 100,000 contacts, whichever hits first.
  // Apollo's bulk-import has its own ceilings around 50MB / 100k rows so
  // staying under both keeps every file ingestible.
  router.get('/contacts/export', async (req, res) => {
    try {
      const offset = Math.max(0, parseInt(req.query.offset || '0'));
      const MAX_BYTES = 45 * 1024 * 1024; // 45MB target per file (under Apollo's 50MB ceiling)
      const MAX_ROWS  = 100000;            // hard cap per file regardless of size
      const CHUNK = 1000; // rows fetched per DB call

      // Build filters from query params — same keys as the contacts search.
      // Whitelist the filters that are safe to use in an export context.
      const exportFilters = {};
      if (req.query.notExportedOnly === 'true') exportFilters.notExportedToApollo = 'true';
      // Honor EVERY filter the contacts search understands, so "filter first,
      // then Apollo Export" gives exactly the rows you're looking at. (Keys must
      // match _buildFilterClauses in db-postgres.js.)
      const EXPORT_FILTER_KEYS = [
        'status','source','tags','company','website','email','phone','linkedinUrl','companyLinkedin',
        'firstName','lastName','jobTitle','jobTitleExclude','seniority','department','subDepartments',
        'industry','industryExclude','keywords','keywordsExclude','technologies','technologiesExclude',
        'sicCodes','numEmployeesRanges','emailProviders','excludeMicrosoft','gateway','gatewayExclude',
        'emailStatus','locationNeedsReview',
        'city','cityExclude','state','stateExclude','country','countryExclude',
        'companyCity','companyState','companyCountry','companyCounty','companyRegion','companyTown',
        'personRegion','personCounty','personTown',
      ];
      for (const key of EXPORT_FILTER_KEYS) {
        if (req.query[key]) exportFilters[key] = req.query[key];
      }
      // The search box param is `q` on the wire but `search` in the filter builder.
      if (req.query.q) exportFilters.search = req.query.q;

      // Count against the SAME clean guard the export paginates over, else
      // X-Has-More overshoots the real end and loops empty/wrong files.
      const total = db.getExportableCount
        ? await db.getExportableCount(req.workspaceId, exportFilters)
        : await db.getContactsCount(req.workspaceId, exportFilters);
      console.log(`[Export] workspaceId=${req.workspaceId} exportable=${total} notExportedOnly=${req.query.notExportedOnly}`);

      // Minimal Apollo upload — Apollo enriches the rest from its own
      // database (title, seniority, industry, location, LinkedIn, phone,
      // technologies, keywords, # employees). Smaller files = much faster
      // upload and ingest. Apollo Contact Id is included so existing
      // records get matched + updated instead of duplicated.
      const cols = [
        'First Name','Last Name','Email','Company Name','Website','Apollo Contact Id',
      ];

      const esc = v => {
        const s = String(v == null ? '' : v);
        return (s.includes(',') || s.includes('"') || s.includes('\n'))
          ? `"${s.replace(/"/g, '""')}"` : s;
      };

      const rowToCsv = c => {
        const raw = typeof c.raw_data === 'string' ? JSON.parse(c.raw_data || '{}') : (c.raw_data || {});
        return [
          c.first_name||'',
          c.last_name||'',
          c.email||'',
          c.company_name||'',
          c.company_domain||'',
          c.apollo_id||raw['Apollo Contact Id']||'',
        ].map(esc).join(',');
      };

      // Build CSV until we hit the size limit
      const lines = ['﻿' + cols.join(',')]; // BOM + header
      let sizeBytes = Buffer.byteLength(lines[0], 'utf8');
      let currentOffset = offset;
      let rowsExported = 0;
      const exportedIds = [];

      while (true) {
        const batch = await db.exportContacts(req.workspaceId, exportFilters, CHUNK, currentOffset);
        if (!batch.length) break;

        for (const c of batch) {
          const line = rowToCsv(c);
          const lineBytes = Buffer.byteLength(line, 'utf8') + 2; // +2 for \r\n
          const sizeFull  = sizeBytes + lineBytes > MAX_BYTES;
          const countFull = rowsExported >= MAX_ROWS;
          if ((sizeFull || countFull) && rowsExported > 0) {
            // File is full — stamp what we have and stop here
            if (db.stampExportedToApollo) await db.stampExportedToApollo(req.workspaceId, exportedIds);
            const nextOffset = offset + rowsExported;
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="apollo-export-offset-${offset}.csv"`);
            res.setHeader('X-Total-Records', String(total));
            res.setHeader('X-Has-More', String(nextOffset < total));
            res.setHeader('X-Next-Offset', String(nextOffset));
            res.setHeader('X-Rows-In-File', String(rowsExported));
            return res.send(lines.join('\r\n'));
          }
          lines.push(line);
          sizeBytes += lineBytes;
          rowsExported++;
          if (c.id) exportedIds.push(c.id);
        }
        currentOffset += batch.length;
        if (batch.length < CHUNK) break; // last page
      }

      if (db.stampExportedToApollo) await db.stampExportedToApollo(req.workspaceId, exportedIds);
      const nextOffset = offset + rowsExported;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="apollo-export-offset-${offset}.csv"`);
      res.setHeader('X-Total-Records', String(total));
      res.setHeader('X-Has-More', String(nextOffset < total));
      res.setHeader('X-Next-Offset', String(nextOffset));
      res.setHeader('X-Rows-In-File', String(rowsExported));
      res.send(lines.join('\r\n'));
    } catch (err) {
      console.error('[Export] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/contacts/:id — MUST be last (wildcard catches everything above)
  router.get('/contacts/:id', async (req, res) => {
    try {
      const contacts = await db.getContactsById([req.params.id]);
      if (!contacts.length) return res.status(404).json({ error: 'Not found' });
      res.json({ contact: contacts[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
