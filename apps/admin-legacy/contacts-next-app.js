/* Contacts v2: the page script for contacts-next.html.
 *
 * One state object (S) drives everything: the URL, the filter rail, the chips,
 * the saved views, the search, the counts and the filter handed to the push.
 * The original page kept three separate lists of "which filters exist" (URL
 * hash, campaign recall, clear), which is why Clear left filters on and saved
 * views lost half of them. Here a filter is one key in S.f and nothing else.
 */
(function () {
  'use strict';

  // ── Small helpers ────────────────────────────────────────────────────────
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (n == null || isNaN(n) ? '–' : Number(n).toLocaleString('en-GB'));
  const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const title = (s) => String(s || '').replace(/(^|[\s/&(-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  const pct = (r) => (r == null ? '–' : (r * 100).toFixed(r * 100 < 1 ? 2 : 1) + '%');
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cx.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('cx.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  function parseDate(v) {
    if (!v) return null;
    const d = new Date(String(v).replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d;
  }
  function daysAgo(v) {
    const d = parseDate(v);
    return d ? Math.floor((Date.now() - d.getTime()) / 86400000) : null;
  }
  function ago(v) {
    const n = daysAgo(v);
    if (n == null) return '';
    if (n <= 0) return 'today';
    if (n === 1) return '1 day ago';
    if (n < 60) return n + ' days ago';
    if (n < 730) return Math.round(n / 30.4) + ' months ago';
    return Math.round(n / 365) + ' years ago';
  }
  const shortDate = (v) => { const d = parseDate(v); return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : ''; };

  async function api(url, opts) {
    const o = opts || {};
    const res = await fetch(url, {
      method: o.method || 'GET',
      headers: o.body ? { 'Content-Type': 'application/json' } : undefined,
      body: o.body ? JSON.stringify(o.body) : undefined,
      signal: o.signal,
      credentials: 'same-origin',
    });
    if (res.status === 401) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.hash); throw new Error('Signed out'); }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    return data;
  }

  let toastTimer;
  function toast(msg, isErr) {
    const host = $('#toastHost');
    host.innerHTML = '<div class="cx-toast' + (isErr ? ' err' : '') + '" role="status">' + esc(msg) + '</div>';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { host.innerHTML = ''; }, isErr ? 6000 : 3200);
  }

  // ── Words for values ─────────────────────────────────────────────────────
  const SENIORITY = { c_suite: 'C-suite', vp: 'VP', director: 'Director', manager: 'Manager', junior: 'Junior', individual_contributor: 'Individual contributor', owner: 'Owner', founder: 'Founder', partner: 'Partner', head: 'Head', senior: 'Senior', entry: 'Entry level' };
  const PROVIDER = { email_google: 'Google', email_outlook: 'Microsoft', email_other: 'Other', unknown: 'Not checked' };
  const STATUS = { safe: 'Safe', safe_catchall: 'Safe (catch-all)', risky: 'Risky', unknown: 'Unknown', invalid: 'Invalid', not_verified: 'Not verified yet' };
  const SOURCE = { getleads: 'GetLeads', leadocean: 'LeadOcean', apollo_csv: 'Apollo', plusvibe: 'PlusVibe sync', plusvibe_csv: 'PlusVibe CSV', commoncrawl: 'Common Crawl', engine: 'Engine', ch_scraper: 'Companies House', api: 'API', manual: 'Manual' };
  const TIER_TEXT = { A: 'Verified, fresh, never sent', B: 'Good, may need a verify', C: 'Sendable, weaker', X: 'Cannot be sent' };
  const SIZE_ORDER = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001+', 'unknown'];
  const sizeBucket = (n) => (n == null ? '' : n <= 10 ? '1-10' : n <= 50 ? '11-50' : n <= 200 ? '51-200' : n <= 500 ? '201-500' : n <= 1000 ? '501-1000' : n <= 5000 ? '1001-5000' : '5001+');
  const REASONS = {
    unsafe: 'Email not safe to send', dnc: 'Do not contact', departed: 'Left the company', missingName: 'No first name',
    alreadyInCampaign: 'Already in this campaign', cooldownWorkspace: 'This client emailed them recently',
    verticalCollision: 'Another client in the same vertical emailed them', burstGap: 'Emailed by another client days ago',
    densityCeiling: 'Emailed by too many clients lately', snoozed: 'Snoozed for this vertical',
    missingEnrichment: 'No industry on file', notFresh: 'Another client emailed them inside the fresh window', tooYoung: 'Company too young',
  };

  const fmtVal = {
    seniority: (v) => SENIORITY[v] || title(String(v).replace(/_/g, ' ')),
    provider: (v) => PROVIDER[v] || v,
    emailStatus: (v) => STATUS[v] || title(v),
    source: (v) => SOURCE[v] || v,
    size: (v) => (v === 'unknown' ? 'Size unknown' : v + ' staff'),
    tier: (v) => 'Tier ' + v,
    text: (v) => title(v),
    raw: (v) => v,
  };

  // ── Filter schema ────────────────────────────────────────────────────────
  // Every filter the rail can show. `key` is the API filter key and the key in
  // S.f. `fmt` names a fmtVal formatter. `facet` names a /api/cx/facets dim and
  // `pocket` the matching "what works" dimension for this client.
  const DAYS = (list, word) => [['', 'Any time']].concat(list.map((n) => [String(n), word.replace('%', n)]));
  const GROUPS = [
    { id: 'who', title: 'Who', controls: [
      { type: 'facet', key: 'seniority', facet: 'seniority', pocket: 'seniority', label: 'Seniority', fmt: 'seniority' },
      { type: 'tags', key: 'jobTitle', exKey: 'jobTitleExclude', label: 'Job title', placeholder: 'owner, managing director…', suggest: 'job_title', chip: 'Job title' },
      { type: 'seg', key: 'hasName', label: 'Name on file', options: [['first_only', 'First name'], ['yes', 'First + last'], ['', 'Any']], chip: 'Name' },
      { type: 'facet', key: 'departmentIs', facet: 'department', label: 'Department', fmt: 'text', more: true },
      { type: 'seg', key: 'hasLinkedin', label: 'LinkedIn profile', options: [['', 'Any'], ['yes', 'Has one'], ['no', 'None']], chip: 'LinkedIn', more: true },
    ] },
    { id: 'company', title: 'Company', controls: [
      { type: 'facet', key: 'industryIs', facet: 'industry', pocket: 'industry', label: 'Industry', fmt: 'text', find: true, chip: 'Industry' },
      { type: 'facet', key: 'numEmployeesRanges', facet: 'size', pocket: 'size', label: 'Company size', fmt: 'size', order: SIZE_ORDER, chip: 'Size' },
      { type: 'tags', key: 'keywords', exKey: 'keywordsExclude', label: 'Keywords', placeholder: 'what the company does…', suggest: 'Keywords', chip: 'Keywords' },
      { type: 'sic', key: 'sicCodes', label: 'SIC code (Companies House)', chip: 'SIC' },
      { type: 'text', key: 'company', label: 'Company name or website', placeholder: 'contains…', chip: 'Company' },
      { type: 'seg', key: 'hasCompany', label: 'Company name on file', options: [['yes', 'Required'], ['', 'Any']], chip: 'Company name' },
      { type: 'tags', key: 'industryExclude', label: 'Industry words to leave out', placeholder: 'recruitment, charity…', chip: 'Not industry', ex: true, more: true },
      { type: 'tags', key: 'technologies', exKey: 'technologiesExclude', label: 'Technologies', placeholder: 'hubspot, shopify…', suggest: 'Technologies', chip: 'Tech', more: true },
      { type: 'select', key: 'chStatus', label: 'Companies House status', options: [['', 'Any'], ['active', 'Active'], ['dissolved', 'Dissolved'], ['liquidation', 'In liquidation']], chip: 'CH status', more: true },
      { type: 'select', key: 'ccodOwnsBuilding', label: 'Owns its building (Land Registry)', options: [['', 'Any'], ['yes', 'Owner'], ['no', 'Not owner'], ['checked', 'Checked'], ['unchecked', 'Not checked yet']], chip: 'Building', more: true },
      { type: 'select', key: 'adsRunsAds', label: 'Runs Google ads', options: [['', 'Any'], ['yes', 'Yes'], ['no', 'No'], ['unchecked', 'Not checked yet']], chip: 'Google ads', more: true },
    ] },
    { id: 'where', title: 'Where', controls: [
      { type: 'facet', key: 'companyCountryIs', facet: 'country', label: 'Country', fmt: 'text', chip: 'Country' },
      { type: 'facet', key: 'companyRegion', facet: 'region', pocket: 'region', label: 'Region', fmt: 'text', chip: 'Region' },
      { type: 'facet', key: 'companyCounty', facet: 'county', label: 'County', fmt: 'text', find: true, chip: 'County' },
      { type: 'tags', key: 'companyTown', exKey: 'companyTownExclude', label: 'Town or city', placeholder: 'leeds, bristol…', suggest: 'company_town', chip: 'Town' },
      { type: 'tags', key: 'companyCountyExclude', label: 'Counties to leave out', placeholder: 'greater london…', suggest: 'company_county', chip: 'Not county', ex: true, more: true },
      { type: 'seg', key: 'excludeRemote', label: 'Remote workers', options: [['', 'Include'], ['true', 'Leave out']], chip: 'Remote workers', more: true },
    ] },
    { id: 'quality', title: 'Data quality', controls: [
      { type: 'pills', key: 'tier', facet: 'tier', label: 'Quality tier', values: ['A', 'B', 'C'], chip: 'Tier',
        hint: 'A = verified, fresh, never sent. B = good, may need a verify. C = sendable but weaker.' },
      { type: 'switch', key: 'hideDead', label: 'Hide contacts that cannot be sent', hint: 'Invalid email, hard bounce or do-not-contact.', chip: 'Unsendable hidden' },
      { type: 'facet', key: 'emailStatus', facet: 'emailStatus', label: 'Verification result', fmt: 'emailStatus', chip: 'Verification' },
      { type: 'select', key: 'verifiedWithinDays', label: 'Verified in the last', options: DAYS([3, 7, 14, 30, 90], '% days'), chip: 'Verified within' },
      { type: 'facet', key: 'emailProviders', facet: 'provider', pocket: 'provider', label: 'Their email provider', fmt: 'provider', chip: 'Provider' },
      { type: 'facet', key: 'source', facet: 'source', pocket: 'source', label: 'Data source', fmt: 'source', chip: 'Source' },
      { type: 'select', key: 'importedWithinDays', label: 'Added or refreshed in the last', options: DAYS([7, 30, 60, 90, 180, 365], '% days'), chip: 'Added within' },
      { type: 'gateways', key: 'gatewayExclude', label: 'Spam gateways to avoid', chip: 'Gateways avoided', more: true },
      { type: 'tags', key: 'tags', label: 'Import tag or batch', placeholder: 'batch name…', chip: 'Tag', more: true },
    ] },
    { id: 'history', title: 'Send history', controls: [
      { type: 'switch', key: 'neverEmailed', label: 'Never emailed by anyone', chip: 'Never emailed' },
      { type: 'select', key: 'restedDays', label: 'Emailed before, but rested for', options: [['', 'Off']].concat([30, 60, 90, 180, 365].map((n) => [String(n), n + '+ days'])), chip: 'Rested' },
      { type: 'select', key: 'notEmailedDays', label: 'Nobody emailed them in the last', options: [['', 'Off']].concat([14, 30, 60, 90, 180].map((n) => [String(n), n + ' days'])), chip: 'Quiet for' },
      { type: 'seg', key: 'everLead', label: 'Became a lead before', options: [['', 'Any'], ['no', 'Leave out'], ['yes', 'Only leads']], chip: 'Past lead', more: true },
    ] },
  ];
  const CONTROLS = {};
  for (const g of GROUPS) for (const c of g.controls) { c.group = g.id; CONTROLS[c.key] = c; if (c.exKey) CONTROLS[c.exKey] = Object.assign({}, c, { key: c.exKey, isEx: true }); }

  // Presets set a few quality/history keys in one click. `family` is the set
  // of keys a preset owns: applying one clears the others first.
  const QUALITY_FAMILY = ['tier', 'emailStatus', 'importedWithinDays', 'neverEmailed', 'restedDays', 'notEmailedDays', 'verifiedWithinDays'];
  const PRESETS = [
    { id: 'ready', label: 'Ready now', tip: 'Tier A: verified safe, fresh and never sent.', family: QUALITY_FAMILY, set: { tier: 'A' } },
    { id: 'fresh', label: 'Fresh, never emailed', tip: 'Added in the last 60 days and never emailed by anyone.', family: QUALITY_FAMILY, set: { importedWithinDays: '60', neverEmailed: 'true' } },
    { id: 'verify', label: 'Needs verifying', tip: 'Recent contacts the verifier has not checked yet.', family: QUALITY_FAMILY, set: { emailStatus: 'not_verified', importedWithinDays: '60' } },
    { id: 'rested', label: 'Rested 90 days', tip: 'Verified contacts last emailed over 90 days ago.', family: QUALITY_FAMILY, set: { emailStatus: 'safe,safe_catchall', restedDays: '90' } },
    { id: 'dm', label: 'UK decision makers, 1–50', tip: 'C-suite, VP and directors at UK companies with up to 50 staff.',
      family: ['seniority', 'companyCountryIs', 'numEmployeesRanges'], set: { seniority: 'c_suite,vp,director', companyCountryIs: 'united kingdom', numEmployeesRanges: '1-10,11-50' } },
  ];

  // ── Table columns ────────────────────────────────────────────────────────
  const COLS = [
    { id: 'tier', label: '', sort: null, on: true, cell: (r) => '<span class="cx-tier ' + esc(r.tier) + '" title="' + esc(TIER_TEXT[r.tier] || '') + '">' + esc(r.tier || '') + '</span>' },
    { id: 'name', label: 'Name', sort: 'name', on: true, w: 180, cell: (r) => two(fullName(r) || '<span class="cx-dim">No name</span>', esc(r.job_title || ''), true) },
    { id: 'company', label: 'Company', sort: 'company', on: true, w: 210, cell: (r) => two(esc(r.company_name || r.company_domain || ''), esc([title(r.industry), r.company_name ? r.company_domain : ''].filter(Boolean).join(' · ')), true) },
    { id: 'size', label: 'Staff', sort: 'employees', on: true, cell: (r) => (r.num_employees == null ? '<span class="cx-dim">–</span>' : '<span class="cx-nowrap" title="On file: ' + num(r.num_employees) + '. Many sources only give a range, so the range is shown.">' + esc(sizeBucket(r.num_employees).replace('-', '–')) + '</span>') },
    { id: 'location', label: 'Location', sort: null, on: true, w: 130, cell: (r) => two(esc(r.company_town || r.city || r.company_county || ''), esc(r.company_region || r.company_country || r.country || ''), true) },
    { id: 'email', label: 'Email', sort: 'verified', on: true, w: 200, cell: (r) => two(esc(r.email), statusBadge(r), true) },
    { id: 'provider', label: 'Provider', sort: null, on: true, cell: (r) => (r.mx_provider ? esc(PROVIDER[r.mx_provider] || r.mx_provider) : '<span class="cx-dim">Not checked</span>') },
    { id: 'source', label: 'Source', sort: null, on: true, cell: (r) => esc(SOURCE[r.source] || r.source || '') },
    { id: 'last', label: 'Last emailed', sort: 'last_emailed', on: true, w: 130, cell: lastCell },
    { id: 'imported', label: 'Added', sort: 'imported', on: true, cell: (r) => (r.imported_at ? '<span class="cx-nowrap" title="' + esc(shortDate(r.imported_at)) + '">' + esc(ago(r.imported_at)) + '</span>' : '<span class="cx-dim">–</span>') },
    { id: 'seniority', label: 'Seniority', sort: null, on: false, cell: (r) => esc(r.seniority ? fmtVal.seniority(r.seniority) : '') },
    { id: 'industry', label: 'Industry', sort: 'industry', on: false, cell: (r) => esc(title(r.industry)) },
    { id: 'department', label: 'Department', sort: null, on: false, cell: (r) => esc(title(r.department)) },
    { id: 'sends', label: 'Times sent', sort: null, on: false, cell: (r) => num(r.pushed_count || 0) },
    { id: 'linkedin', label: 'LinkedIn', sort: null, on: false, cell: (r) => (r.linkedin_url ? '<a href="' + esc(safeUrl(r.linkedin_url)) + '" target="_blank" rel="noopener" data-stop>Profile</a>' : '') },
  ];
  const fullName = (r) => esc([r.first_name, r.last_name].filter(Boolean).join(' '));
  const two = (a, b) => '<div class="cx-two"><div class="a">' + a + '</div><div class="b">' + b + '</div></div>';
  const safeUrl = (u) => { const s = String(u || ''); return /^https?:\/\//i.test(s) ? s : 'https://' + s.replace(/^\/+/, ''); };

  function statusBadge(r) {
    const s = String(r.email_status || '').toLowerCase();
    const cls = { safe: 'good', safe_catchall: 'good', risky: 'warn', unknown: 'warn', invalid: 'bad' }[s] || 'mute';
    const label = STATUS[s || 'not_verified'] || s;
    const d = daysAgo(r.email_verified_at);
    const age = s && d != null ? '<span class="cx-age' + (d > 3 ? ' old' : '') + '" title="A result older than 3 days is checked again during a send">' + (d <= 0 ? 'today' : d + 'd ago') + '</span>' : '';
    return '<span class="cx-badge ' + cls + '">' + esc(label) + '</span>' + age;
  }
  function lastCell(r) {
    const mine = S.client && r.emailed_workspaces && r.emailed_workspaces[S.client];
    const top = r.last_emailed_at ? esc(ago(r.last_emailed_at)) : '<span class="cx-badge good">Never</span>';
    let sub = esc(r.last_campaign_name || '');
    if (mine) sub = '<span class="cx-badge blue">Sent by this client' + (mine.last_sent ? ' ' + esc(shortDate(mine.last_sent)) : '') + '</span>';
    return two(top, sub);
  }

  // ── State ────────────────────────────────────────────────────────────────
  const S = {
    boot: null, defaults: {},
    client: '', f: {}, sort: 'best', dir: 'desc', page: 0, tab: 'contacts',
    pageSize: store.get('pageSize', 100),
    cols: store.get('cols', null) || COLS.filter((c) => c.on).map((c) => c.id),
    compact: store.get('compact', false),
    open: new Set(store.get('open', ['who', 'company', 'quality'])),
    more: new Set(store.get('more', [])),
    rows: [], total: 0, capped: false, rules: [], resolved: null, plan: '', ms: 0,
    summary: null, send: null, sendErr: null, facets: {}, pockets: null, pocketsFor: '',
    sel: new Map(), kb: -1, busy: false, error: null, views: [], tagMode: {}, facetFind: {},
  };
  let seq = 0;
  let searchAbort = null;

  const clientName = () => { const c = (S.boot ? S.boot.clients : []).find((x) => x.id === S.client); return c ? c.name : ''; };

  function buildDefaults() {
    const d = { hideDead: 'true', hasName: 'first_only', hasCompany: 'yes' };
    const gw = (S.boot && S.boot.defaults && S.boot.defaults.excludeGateways) || [];
    if (gw.length) d.gatewayExclude = gw.join(',');
    S.defaults = d;
  }

  // URL <-> state. Only differences from the defaults are written, so a plain
  // link stays short; a default that was switched OFF is written as `key=`.
  function writeUrl() {
    const p = new URLSearchParams();
    if (S.client) p.set('client', S.client);
    if (S.sort !== 'best') p.set('sort', S.sort);
    if (S.dir !== 'desc') p.set('dir', S.dir);
    if (S.tab !== 'contacts') p.set('tab', S.tab);
    if (S.page > 0) p.set('page', String(S.page + 1));
    for (const k of Object.keys(S.f)) if (S.f[k] !== S.defaults[k]) p.set(k, S.f[k]);
    for (const k of Object.keys(S.defaults)) if (!(k in S.f)) p.set(k, '');
    const h = p.toString();
    history.replaceState(null, '', location.pathname + (h ? '#' + h : ''));
  }
  function readUrl() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    const known = new Set((S.boot && S.boot.filterKeys) || []);
    const f = Object.assign({}, S.defaults);
    S.client = ''; S.sort = 'best'; S.dir = 'desc'; S.tab = 'contacts'; S.page = 0;
    for (const [k, v] of p.entries()) {
      if (k === 'client') S.client = v;
      else if (k === 'sort') S.sort = v;
      else if (k === 'dir') S.dir = v === 'asc' ? 'asc' : 'desc';
      else if (k === 'tab') S.tab = v === 'works' ? 'works' : 'contacts';
      else if (k === 'page') S.page = Math.max(0, (parseInt(v, 10) || 1) - 1);
      else if (known.has(k)) { if (v === '') delete f[k]; else f[k] = v; }
    }
    if (S.client && !(S.boot.clients || []).some((c) => c.id === S.client)) S.client = '';
    S.f = f;
  }

  function setFilter(key, value) {
    if (value == null || value === '') delete S.f[key]; else S.f[key] = String(value);
  }
  function toggleCsv(key, value) {
    const cur = csv(S.f[key]);
    const i = cur.indexOf(value);
    if (i >= 0) cur.splice(i, 1); else cur.push(value);
    setFilter(key, cur.join(','));
  }

  // The one place a filter change lands.
  function commit(opts) {
    S.page = 0; S.kb = -1;
    writeUrl();
    renderChips();
    refreshRail();
    scheduleSearch(opts && opts.now ? 0 : 220);
  }
  const scheduleSearch = (() => { let t; return (ms) => { clearTimeout(t); t = setTimeout(runSearch, ms); }; })();

  function filterParams() {
    const p = new URLSearchParams();
    if (S.client) p.set('client', S.client);
    for (const k of Object.keys(S.f)) p.set(k, S.f[k]);
    return p;
  }

  // ── Data loading ─────────────────────────────────────────────────────────
  async function runSearch() {
    const my = ++seq;
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    S.busy = true; S.error = null;
    setBusy(true);
    const p = filterParams();
    p.set('sort', S.sort); p.set('dir', S.dir);
    p.set('limit', String(S.pageSize)); p.set('offset', String(S.page * S.pageSize));
    try {
      const d = await api('/api/cx/search?' + p.toString(), { signal: searchAbort.signal });
      if (my !== seq) return;
      S.rows = d.contacts || []; S.total = d.total || 0; S.capped = !!d.capped;
      S.rules = d.rules || []; S.plan = d.plan; S.ms = d.ms; S.unsorted = !!d.unsorted;
      S.maxOffset = d.maxOffset || 100000; S.countUnknown = !!d.countUnknown;
    } catch (e) {
      if (e.name === 'AbortError' || my !== seq) return;
      S.rows = []; S.total = 0; S.capped = false; S.error = e.message;
    }
    S.busy = false;
    setBusy(false);
    renderTable(); renderFoot(); renderChips(); renderTabs(); renderFunnel();
    if (S.error) return;
    loadSummary(my); loadFacets(my); loadSendability(my);
  }

  async function loadSummary(my) {
    S.summary = null; renderFunnel();
    try {
      const d = await api('/api/cx/summary?' + filterParams().toString());
      if (my !== seq) return;
      S.summary = d && !d.error ? d : { failed: true };
    } catch { if (my === seq) S.summary = { failed: true }; }
    renderFunnel(); renderFoot();
  }

  function wantedFacets() {
    const dims = new Set();
    for (const g of GROUPS) {
      if (!S.open.has(g.id)) continue;
      for (const c of g.controls) if (c.facet && (!c.more || S.more.has(g.id) || S.f[c.key])) dims.add(c.facet);
    }
    return [...dims];
  }
  async function loadFacets(my) {
    const dims = wantedFacets();
    if (!dims.length) return;
    const p = filterParams(); p.set('dims', dims.join(','));
    try {
      const d = await api('/api/cx/facets?' + p.toString());
      if (my !== seq) return;
      Object.assign(S.facets, d.facets || {});
      refreshRail();
    } catch { /* counts are a nicety; the list still works */ }
  }

  async function loadSendability(my) {
    S.send = null; S.sendErr = null; renderFunnel();
    if (!S.client || !S.total) return;
    try {
      const snap = await resolveNow();
      if (my !== seq) return;
      const d = await api('/api/contacts/sendability', { method: 'POST', body: { workspace_id: snap.client, workspace_name: snap.clientName, filters: snap.resolved } });
      if (my !== seq) return;
      S.send = d;
    } catch (e) { if (my === seq) S.sendErr = e.message; }
    renderFunnel();
  }

  // The filter the server would run for the page's state RIGHT NOW, with the
  // client it belongs to. Anything that feeds the push asks for this at the
  // moment it is needed instead of reusing what the last search returned: that
  // older object can be missing (search still running), stale (a filter was
  // just changed) or for a different client (client just switched).
  async function resolveNow() {
    const client = S.client;
    const name = clientName();
    const typed = Object.assign({}, S.f);
    const d = await api('/api/cx/resolve?' + filterParams().toString());
    return { client, clientName: name, typed, resolved: d.resolved || {}, rules: d.rules || [] };
  }

  async function loadPockets(force) {
    if (!S.client) { S.pockets = null; S.pocketsFor = ''; renderWorks(); refreshRail(); return; }
    if (!force && S.pocketsFor === S.client && S.pockets) return;
    const want = S.client;
    S.pocketsFor = want; S.pockets = null; renderWorks();
    try {
      const d = await api('/api/cx/pockets?client=' + encodeURIComponent(want));
      if (S.client !== want) return;
      S.pockets = d;
      // The "left to send" column needs whole-table totals that build in the
      // background on first use. Look again shortly if they were not ready.
      if (!d.supplyReady) setTimeout(() => { if (S.client === want) loadPockets(true); }, 20000);
    } catch (e) { if (S.client === want) S.pockets = { error: e.message }; }
    renderWorks(); refreshRail(); renderTabs();
  }

  function pocketFor(dim, value) {
    const p = S.pockets;
    if (!p || p.error || !p.dims || !p.dims[dim]) return null;
    return p.dims[dim].values.find((x) => x.value === value) || null;
  }

  // ── Filter rail ──────────────────────────────────────────────────────────
  function groupCount(g) {
    let n = 0;
    for (const c of g.controls) {
      if (S.f[c.key] && S.f[c.key] !== S.defaults[c.key]) n++;
      if (c.exKey && S.f[c.exKey]) n++;
    }
    return n;
  }

  function renderRail() {
    const rail = $('#rail');
    let html = '<div class="cx-presets"><div class="cx-h">Quick picks</div><div class="cx-preset-grid" id="presets"></div></div>';
    for (const g of GROUPS) {
      html += '<details class="cx-group" data-group="' + g.id + '"' + (S.open.has(g.id) ? ' open' : '') + '>' +
        '<summary><svg class="chev" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 1.5 6.5 5 3 8.5"/></svg>' +
        esc(g.title) + '<span class="n" data-gcount="' + g.id + '" hidden></span></summary><div class="cx-group-body">';
      for (const c of g.controls.filter((x) => !x.more)) html += '<div class="cx-ctl" data-ctl="' + c.key + '"></div>';
      const extra = g.controls.filter((x) => x.more);
      if (extra.length) {
        html += '<div data-moregroup="' + g.id + '"' + (S.more.has(g.id) ? '' : ' hidden') + ' style="display:grid;gap:14px">';
        for (const c of extra) html += '<div class="cx-ctl" data-ctl="' + c.key + '"></div>';
        html += '</div><button class="cx-more" data-act="more" data-group="' + g.id + '"></button>';
      }
      html += '</div></details>';
    }
    rail.innerHTML = html;
    refreshRail(true);
  }

  // Redraw every control from state. A control that currently holds the text
  // caret is left alone so typing is never interrupted.
  function refreshRail(force) {
    const rail = $('#rail');
    if (!rail.firstChild) return;
    const active = document.activeElement;
    for (const el of $$('.cx-ctl', rail)) {
      const c = CONTROLS[el.dataset.ctl];
      if (!c) continue;
      const typing = !force && active && el.contains(active) && (active.tagName === 'INPUT' && /text|search/.test(active.type));
      if (typing && c.type !== 'facet') continue;
      if (typing && c.type === 'facet') { drawFacetList(el, c); continue; }
      el.innerHTML = DRAW[c.type](c);
    }
    for (const g of GROUPS) {
      const n = groupCount(g);
      const badge = $('[data-gcount="' + g.id + '"]', rail);
      if (badge) { badge.hidden = !n; badge.textContent = n; }
      const btn = $('button[data-act="more"][data-group="' + g.id + '"]', rail);
      if (btn) btn.textContent = S.more.has(g.id) ? 'Fewer filters' : 'More filters';
      const mg = $('[data-moregroup="' + g.id + '"]', rail);
      if (mg) mg.hidden = !S.more.has(g.id);
    }
    const pr = $('#presets');
    if (pr) pr.innerHTML = PRESETS.map((p) => '<button class="cx-preset' + (presetOn(p) ? ' on' : '') + '" data-act="preset" data-id="' + p.id + '" title="' + esc(p.tip) + '">' + esc(p.label) + '</button>').join('');
  }

  const presetOn = (p) => Object.keys(p.set).every((k) => S.f[k] === p.set[k]) && p.family.every((k) => k in p.set || !(k in S.f));
  function applyPreset(p) {
    const on = presetOn(p);
    for (const k of p.family) delete S.f[k];
    if (!on) Object.assign(S.f, p.set);
    commit({ now: true });
  }

  const labelRow = (c, extra) => '<div class="lab">' + esc(c.label) + (extra || '') + '</div>';
  const clearBtn = (c) => (S.f[c.key] ? '<button class="clear" data-act="clear" data-key="' + c.key + '">Clear</button>' : '');

  function liftBadge(c, value) {
    if (!c.pocket) return '';
    const p = pocketFor(c.pocket, value);
    if (!p || p.lift == null || p.sent < 50) return '';
    const cls = p.lift >= 1.2 ? 'up' : p.lift <= 0.8 ? 'down' : 'flat';
    const tip = clientName() + ': ' + num(p.pos) + ' lead' + (p.pos === 1 ? '' : 's') + ' from ' + num(p.sent) + ' sent (' + pct(p.rate) + '). ' +
      (p.thin ? 'Early signal, small numbers.' : 'Client average is ' + pct(S.pockets.totals.rate) + '.');
    return '<span class="cx-lift ' + cls + (p.thin ? ' thin' : '') + '" title="' + esc(tip) + '">×' + p.lift.toFixed(1) + '</span>';
  }

  function facetValues(c) {
    const fac = S.facets[c.facet];
    const selected = csv(S.f[c.key]);
    let vals = fac && fac.values ? fac.values.slice() : [];
    for (const s of selected) if (!vals.some((v) => v.value === s)) vals.push({ value: s, count: null });
    if (c.order) vals.sort((a, b) => c.order.indexOf(a.value) - c.order.indexOf(b.value));
    else vals.sort((a, b) => (selected.includes(b.value) - selected.includes(a.value)) || ((b.count || 0) - (a.count || 0)));
    const find = (S.facetFind[c.key] || '').toLowerCase();
    if (find) vals = vals.filter((v) => selected.includes(v.value) || String(v.value).toLowerCase().includes(find) || String((fmtVal[c.fmt || 'raw'])(v.value)).toLowerCase().includes(find));
    return { vals, fac, selected };
  }
  function facetListHtml(c) {
    const { vals, fac, selected } = facetValues(c);
    if (!fac) return '<div class="state">Counting…</div>';
    if (fac.error && !vals.length) return '<div class="state">Counts are not available right now.</div>';
    if (!vals.length) return '<div class="state">Nothing matches.</div>';
    const max = Math.max(1, ...vals.map((v) => v.count || 0));
    const f = fmtVal[c.fmt || 'raw'];
    return vals.map((v) => {
      const on = selected.includes(v.value);
      return '<label class="cx-fv' + (on ? ' on' : '') + '">' +
        '<input type="checkbox" data-act="facet" data-key="' + c.key + '" data-val="' + esc(v.value) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="name" title="' + esc(f(v.value)) + '">' + esc(f(v.value)) + '</span>' + liftBadge(c, v.value) +
        '<span class="cnt">' + (v.count == null ? '' : (fac.approx ? '~' : '') + num(v.count)) + '</span>' +
        '<span class="bar"><i style="width:' + Math.round(((v.count || 0) / max) * 100) + '%"></i></span></label>';
    }).join('');
  }
  function drawFacetList(el, c) { const box = $('.cx-facet', el); if (box) box.innerHTML = facetListHtml(c); }

  const DRAW = {
    facet(c) {
      return labelRow(c, clearBtn(c)) +
        (c.find ? '<input class="cx-input cx-facet-find" type="search" placeholder="Find…" data-act="facetfind" data-key="' + c.key + '" value="' + esc(S.facetFind[c.key] || '') + '">' : '') +
        '<div class="cx-facet">' + facetListHtml(c) + '</div>';
    },
    pills(c) {
      const sel = csv(S.f[c.key]);
      const fac = S.facets[c.facet];
      const cnt = (v) => { const x = fac && fac.values && fac.values.find((y) => y.value === v); return x ? '<span class="cnt">' + (fac.approx ? '~' : '') + num(x.count) + '</span>' : ''; };
      return labelRow(c, clearBtn(c)) + '<div class="cx-pills">' + c.values.map((v) =>
        '<button class="cx-pill' + (sel.includes(v) ? ' on' : '') + '" data-act="pill" data-key="' + c.key + '" data-val="' + v + '" title="' + esc(TIER_TEXT[v] || '') + '">' +
        '<span class="cx-tier ' + v + '">' + v + '</span>' + cnt(v) + '</button>').join('') + '</div>' + (c.hint ? '<div class="hint">' + esc(c.hint) + '</div>' : '');
    },
    tags(c) {
      const mode = c.ex ? 'ex' : (S.tagMode[c.key] || 'in');
      const tags = csv(S.f[c.key]).map((v) => '<span class="cx-tag' + (c.ex ? ' ex' : '') + '">' + esc(v) + '<button data-act="untag" data-key="' + c.key + '" data-val="' + esc(v) + '" aria-label="Remove">×</button></span>').join('');
      const ex = c.exKey ? csv(S.f[c.exKey]).map((v) => '<span class="cx-tag ex" title="Left out">' + esc(v) + '<button data-act="untag" data-key="' + c.exKey + '" data-val="' + esc(v) + '" aria-label="Remove">×</button></span>').join('') : '';
      const toggle = c.exKey ? '<span class="cx-tagmode"><button class="' + (mode === 'in' ? 'on' : '') + '" data-act="tagmode" data-key="' + c.key + '" data-mode="in">Include</button><button class="' + (mode === 'ex' ? 'on ex' : '') + '" data-act="tagmode" data-key="' + c.key + '" data-mode="ex">Leave out</button></span>' : '';
      return labelRow(c, toggle) + '<div class="cx-tags" data-focus>' + tags + ex +
        '<input type="text" data-act="tag" data-key="' + c.key + '" placeholder="' + esc(c.placeholder || 'type, then Enter') + '"' + (c.suggest ? ' list="dl-' + c.key + '" data-suggest="' + c.suggest + '"' : '') + ' autocomplete="off"></div>' +
        (c.suggest ? '<datalist id="dl-' + c.key + '"></datalist>' : '');
    },
    sic(c) {
      const tags = csv(S.f[c.key]).map((v) => '<span class="cx-tag">' + esc(v) + '<button data-act="untag" data-key="' + c.key + '" data-val="' + esc(v) + '" aria-label="Remove">×</button></span>').join('');
      return labelRow(c) + '<div class="cx-tags" data-focus>' + tags +
        '<input type="text" data-act="sic" data-key="' + c.key + '" placeholder="care home, 43, 87300…" list="dl-sic" autocomplete="off"></div><datalist id="dl-sic"></datalist>' +
        '<div class="hint">A short code covers everything under it: 43 = all specialised construction.</div>';
    },
    text(c) {
      return labelRow(c) + '<input class="cx-input" type="text" data-act="text" data-key="' + c.key + '" placeholder="' + esc(c.placeholder || '') + '" value="' + esc(S.f[c.key] || '') + '">';
    },
    select(c) {
      const cur = S.f[c.key] || '';
      return labelRow(c) + '<select class="cx-select" data-act="select" data-key="' + c.key + '">' + c.options.map(([v, l]) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';
    },
    seg(c) {
      const cur = S.f[c.key] || '';
      return labelRow(c) + '<div class="cx-seg">' + c.options.map(([v, l]) => '<button class="' + (v === cur ? 'on' : '') + '" data-act="seg" data-key="' + c.key + '" data-val="' + esc(v) + '">' + esc(l) + '</button>').join('') + '</div>';
    },
    switch(c) {
      return '<label class="cx-switch"><input type="checkbox" data-act="switch" data-key="' + c.key + '"' + (S.f[c.key] === 'true' ? ' checked' : '') + '><span>' + esc(c.label) + '</span></label>' + (c.hint ? '<div class="hint">' + esc(c.hint) + '</div>' : '');
    },
    gateways(c) {
      const sel = csv(S.f[c.key]);
      const all = [...new Set([...(S.boot.gateways || []).map((g) => g.value), ...((S.boot.defaults && S.boot.defaults.excludeGateways) || []), ...sel])];
      if (!all.length) return labelRow(c) + '<div class="hint">No gateway data yet.</div>';
      return labelRow(c, clearBtn(c)) + '<div class="cx-facet">' + all.map((g) => '<label class="cx-fv' + (sel.includes(g) ? ' on' : '') + '"><input type="checkbox" data-act="facet" data-key="' + c.key + '" data-val="' + esc(g) + '"' + (sel.includes(g) ? ' checked' : '') + '><span class="name">' + esc(g) + '</span><span></span><span class="cnt"></span></label>').join('') + '</div>' +
        '<div class="hint">Ticked gateways are left out. Contacts with an unknown gateway are kept.</div>';
    },
  };

  const suggestCache = {};
  async function loadSuggest(input) {
    const field = input.dataset.suggest;
    const dl = input.list;
    if (!field || !dl || dl.dataset.loaded) return;
    dl.dataset.loaded = '1';
    try {
      if (!suggestCache[field]) suggestCache[field] = api('/api/contacts/distinct-values?field=' + encodeURIComponent(field) + '&limit=1500').then((d) => d.values || []);
      const vals = await suggestCache[field];
      dl.innerHTML = vals.slice(0, 1500).map((v) => '<option value="' + esc(typeof v === 'string' ? v : (v.value || '')) + '">').join('');
    } catch { /* suggestions are optional */ }
  }
  const sicLookup = debounce(async (input) => {
    try {
      const d = await api('/api/contacts/sic-search?q=' + encodeURIComponent(input.value.trim()));
      const dl = $('#dl-sic');
      if (dl) dl.innerHTML = (d.results || []).map((r) => '<option value="' + esc(r.code) + '">' + esc(r.code + ' ' + r.label) + '</option>').join('');
    } catch { /* optional */ }
  }, 200);

  function addTag(input) {
    const c = CONTROLS[input.dataset.key];
    const parts = input.value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const mode = c.ex ? 'in' : (S.tagMode[c.key] || 'in');
    const key = mode === 'ex' && c.exKey ? c.exKey : c.key;
    const cur = csv(S.f[key]);
    for (const p of parts) if (!cur.some((x) => x.toLowerCase() === p.toLowerCase())) cur.push(p);
    setFilter(key, cur.join(','));
    input.value = '';
    commit({ now: true });
    const again = $('.cx-ctl[data-ctl="' + c.key + '"] input[data-act]');
    if (again) again.focus();
  }

  function bindRail() {
    const rail = $('#rail');
    rail.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t) { const box = e.target.closest('[data-focus]'); if (box) { const i = $('input', box); if (i) i.focus(); } return; }
      const act = t.dataset.act; const key = t.dataset.key;
      if (act === 'preset') applyPreset(PRESETS.find((p) => p.id === t.dataset.id));
      else if (act === 'clear') { delete S.f[key]; commit({ now: true }); }
      else if (act === 'pill') { toggleCsv(key, t.dataset.val); commit({ now: true }); }
      else if (act === 'seg') { setFilter(key, t.dataset.val); commit({ now: true }); }
      else if (act === 'untag') { toggleCsv(key, t.dataset.val); commit({ now: true }); }
      else if (act === 'tagmode') { S.tagMode[key] = t.dataset.mode; refreshRail(true); const i = $('.cx-ctl[data-ctl="' + key + '"] input'); if (i) i.focus(); }
      else if (act === 'more') {
        const g = t.dataset.group;
        if (S.more.has(g)) S.more.delete(g); else S.more.add(g);
        store.set('more', [...S.more]); refreshRail(true); loadFacets(seq);
      }
    });
    rail.addEventListener('change', (e) => {
      const t = e.target; const act = t.dataset && t.dataset.act; const key = t.dataset && t.dataset.key;
      if (act === 'facet') { toggleCsv(key, t.dataset.val); commit({ now: true }); }
      else if (act === 'select') { setFilter(key, t.value); commit({ now: true }); }
      else if (act === 'switch') { setFilter(key, t.checked ? 'true' : ''); commit({ now: true }); }
      else if (act === 'tag' && t.value.trim() && t.list && [...t.list.options].some((o) => o.value === t.value)) addTag(t);
      else if (act === 'sic' && /^\d+$/.test(t.value.trim())) addTag(t);
    });
    rail.addEventListener('input', (e) => {
      const t = e.target; const act = t.dataset && t.dataset.act; const key = t.dataset && t.dataset.key;
      if (act === 'text') { setFilter(key, t.value.trim()); S.page = 0; writeUrl(); renderChips(); scheduleSearch(350); }
      else if (act === 'facetfind') { S.facetFind[key] = t.value; drawFacetList(t.closest('.cx-ctl'), CONTROLS[key]); }
      else if (act === 'sic') sicLookup(t);
    });
    rail.addEventListener('keydown', (e) => {
      const t = e.target; const act = t.dataset && t.dataset.act;
      if ((act === 'tag' || act === 'sic') && (e.key === 'Enter' || e.key === ',')) { e.preventDefault(); addTag(t); }
      else if ((act === 'tag' || act === 'sic') && e.key === 'Backspace' && !t.value) {
        const c = CONTROLS[t.dataset.key]; const cur = csv(S.f[c.key]);
        if (cur.length) { cur.pop(); setFilter(c.key, cur.join(',')); commit({ now: true }); const i = $('.cx-ctl[data-ctl="' + c.key + '"] input'); if (i) i.focus(); }
      }
    });
    rail.addEventListener('focusin', (e) => { if (e.target.dataset && e.target.dataset.suggest) loadSuggest(e.target); });
    rail.addEventListener('toggle', (e) => {
      const d = e.target.closest && e.target.closest('details[data-group]');
      if (!d) return;
      if (d.open) S.open.add(d.dataset.group); else S.open.delete(d.dataset.group);
      store.set('open', [...S.open]);
      if (d.open) loadFacets(seq);
    }, true);
  }

  // ── Chips: every active filter, visible ──────────────────────────────────
  function chipText(key) {
    const c = CONTROLS[key];
    const raw = S.f[key];
    if (!c) return { label: key, value: raw };
    const label = (c.isEx ? 'Not ' + (c.chip || c.label).toLowerCase() : (c.chip || c.label));
    if (c.type === 'switch') return { label, value: '' };
    if (c.type === 'seg' || c.type === 'select') {
      const o = c.options.find(([v]) => v === raw);
      return { label, value: o ? o[1] : raw };
    }
    const f = fmtVal[c.fmt || 'raw'];
    const vals = csv(raw).map((v) => (c.type === 'facet' ? f(v) : v));
    if (c.type === 'gateways') return { label, value: vals.length + (vals.length === 1 ? ' gateway' : ' gateways') };
    return { label, value: vals.length > 2 ? vals.slice(0, 2).join(', ') + ' +' + (vals.length - 2) : vals.join(', ') };
  }
  function renderChips() {
    const el = $('#chips');
    const parts = [];
    if (S.f.search) parts.push('<span class="cx-chip"><b>Search</b><span>' + esc(S.f.search) + '</span><button data-chip="search" aria-label="Remove">×</button></span>');
    for (const key of Object.keys(S.f)) {
      if (key === 'search') continue;
      const { label, value } = chipText(key);
      const c = CONTROLS[key];
      const cls = (S.f[key] === S.defaults[key] ? ' def' : '') + (c && (c.isEx || c.ex) ? ' ex' : '');
      parts.push('<span class="cx-chip' + cls + '" title="' + esc(label + (value ? ': ' + csv(S.f[key]).join(', ') : '')) + '"><b>' + esc(label) + '</b>' + (value ? '<span>' + esc(value) + '</span>' : '') + '<button data-chip="' + esc(key) + '" aria-label="Remove ' + esc(label) + '">×</button></span>');
    }
    for (const r of S.rules || []) {
      parts.push('<span class="cx-chip lock' + (r.atPush ? ' push' : '') + '" title="' + esc((r.atPush ? 'Checked when sending. ' : 'Set on the client record. ') + (r.detail || '')) + '">🔒 ' + esc(r.label) + '</span>');
    }
    const changed = Object.keys(S.f).some((k) => S.f[k] !== S.defaults[k]) || Object.keys(S.defaults).some((k) => !(k in S.f));
    el.innerHTML = (parts.length ? parts.join('') : '<span class="none">No filters. Showing everything.</span>') +
      (changed ? '<button class="reset" data-chip-reset>Reset filters</button>' : '');
  }
  function bindChips() {
    $('#chips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-chip]');
      if (b) { delete S.f[b.dataset.chip]; if (b.dataset.chip === 'search') $('#q').value = ''; commit({ now: true }); return; }
      if (e.target.closest('[data-chip-reset]')) { S.f = Object.assign({}, S.defaults); $('#q').value = ''; S.facetFind = {}; commit({ now: true }); }
    });
  }

  // ── Funnel ───────────────────────────────────────────────────────────────
  function renderFunnel() {
    const el = $('#funnel');
    const sm = S.summary && !S.summary.failed ? S.summary : null;
    const approx = sm && sm.approx ? '~' : '';
    const matched = S.capped ? (sm ? approx + num(sm.matched) : (S.countUnknown ? 'Many' : num(S.total) + '+')) : num(S.total);
    const step = (k, v, s, cls) => '<div class="cx-step ' + (cls || '') + '"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + (s || '&nbsp;') + '</div></div>';
    let html = step('Matching contacts', S.busy && !S.rows.length ? '…' : matched, sm && sm.companies != null ? num(sm.companies) + ' companies' : (sm && sm.approx ? 'estimated from a sample' : ''));
    html += step('Verified safe', sm ? approx + num(sm.verified) : '…', sm ? approx + num(sm.verifiedFresh) + ' checked in the last ' + sm.freshVerdictDays + ' days' : '');
    html += step('Not verified yet', sm ? approx + num(sm.unverified) : '…', 'checked during the send');
    if (!S.client) {
      html += step('Ready to send', 'Choose a client', 'to see who can be sent today', 'ready none');
    } else if (S.sendErr) {
      html += step('Ready for ' + esc(clientName()), 'Not available', esc(S.sendErr), 'ready none');
    } else if (!S.send) {
      html += step('Ready for ' + esc(clientName()), S.total ? '…' : '0', S.total ? 'checking the send rules' : '', 'ready' + (S.total ? '' : ' zero'));
    } else if (!S.send.checked) {
      html += step('Ready for ' + esc(clientName()), 'Unknown', '', 'ready none');
    } else {
      const n = S.send.sendableTotal;
      const held = S.send.checked ? Math.round((1 - S.send.sendable / S.send.checked) * 100) : 0;
      html += step('Ready for ' + esc(clientName()), (S.send.estimated ? '~' : '') + num(n),
        held > 0 ? held + '% held back by send rules. <button class="why" data-act="why">See why</button>' : 'passes every send rule', 'ready' + (n ? '' : ' zero'));
    }
    html += '<div class="grow"></div><div class="cx-actions">' +
      '<button class="cx-btn primary" data-act="send"' + (S.client ? '' : ' disabled title="Choose a client first"') + '>Send to a campaign</button></div>';
    el.innerHTML = html;
  }

  // ── Tabs row ─────────────────────────────────────────────────────────────
  const SORT_LABEL = { best: 'Best first', imported: 'Newest added', last_emailed: 'Last emailed', verified: 'Verified date', employees: 'Staff', company: 'Company', name: 'Name', industry: 'Industry', title: 'Job title' };
  function renderTabs() {
    const el = $('#tabs');
    const works = S.pockets && !S.pockets.error && S.pockets.totals && S.pockets.totals.positives > 0;
    let right = '';
    if (S.tab === 'contacts') {
      if (S.sel.size) {
        right = '<div class="cx-selbar">' + num(S.sel.size) + ' ticked <button class="cx-btn sm primary" data-act="send-sel"' + (S.client ? '' : ' disabled title="Choose a client first"') + '>Send these</button><button class="cx-btn sm" data-act="clear-sel">Clear</button></div>';
      }
      right += '<label>Sort <select data-act="sort">' + Object.keys(SORT_LABEL).filter((k) => ['best', 'imported', 'last_emailed', 'verified', 'employees', 'company', 'name'].includes(k) || k === S.sort)
        .map((k) => '<option value="' + k + '"' + (k === S.sort ? ' selected' : '') + '>' + SORT_LABEL[k] + '</option>').join('') + '</select></label>';
    }
    el.innerHTML = '<button class="cx-tab' + (S.tab === 'contacts' ? ' on' : '') + '" data-tab="contacts">Contacts</button>' +
      '<button class="cx-tab' + (S.tab === 'works' ? ' on' : '') + '" data-tab="works">What works' + (S.client ? ' for ' + esc(clientName()) : '') + (works ? '<span class="dot"></span>' : '') + '</button>' +
      '<div class="grow"></div><div class="meta">' + right + '</div>';
    $('#tablewrap').hidden = S.tab !== 'contacts';
    $('#works').hidden = S.tab !== 'works';
    $('#foot').hidden = S.tab !== 'contacts';
  }

  // ── Table ────────────────────────────────────────────────────────────────
  function setBusy(on) {
    const w = $('#tablewrap');
    w.classList.toggle('busy', on);
    let bar = $('.cx-loading', w);
    if (on && !bar) { bar = document.createElement('div'); bar.className = 'cx-loading'; w.prepend(bar); }
    if (!on && bar) bar.remove();
  }
  function visibleCols() { return COLS.filter((c) => S.cols.includes(c.id)); }

  function renderTable() {
    const w = $('#tablewrap');
    const cols = visibleCols();
    if (S.error) {
      w.innerHTML = '<div class="cx-state"><h3>The search did not finish</h3><p>' + esc(S.error) + '</p><button class="cx-btn" data-act="retry">Try again</button></div>';
      return;
    }
    if (!S.rows.length && !S.busy) {
      const active = Object.keys(S.f).filter((k) => S.f[k] !== S.defaults[k]).length;
      w.innerHTML = '<div class="cx-state"><h3>No contacts match</h3><p>' +
        (S.rules.length ? 'The client’s own rules (the locked chips above) are part of this. ' : '') +
        (active ? 'Remove a filter to widen the search.' : 'Try turning off a default filter above.') + '</p>' +
        (active ? '<button class="cx-btn" data-chip-reset>Reset filters</button>' : '') + '</div>';
      return;
    }
    const pageIds = S.rows.map((r) => r.id);
    const allSel = pageIds.length && pageIds.every((id) => S.sel.has(id));
    let html = '<table class="cx-table' + (S.compact ? ' compact' : '') + '"><thead><tr><th class="chk"><input type="checkbox" data-act="selpage"' + (allSel ? ' checked' : '') + ' aria-label="Tick this page"></th>';
    for (const c of cols) {
      const on = c.sort && c.sort === S.sort;
      html += '<th' + (c.sort ? ' class="sortable" data-sort="' + c.sort + '"' : '') + (c.w ? ' style="min-width:' + c.w + 'px"' : '') + (c.sort ? ' title="Sort by ' + esc(c.label.toLowerCase()) + '"' : '') + '>' + esc(c.label) + (on ? '<span class="arrow">' + (S.dir === 'asc' ? '▲' : '▼') + '</span>' : '') + '</th>';
    }
    html += '</tr></thead><tbody>';
    if (!S.rows.length) {
      for (let i = 0; i < 12; i++) html += '<tr class="cx-skel"><td></td>' + cols.map(() => '<td><div style="width:' + (40 + ((i * 37) % 50)) + '%"></div></td>').join('') + '</tr>';
    }
    S.rows.forEach((r, i) => {
      html += '<tr class="row' + (S.sel.has(r.id) ? ' sel' : '') + (i === S.kb ? ' kb' : '') + '" data-i="' + i + '"><td class="chk"><input type="checkbox" data-act="selrow"' + (S.sel.has(r.id) ? ' checked' : '') + ' aria-label="Tick"></td>';
      for (const c of cols) html += '<td>' + c.cell(r) + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    w.innerHTML = html;
    if (S.busy) setBusy(true);
  }

  function renderFoot() {
    const el = $('#foot');
    const from = S.total ? S.page * S.pageSize + 1 : 0;
    const to = S.page * S.pageSize + S.rows.length;
    const sm = S.summary && !S.summary.failed ? S.summary : null;
    const of = S.capped ? (sm ? (sm.approx ? 'about ' : '') + num(sm.matched) : num(S.total) + '+') : num(S.total);
    const last = (!S.capped && to >= S.total) || (S.page + 1) * S.pageSize > (S.maxOffset || 100000);
    el.innerHTML = '<span>' + (S.total ? num(from) + '–' + num(to) + ' of ' + of : 'No results') + '</span>' +
      '<button class="cx-btn sm" data-act="prev"' + (S.page ? '' : ' disabled') + '>Previous</button>' +
      '<button class="cx-btn sm" data-act="next"' + (last || S.rows.length < S.pageSize ? ' disabled' : '') + '>Next</button>' +
      '<label>Rows <select data-act="pagesize">' + [50, 100, 250, 500].map((n) => '<option' + (n === S.pageSize ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></label>' +
      '<span class="grow"></span><span><kbd>/</kbd> search &nbsp; <kbd>↑</kbd><kbd>↓</kbd> move &nbsp; <kbd>Enter</kbd> open &nbsp; <kbd>X</kbd> tick &nbsp; <kbd>Esc</kbd> close</span>' +
      (S.unsorted ? '<span class="cx-low" title="Sorting this many contacts took too long, so this page is unsorted. Add a filter and the order comes back.">Not sorted: too many matches</span>' : '') +
      (S.ms ? '<span title="Server time for the list">' + S.ms + ' ms</span>' : '');
  }

  function goPage(n) {
    S.page = Math.max(0, n); S.kb = -1;
    writeUrl(); runSearch();
    $('#tablewrap').scrollTop = 0;
  }

  function bindMain() {
    const main = $('.cx-main');
    main.addEventListener('click', (e) => {
      if (e.target.closest('[data-chip-reset]') && !e.target.closest('#chips')) { S.f = Object.assign({}, S.defaults); $('#q').value = ''; commit({ now: true }); return; }
      const tab = e.target.closest('[data-tab]');
      if (tab) { S.tab = tab.dataset.tab; writeUrl(); renderTabs(); if (S.tab === 'works') { loadPockets(); renderWorks(); } return; }
      const th = e.target.closest('th[data-sort]');
      if (th) {
        if (S.sort === th.dataset.sort) S.dir = S.dir === 'asc' ? 'desc' : 'asc';
        else { S.sort = th.dataset.sort; S.dir = ['name', 'company', 'industry', 'title'].includes(S.sort) ? 'asc' : 'desc'; }
        goPage(0); renderTabs(); return;
      }
      const act = e.target.closest('[data-act]');
      if (act) {
        const a = act.dataset.act;
        if (a === 'selpage') {
          const on = act.checked;
          for (const r of S.rows) { if (on) S.sel.set(r.id, r); else S.sel.delete(r.id); }
          renderTable(); renderTabs(); return;
        }
        if (a === 'selrow') { const r = S.rows[+act.closest('tr').dataset.i]; toggleSel(r); return; }
        if (a === 'prev') return goPage(S.page - 1);
        if (a === 'next') return goPage(S.page + 1);
        if (a === 'retry') return runSearch();
        if (a === 'send') return openSend(false);
        if (a === 'send-sel') return openSend(true);
        if (a === 'clear-sel') { S.sel.clear(); renderTable(); renderTabs(); return; }
        if (a === 'why') return openWhy();
        if (a === 'use-pocket') return usePocket(act.dataset.key, act.dataset.val);
        if (a === 'use-campaign') return useCampaign(act.dataset.id, act.dataset.name);
        if (a === 'works-refresh') return loadPockets(true);
        return;
      }
      if (e.target.closest('[data-stop]') || e.target.closest('a')) return;
      const tr = e.target.closest('tr.row');
      if (tr && !e.target.closest('.chk')) { S.kb = +tr.dataset.i; markKb(); openDrawer(S.rows[S.kb]); }
    });
    main.addEventListener('change', (e) => {
      const a = e.target.dataset && e.target.dataset.act;
      if (a === 'sort') { S.sort = e.target.value; S.dir = ['name', 'company'].includes(S.sort) ? 'asc' : 'desc'; goPage(0); }
      else if (a === 'pagesize') { S.pageSize = +e.target.value; store.set('pageSize', S.pageSize); goPage(0); }
    });
  }
  function toggleSel(r) {
    if (!r) return;
    if (S.sel.has(r.id)) S.sel.delete(r.id); else S.sel.set(r.id, r);
    renderTable(); renderTabs();
  }
  function markKb() {
    $$('#tablewrap tr.row').forEach((tr) => tr.classList.toggle('kb', +tr.dataset.i === S.kb));
    const cur = $('#tablewrap tr.row.kb');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  // ── What works (pockets) ─────────────────────────────────────────────────
  function renderWorks() {
    const el = $('#works');
    if (!S.client) {
      el.innerHTML = '<div class="cx-state"><h3>Choose a client</h3><p>This tab shows which kinds of contact have turned into leads for a client, and how many of each are left to send.</p></div>';
      return;
    }
    const p = S.pockets;
    if (!p) { el.innerHTML = '<div class="cx-state"><p>Working out what has worked for ' + esc(clientName()) + '…</p></div>'; return; }
    if (p.error) { el.innerHTML = '<div class="cx-state"><h3>Could not load this</h3><p>' + esc(p.error) + '</p><button class="cx-btn" data-act="works-refresh">Try again</button></div>'; return; }
    if (!p.totals.sent) { el.innerHTML = '<div class="cx-state"><h3>Nothing sent yet</h3><p>No contacts in this database have been sent to ' + esc(clientName()) + ' yet, so there is nothing to learn from.</p></div>'; return; }

    const avg = p.totals.rate;
    let html = '<div class="cx-card"><header><h3>' + esc(clientName()) + ' so far</h3><p>A lead is a reply marked as a lead, or read as interested or a question.</p><span class="grow"></span><button class="cx-btn sm" data-act="works-refresh">Refresh</button></header>' +
      '<div class="cx-kpis"><div class="cx-kpi"><div class="k">Contacts sent</div><div class="v">' + num(p.totals.sent) + '</div></div>' +
      '<div class="cx-kpi"><div class="k">Leads</div><div class="v">' + num(p.totals.positives) + '</div></div>' +
      '<div class="cx-kpi"><div class="k">Lead rate</div><div class="v">' + pct(avg) + '</div></div></div>';

    // Winners that are nearly used up: the shopping list.
    const low = [];
    for (const dk of Object.keys(p.dims)) {
      if (dk === 'provider' || dk === 'source') continue;
      for (const v of p.dims[dk].values) {
        if (!v.thin && v.lift >= 1.2 && v.unsent != null && v.unsent < Math.max(400, v.sent * 0.25)) low.push({ dk, v });
      }
    }
    if (low.length) {
      html += '<div class="cx-callout"><b>Running low on what works.</b> These beat ' + esc(clientName()) + '’s average but have few contacts left. They are the first things to buy more of.<ul>' +
        low.slice(0, 6).map(({ dk, v }) => '<li>' + esc(p.dims[dk].label) + ': <b>' + esc(dimLabel(dk, v.value)) + '</b>, ' + pct(v.rate) + ' lead rate, about ' + num(v.unsent) + ' left</li>').join('') + '</ul></div>';
    }
    html += '</div><div class="cx-works-grid">';

    for (const dk of Object.keys(p.dims)) {
      const d = p.dims[dk];
      const rows = d.values.filter((v) => v.sent >= 50).slice(0, 14);
      if (!rows.length) continue;
      const maxRate = Math.max(...rows.map((v) => v.rate), avg, 0.000001);
      html += '<div class="cx-card"><header><h3>' + esc(d.label) + '</h3><p>best first</p></header><div class="scroll"><table class="cx-ptable"><thead><tr><th></th><th>Sent</th><th>Leads</th><th>Lead rate</th><th>vs average</th><th>Left to send</th></tr></thead><tbody>';
      for (const v of rows) {
        const on = csv(S.f[d.filterKey]).includes(v.value);
        const cls = v.lift >= 1.2 ? 'up' : v.lift <= 0.8 ? 'down' : 'flat';
        const lowLeft = v.unsent != null && v.unsent < Math.max(400, v.sent * 0.25);
        html += '<tr class="' + (v.thin ? 'thin' : '') + '"><td title="' + esc(dimLabel(dk, v.value)) + '">' +
          '<button class="cx-add' + (on ? ' on' : '') + '" data-act="use-pocket" data-key="' + d.filterKey + '" data-val="' + esc(v.value) + '" title="' + (on ? 'Remove from the filter' : 'Add to the filter') + '" aria-label="' + (on ? 'Remove from' : 'Add to') + ' the filter">' + (on ? '✓' : '+') + '</button>' + esc(dimLabel(dk, v.value)) + '</td>' +
          '<td>' + num(v.sent) + '</td><td>' + num(v.pos) + '</td>' +
          '<td><span class="cx-meter"><i style="width:' + Math.round((v.rate / maxRate) * 100) + '%"></i></span>' + pct(v.rate) + '</td>' +
          '<td><span class="cx-lift ' + cls + (v.thin ? ' thin' : '') + '"' + (v.thin ? ' title="Small numbers. Treat as an early signal."' : '') + '>×' + (v.lift == null ? '–' : v.lift.toFixed(1)) + '</span></td>' +
          '<td class="' + (lowLeft ? 'cx-low' : '') + '">' + (v.unsent == null ? '<span class="cx-dim">counting…</span>' : '~' + num(v.unsent)) + '</td></tr>';
      }
      html += '</tbody></table></div></div>';
    }
    html += '</div><div class="cx-note" style="border:0;padding:0 2px">“vs average” compares each row with this client’s own lead rate. It is pulled towards 1.0 when a row has few sends, so a lucky handful cannot top the list. Grey rows have too little data to trust alone. “Left to send” is an estimate.</div>';

    const camps = (p.campaigns || []).filter((c) => c.sent >= 30);
    if (camps.length) {
      html += '<div class="cx-card"><header><h3>Campaigns</h3><p>contacts from this database pushed into each campaign</p></header><table class="cx-ptable"><thead><tr><th></th><th>Sent</th><th>Leads</th><th>Lead rate</th><th>vs average</th><th>Last push</th><th></th></tr></thead><tbody>';
      for (const c of camps.slice(0, 25)) {
        const cls = c.lift >= 1.2 ? 'up' : c.lift <= 0.8 ? 'down' : 'flat';
        html += '<tr><td title="' + esc(c.campaign_name) + '">' + esc(c.campaign_name) + '</td><td>' + num(c.sent) + '</td><td>' + num(c.pos) + '</td><td>' + pct(c.rate) + '</td>' +
          '<td><span class="cx-lift ' + cls + '">×' + (c.lift == null ? '–' : c.lift.toFixed(1)) + '</span></td><td>' + esc(c.last_pushed ? shortDate(c.last_pushed) : '') + '</td>' +
          '<td class="act">' + (c.hasSavedFilter ? '<button class="cx-btn sm" data-act="use-campaign" data-id="' + esc(c.campaign_id) + '" data-name="' + esc(c.campaign_name) + '">Use its filter</button>' : '<span class="cx-dim">no saved filter</span>') + '</td></tr>';
      }
      html += '</tbody></table><div class="cx-note">“Use its filter” loads the filter that was saved when that campaign was pushed, so you can see how many of the same kind are left.</div></div>';
    }
    el.innerHTML = html;
  }
  function dimLabel(dk, v) {
    if (dk === 'seniority') return fmtVal.seniority(v);
    if (dk === 'provider') return fmtVal.provider(v);
    if (dk === 'source') return fmtVal.source(v);
    if (dk === 'size') return fmtVal.size(v);
    return title(v);
  }
  function usePocket(key, val) {
    toggleCsv(key, val);
    const c = CONTROLS[key];
    if (c) { S.open.add(c.group); store.set('open', [...S.open]); }
    renderRail(); commit({ now: true }); renderWorks();
    toast(csv(S.f[key]).includes(val) ? 'Added to the filter' : 'Removed from the filter');
  }
  async function useCampaign(id, name) {
    try {
      const d = await api('/api/cx/campaign-filter?client=' + encodeURIComponent(S.client) + '&campaign=' + encodeURIComponent(id));
      S.f = Object.assign({}, d.filters || {});
      if (!('hideDead' in S.f)) S.f.hideDead = 'true';
      $('#q').value = S.f.search || '';
      S.tab = 'contacts';
      renderRail(); renderTabs(); commit({ now: true });
      toast('Loaded the filter from “' + name + '”');
    } catch (e) { toast(e.message, true); }
  }

  // ── Row drawer ───────────────────────────────────────────────────────────
  function closeDrawer() { const d = $('#drawer'); d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); }
  function tierReasons(c) {
    const st = String(c.email_status || '').toLowerCase();
    const out = [];
    if (st === 'invalid') out.push('The verifier says this address is invalid.');
    if (String(c.bounce_type || '').toLowerCase() === 'hard') out.push('It hard bounced.');
    if (c.do_not_contact) out.push('It is marked do not contact.');
    if (out.length) return out;
    out.push(st === 'safe' || st === 'safe_catchall' ? 'Verified safe' + (c.email_verified_at ? ' ' + ago(c.email_verified_at) : '') + '.' : st ? 'Verifier result: ' + (STATUS[st] || st) + '.' : 'Not verified yet. It is checked during a send.');
    const pushed = Array.isArray(c.pushed_campaigns) ? c.pushed_campaigns.length : 0;
    out.push(pushed ? 'Sent ' + pushed + ' time' + (pushed === 1 ? '' : 's') + (c.last_emailed_at ? ', last ' + ago(c.last_emailed_at) : '') + '.' : 'Never sent to any client.');
    const d = daysAgo(c.imported_at);
    out.push(d == null ? 'No import date on file.' : 'Added or refreshed ' + ago(c.imported_at) + (d > 60 ? ' (older than 60 days).' : '.'));
    if (!String(c.first_name || '').trim()) out.push('No first name.');
    return out;
  }
  async function openDrawer(row) {
    if (!row) return;
    const el = $('#drawer');
    el.classList.add('open'); el.setAttribute('aria-hidden', 'false');
    el.innerHTML = '<header><span class="cx-tier ' + esc(row.tier) + '">' + esc(row.tier) + '</span><div><h2>' + (fullName(row) || esc(row.email)) + '</h2><p>' + esc([row.job_title, row.company_name].filter(Boolean).join(' at ')) + '</p></div><button class="x" data-act="close" aria-label="Close">×</button></header><div class="body"><div class="cx-state">Loading…</div></div>';
    let c, facts = [];
    try { const d = await api('/api/cx/contact/' + row.id); c = d.contact; facts = d.facts || []; }
    catch (e) { $('.body', el).innerHTML = '<div class="cx-state"><p>' + esc(e.message) + '</p></div>'; return; }
    if (!el.classList.contains('open')) return;
    const clients = Object.fromEntries((S.boot.clients || []).map((x) => [x.id, x.name]));
    const dd = (k, v) => (v == null || v === '' ? '' : '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>');
    const link = (u, t) => (u ? '<a href="' + esc(safeUrl(u)) + '" target="_blank" rel="noopener">' + esc(t || u) + '</a>' : '');
    const pushes = (Array.isArray(c.pushed_campaigns) ? c.pushed_campaigns.slice() : []).sort((a, b) => String(b.pushed_at || '').localeCompare(String(a.pushed_at || '')));
    let html = '<div class="cx-why"><b>Tier ' + esc(c.tier) + ': ' + esc(TIER_TEXT[c.tier] || '') + '</b><ul>' + tierReasons(c).map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
      '<button class="cx-btn sm" data-act="copy" data-val="' + esc(c.email) + '">Copy email</button>' +
      '<button class="cx-btn sm" data-act="like" title="Filter to the same industry, seniority and company size">More like this</button>' +
      (c.company_domain ? '<button class="cx-btn sm" data-act="samecompany" data-val="' + esc(c.company_domain) + '">Everyone at this company</button>' : '') + '</div>';
    html += '<h4>Person</h4><dl class="cx-dl">' + dd('Email', esc(c.email)) + dd('Job title', esc(c.job_title)) + dd('Seniority', esc(c.seniority ? fmtVal.seniority(c.seniority) : '')) +
      dd('Department', esc(title(c.department))) + dd('Phone', esc(c.phone || c.corporate_phone || '')) + dd('LinkedIn', link(c.linkedin_url, 'Open profile')) +
      dd('Based in', esc([c.person_town || c.city, c.person_county || c.state, c.country].filter(Boolean).join(', '))) + '</dl>';
    html += '<h4>Company</h4><dl class="cx-dl">' + dd('Name', esc(c.company_name)) + dd('Website', link(c.company_domain, c.company_domain)) + dd('Industry', esc(title(c.industry))) +
      dd('Staff', c.num_employees == null ? '' : esc(sizeBucket(c.num_employees).replace('-', '–')) + ' <span class="cx-dim">(on file: ' + num(c.num_employees) + ')</span>') + dd('Location', esc([c.company_town || c.company_city, c.company_county, c.company_region, c.company_country].filter(Boolean).join(', '))) +
      dd('SIC codes', esc(c.ch_sic_codes)) + dd('Companies House', c.ch_company_number ? link('https://find-and-update.company-information.service.gov.uk/company/' + encodeURIComponent(c.ch_company_number), c.ch_company_number) : '') +
      dd('Founded', esc(c.ch_founded_year || '')) + dd('Company phone', esc(c.company_phone || '')) + dd('Keywords', esc(String(c.keywords || '').slice(0, 400))) + '</dl>';
    html += '<h4>Data</h4><dl class="cx-dl">' + dd('Verification', statusBadge(c) + (c.email_verify_reason ? '<div class="cx-dim">' + esc(c.email_verify_reason) + '</div>' : '')) +
      dd('Email provider', esc(PROVIDER[c.mx_provider] || c.mx_provider || 'Not checked')) + dd('Source', esc(SOURCE[c.source] || c.source)) +
      dd('Added', esc(c.imported_at ? shortDate(c.imported_at) + ' (' + ago(c.imported_at) + ')' : '')) + dd('Tags', esc((c.tags || []).join(', '))) +
      dd('Do not contact', c.do_not_contact ? '<span class="cx-badge bad">Yes</span>' : '') + dd('Bounce', esc(c.bounce_type || '')) + '</dl>';
    html += '<h4>Send history</h4><div class="cx-hist">' + (pushes.length ? pushes.map((p) => '<div><time>' + esc(shortDate(p.pushed_at)) + '</time><span><b>' + esc(clients[p.workspace_id] || 'Another client') + '</b> · ' + esc(p.campaign_name || '') + '</span></div>').join('') : '<div class="cx-dim">Never sent.</div>') +
      (c.marked_as_lead_at ? '<div><time>' + esc(shortDate(c.marked_as_lead_at)) + '</time><span class="cx-badge good">Became a lead</span></div>' : '') +
      (c.last_reply_at ? '<div><time>' + esc(shortDate(c.last_reply_at)) + '</time><span>Replied' + (c.reply_notes ? ': ' + esc(String(c.reply_notes).slice(0, 200)) : '') + '</span></div>' : '') + '</div>';
    if (facts.length) {
      html += '<h4>What they told us</h4><div class="cx-hist">' + facts.map((f) => '<div><time>' + esc(shortDate(f.observed_at)) + '</time><span><b>' + esc(String(f.attribute).replace(/_/g, ' ')) + (f.value ? ': ' + esc(f.value) : '') + '</b>' + (f.quote ? '<div class="cx-dim">“' + esc(String(f.quote).slice(0, 220)) + '”</div>' : '') + '</span></div>').join('') + '</div>';
    }
    $('.body', el).innerHTML = html;
    el._row = c;
  }
  function bindDrawer() {
    $('#drawer').addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const c = $('#drawer')._row;
      if (t.dataset.act === 'close') closeDrawer();
      else if (t.dataset.act === 'copy') { navigator.clipboard && navigator.clipboard.writeText(t.dataset.val).then(() => toast('Email copied')); }
      else if (t.dataset.act === 'samecompany') { S.f = Object.assign({}, S.defaults, { company: t.dataset.val }); delete S.f.hasName; closeDrawer(); renderRail(); commit({ now: true }); }
      else if (t.dataset.act === 'like' && c) {
        const f = Object.assign({}, S.f);
        delete f.company; delete f.search;
        if (c.industry) f.industryIs = String(c.industry).toLowerCase();
        if (c.seniority) f.seniority = c.seniority;
        const n = c.num_employees;
        if (n != null) f.numEmployeesRanges = sizeBucket(n);
        S.f = f; $('#q').value = ''; closeDrawer(); renderRail(); commit({ now: true });
        toast('Showing contacts like ' + (c.first_name || 'this one'));
      }
    });
  }

  // ── Popovers: client, saved views, more ──────────────────────────────────
  let openPop = null;
  function closePop() { if (openPop) { openPop.remove(); openPop = null; } $('#clientBtn').setAttribute('aria-expanded', 'false'); }
  function pop(anchor, html, right) {
    closePop();
    const el = document.createElement('div');
    el.className = 'cx-pop' + (right ? ' right' : '');
    el.innerHTML = html;
    anchor.appendChild(el);
    openPop = el;
    return el;
  }
  document.addEventListener('mousedown', (e) => { if (openPop && !openPop.parentElement.contains(e.target)) closePop(); });

  function setClient(id) {
    // Ticked rows were chosen for the previous client. Carrying them over
    // would let "Send these" mail one client's picks to another.
    if ((id || '') !== S.client) S.sel.clear();
    S.client = id || '';
    renderClient(); closePop();
    S.pockets = null; S.pocketsFor = '';
    commit({ now: true });
    loadPockets();
  }
  function renderClient() {
    const name = clientName();
    $('#clientVal').textContent = name || 'Choose a client';
    $('#clientBtn').classList.toggle('set', !!name);
  }
  function openClientPop() {
    const el = pop($('#clientWrap'), '<input class="find" type="search" placeholder="Find a client…" autocomplete="off"><div class="list" role="listbox"></div>');
    $('#clientBtn').setAttribute('aria-expanded', 'true');
    const input = $('input', el); const list = $('.list', el);
    let kb = 0;
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const items = (S.boot.clients || []).filter((c) => !q || c.name.toLowerCase().includes(q) || (c.vertical || '').toLowerCase().includes(q));
      kb = Math.min(kb, Math.max(0, items.length));
      list.innerHTML = (S.client ? '<button class="item" data-id="">No client<span class="sub">see the whole database</span></button>' : '') +
        (items.length ? items.map((c, i) => '<button class="item' + (c.id === S.client ? ' on' : '') + (i === kb ? ' kb' : '') + '" data-id="' + esc(c.id) + '">' + esc(c.name) + '<span class="sub">' + esc(c.vertical || '') + '</span></button>').join('') : '<div class="empty">No client by that name.</div>');
      list._items = items;
    };
    draw(); input.focus();
    input.addEventListener('input', () => { kb = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      const items = list._items || [];
      if (e.key === 'ArrowDown') { kb = Math.min(items.length - 1, kb + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { kb = Math.max(0, kb - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter' && items[kb]) setClient(items[kb].id);
      else if (e.key === 'Escape') closePop();
    });
    list.addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) setClient(b.dataset.id); });
  }

  async function loadViews() { try { S.views = (await api('/api/cx/views')).views || []; } catch { S.views = []; } }
  function openViewsPop() {
    const el = pop($('#viewsWrap'), '<div class="sect">Saved views</div><div class="list"></div>' +
      '<div style="border-top:1px solid var(--cx-line);padding:8px;display:flex;gap:6px"><input class="cx-input" id="viewName" placeholder="Name this view…" maxlength="80"><button class="cx-btn sm primary" id="viewSave">Save</button></div>', true);
    const list = $('.list', el);
    const draw = () => {
      list.innerHTML = S.views.length ? S.views.map((v) => '<div class="item" style="padding:0"><button class="item" data-view="' + esc(v.id) + '" style="flex:1">' + esc(v.name) +
        '<span class="sub">' + esc((v.state.client && ((S.boot.clients.find((c) => c.id === v.state.client) || {}).name)) || '') + '</span></button><button class="item" data-del="' + esc(v.id) + '" style="width:auto" title="Delete" aria-label="Delete view">×</button></div>').join('')
        : '<div class="empty">No saved views yet. Set your filters, then name and save them here. A view keeps the client, every filter and the sort.</div>';
    };
    draw();
    el.addEventListener('click', async (e) => {
      const v = e.target.closest('[data-view]');
      if (v) {
        const view = S.views.find((x) => x.id === v.dataset.view);
        if (!view) return;
        S.f = Object.assign({}, view.state.filters || {});
        S.client = (S.boot.clients || []).some((c) => c.id === view.state.client) ? view.state.client : '';
        S.sort = view.state.sort || 'best'; S.dir = view.state.dir || 'desc';
        if (Array.isArray(view.state.cols) && view.state.cols.length) { S.cols = view.state.cols; store.set('cols', S.cols); }
        $('#q').value = S.f.search || '';
        closePop(); renderClient(); renderRail(); renderTabs(); commit({ now: true }); loadPockets();
        toast('Loaded “' + view.name + '”');
        return;
      }
      const d = e.target.closest('[data-del]');
      if (d) { try { await api('/api/cx/views/' + d.dataset.del, { method: 'DELETE' }); await loadViews(); draw(); } catch (err) { toast(err.message, true); } return; }
      if (e.target.id === 'viewSave') saveView();
    });
    const saveView = async () => {
      const name = $('#viewName', el).value.trim();
      if (!name) { $('#viewName', el).focus(); return; }
      try {
        await api('/api/cx/views', { method: 'POST', body: { name, state: { client: S.client, filters: S.f, sort: S.sort, dir: S.dir, cols: S.cols } } });
        await loadViews(); closePop(); toast('Saved “' + name + '”');
      } catch (err) { toast(err.message, true); }
    };
    $('#viewName', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') saveView(); });
  }

  function openMorePop() {
    const el = pop($('#moreWrap'),
      '<div class="list"><div class="sect">Download</div>' +
      '<button class="item" data-more="csv">Everything that matches (CSV)</button>' +
      '<button class="item" data-more="csv-clean">Verified-safe only (CSV)</button>' +
      '<div class="sect">Table</div>' +
      COLS.filter((c) => c.label).map((c) => '<label class="item" style="cursor:pointer"><input type="checkbox" data-col="' + c.id + '"' + (S.cols.includes(c.id) ? ' checked' : '') + ' style="accent-color:var(--cx-accent)"> ' + esc(c.label) + '</label>').join('') +
      '<label class="item" style="cursor:pointer"><input type="checkbox" data-more="compact"' + (S.compact ? ' checked' : '') + ' style="accent-color:var(--cx-accent)"> Compact rows</label>' +
      '<div class="sect">Other</div>' +
      '<button class="item" data-more="link">Copy a link to this view</button>' +
      '<a class="item" href="/contacts.html" style="text-decoration:none;color:inherit">Imports and admin tools<span class="sub">classic page</span></a></div>', true);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-more]');
      if (!b) return;
      const m = b.dataset.more;
      if (m === 'csv' || m === 'csv-clean') {
        const p = filterParams(); if (m === 'csv-clean') p.set('clean', '1');
        closePop(); toast('Preparing the download…');
        location.href = '/api/cx/export.csv?' + p.toString();
      } else if (m === 'link') {
        navigator.clipboard && navigator.clipboard.writeText(location.href).then(() => toast('Link copied')); closePop();
      }
    });
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.col) {
        const set = new Set(S.cols);
        if (t.checked) set.add(t.dataset.col); else set.delete(t.dataset.col);
        S.cols = COLS.map((c) => c.id).filter((id) => set.has(id) || id === 'tier');
        store.set('cols', S.cols); renderTable();
      } else if (t.dataset.more === 'compact') { S.compact = t.checked; store.set('compact', S.compact); renderTable(); }
    });
  }

  // ── Dialogs ──────────────────────────────────────────────────────────────
  function closeDialog() { $('#dialogHost').innerHTML = ''; }
  function dialog(html) {
    const host = $('#dialogHost');
    host.innerHTML = '<div class="cx-scrim" data-scrim><div class="cx-dialog" role="dialog" aria-modal="true">' + html + '</div></div>';
    $('[data-scrim]', host).addEventListener('mousedown', (e) => { if (e.target.dataset.scrim !== undefined) closeDialog(); });
    return $('.cx-dialog', host);
  }
  function reasonsHtml(send) {
    const rows = Object.entries(send.reasons || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return '<p>Nothing was held back in the sample that was checked.</p>';
    return '<div class="cx-reasons">' + rows.map(([k, n]) => '<span>' + esc(REASONS[k] || k) + '</span><span>' + num(n) + '</span>').join('') + '</div>';
  }
  function openWhy() {
    if (!S.send) return;
    const d = dialog('<header><h2>Why some contacts are held back</h2><p>The send rules were run over ' + num(S.send.checked) + ' of the matching contacts' + (S.send.estimated ? ' (a sample)' : '') + '. ' + num(S.send.sendable) + ' passed.</p></header>' +
      '<div class="body"><div class="cx-box">' + reasonsHtml(S.send) + '</div><p class="cx-dim">These are the same rules a send applies, so this number is what a send will accept. The rules are set on the Send rules and client pages.</p></div>' +
      '<footer><button class="cx-btn" data-x>Close</button></footer>');
    $('[data-x]', d).addEventListener('click', closeDialog);
  }

  // Send to a campaign. Uses the existing, proven push routes. What v2 adds is
  // that the filter handed over is resolved by the server when the dialog
  // opens (resolveNow), client rules included, and that one snapshot of client
  // + filter is used for the ready count, the selection and the refill. The
  // push therefore draws from exactly the contacts the list shows.
  async function openSend(selectedOnly) {
    if (!S.client) return;
    const ticked = [...S.sel.keys()];
    const useSel = selectedOnly && ticked.length > 0;
    const lastN = store.get('lastSendN', 500);
    const d = dialog(
      '<header><h2>Send to a ' + esc(clientName()) + ' campaign</h2><p>' + (useSel ? 'Sends the ' + num(ticked.length) + ' contacts you ticked.' : 'Picks the best contacts from this filter, verifies them, and keeps going until the number you asked for is in PlusVibe.') + '</p></header>' +
      '<div class="body">' +
      (useSel ? '' : '<div class="cx-box" id="sdReady"><b>Checking who is ready…</b></div>') +
      '<div class="cx-field"><label>Campaign</label><select class="cx-select" id="sdCamp"><option value="">Loading campaigns…</option></select><div class="hint" id="sdCampHint"></div></div>' +
      '<div class="cx-field" id="sdNewWrap" hidden><label>New campaign name</label><input class="cx-input" id="sdNew" placeholder="e.g. Yorkshire builders 1-50"></div>' +
      (useSel ? '' : '<div class="cx-field"><label>How many to send</label><input class="cx-input" id="sdN" type="number" min="1" max="20000" value="' + Math.max(1, lastN) + '"></div>') +
      '<details class="cx-adv"><summary>Options</summary><div class="inner">' +
      '<label class="cx-check"><input type="checkbox" id="sdOne" checked><span>One contact per company<small>Stops a company getting several emails from one send.</small></span></label>' +
      '<label class="cx-check"><input type="checkbox" id="sdCatch" checked><span>Include catch-all addresses that pass the second check<small>Catch-all domains accept any address, so they get an extra check before sending.</small></span></label>' +
      '<label class="cx-check"><input type="checkbox" id="sdSave" checked><span>Remember this filter for the campaign<small>So “What works” can load it again later.</small></span></label>' +
      '<label class="cx-check"><input type="checkbox" id="sdReplace"><span>Update contacts PlusVibe already holds<small>Leave off unless you are re-sending corrected data.</small></span></label>' +
      '</div></details></div>' +
      '<footer><span class="err" id="sdErr"></span><button class="cx-btn" data-x>Cancel</button><button class="cx-btn primary" id="sdGo" disabled>Verify and send</button></footer>');
    $('[data-x]', d).addEventListener('click', closeDialog);
    const camp = $('#sdCamp', d); const err = $('#sdErr', d); const go = $('#sdGo', d); const ready = $('#sdReady', d);

    // One snapshot for the life of the dialog.
    let snap;
    try { snap = await resolveNow(); }
    catch (e) { err.textContent = 'Could not read the current filter: ' + e.message; return; }
    if (!d.isConnected) return;

    // A campaign created by an earlier attempt in this dialog. Reused on retry
    // so a failed send never leaves a trail of empty campaigns in PlusVibe.
    let created = null;
    const chosen = () => {
      const o = camp.selectedOptions[0];
      if (!o || !o.value) return null;
      if (o.value === '__new') { const name = $('#sdNew', d).value.trim(); return { isNew: true, id: created && created.name === name ? created.id : '', name }; }
      return { isNew: false, id: o.value, name: o.dataset.name || '' };
    };

    let readySeq = 0;
    const refreshReady = async () => {
      if (!ready) return;
      const my = ++readySeq;
      const c = chosen();
      ready.className = 'cx-box';
      ready.innerHTML = '<b>Checking who is ready…</b>';
      try {
        const r = await api('/api/contacts/sendability', { method: 'POST', body: {
          workspace_id: snap.client, workspace_name: snap.clientName, filters: snap.resolved,
          campaign_id: c && c.id ? c.id : '', campaign_name: c && c.name ? c.name : '' } });
        if (my !== readySeq || !d.isConnected) return;
        const n = r.checked ? r.sendableTotal : null;
        ready.className = 'cx-box ' + (n === 0 ? 'bad' : 'ok');
        ready.innerHTML = '<b>' + (n == null ? 'Could not tell how many are ready' : (r.estimated ? 'About ' : '') + num(n) + ' ready to send' + (c && c.id ? ' to this campaign' : '')) + '</b>' +
          '<div class="cx-dim">Best first: never emailed, then longest rested, then newest. ' + (c && c.id ? 'Contacts already in this campaign are left out.' : 'Choose a campaign to leave out contacts already in it.') + '</div>';
      } catch (e) {
        if (my !== readySeq || !d.isConnected) return;
        ready.className = 'cx-box bad';
        ready.innerHTML = '<b>Could not check who is ready</b><div class="cx-dim">' + esc(e.message) + '</div>';
      }
    };
    refreshReady();

    camp.addEventListener('change', () => { $('#sdNewWrap', d).hidden = camp.value !== '__new'; refreshReady(); });
    try {
      const r = await api('/api/pv/campaigns?workspace_id=' + encodeURIComponent(snap.client));
      if (!d.isConnected) return;
      const list = (r.list || []).slice().sort((x, y) => String(x.name).localeCompare(String(y.name)));
      camp.innerHTML = '<option value="">Choose a campaign…</option>' +
        list.map((c) => '<option value="' + esc(c.id) + '" data-name="' + esc(c.name) + '">' + esc(c.name) + (c.status ? ' (' + esc(String(c.status).toLowerCase()) + ')' : '') + '</option>').join('') +
        '<option value="__new">+ New campaign…</option>';
      go.disabled = false;
    } catch (e) {
      camp.innerHTML = '<option value="">Campaigns could not be loaded</option>';
      $('#sdCampHint', d).textContent = 'PlusVibe did not answer: ' + String(e.message).slice(0, 140);
    }

    go.addEventListener('click', async () => {
      err.textContent = '';
      const c = chosen();
      const target = useSel ? 0 : Math.max(0, Math.min(parseInt($('#sdN', d).value, 10) || 0, 20000));
      if (!c) { err.textContent = 'Choose a campaign.'; return; }
      if (c.isNew && !c.name) { err.textContent = 'Name the new campaign.'; return; }
      if (!useSel && !target) { err.textContent = 'Enter how many to send.'; return; }
      go.disabled = true; const label = go.textContent;
      try {
        const onePer = $('#sdOne', d).checked;
        // 1. Find the contacts FIRST. Nothing is created in PlusVibe until we
        //    know there is something to send.
        let ids = ticked;
        if (!useSel) {
          go.textContent = 'Finding the best contacts…';
          const sd = await api('/api/contacts/sendability', { method: 'POST', body: {
            workspace_id: snap.client, workspace_name: snap.clientName, filters: snap.resolved, return_ids: true,
            campaign_id: c.id || '', campaign_name: c.name, sample: target, one_per_company: onePer } });
          ids = sd.ids || [];
          if (!ids.length) throw new Error('No contacts in this filter pass the send rules for this campaign.');
          store.set('lastSendN', target);
        }
        // 2. Create the campaign if it is a new one (once per dialog).
        let campId = c.id;
        if (c.isNew && !campId) {
          go.textContent = 'Creating the campaign…';
          const cr = await api('/api/bison/create-campaign', { method: 'POST', body: { ws_id: snap.client, name: c.name, settings: { open_tracking: false, plain_text: true, can_unsubscribe: false } } });
          campId = cr.campaign.id;
          created = { id: campId, name: c.name };
        }
        // 3. Verify and send.
        go.textContent = 'Starting…';
        const useCatch = $('#sdCatch', d).checked;
        const body = {
          workspace_id: snap.client, campaign_id: campId, contact_ids: ids, workspace_name: snap.clientName, campaign_name: c.name,
          include_risky: false, emailProviders: snap.typed.emailProviders || '', use_n2b: useCatch,
          allowed_statuses: useCatch ? ['safe', 'safe_catchall'] : ['safe'],
          one_per_company: onePer, replace_existing: $('#sdReplace', d).checked,
        };
        if (!useSel) { body.target = target; body.target_filters = snap.resolved; }
        const r = await api('/api/contacts/verify-and-push', { method: 'POST', body });
        if ($('#sdSave', d).checked) {
          api('/api/campaign-filters', { method: 'POST', body: { workspace_id: snap.client, workspace_name: snap.clientName, campaign_id: campId, campaign_name: c.name, filters: snap.typed } }).catch(() => {});
        }
        closeDialog();
        if (useSel) { S.sel.clear(); renderTable(); renderTabs(); }
        toast(r.jobId ? 'Send started for “' + c.name + '”. Progress is bottom right.' : 'Send started.');
        pollJobs(true);
      } catch (e) { err.textContent = e.message; go.disabled = false; go.textContent = label; }
    });
  }

  // ── Send jobs tray ───────────────────────────────────────────────────────
  let jobsTimer = null;
  const JOB_WORD = { queued: 'Waiting', verifying: 'Verifying', n2b_verifying: 'Second check', pushing: 'Sending', pausing: 'Pausing', paused: 'Paused', failed: 'Failed', error: 'Failed', completed: 'Done' };
  async function pollJobs(soon) {
    clearTimeout(jobsTimer);
    let jobs = [];
    try { jobs = (await api('/api/contacts/push-jobs')).jobs || []; } catch { /* tray is optional */ }
    const el = $('#jobs');
    el.innerHTML = jobs.slice(0, 4).map((j) => {
      const goal = j.target || j.total || 0;
      const done = j.pushed || 0;
      const w = goal ? Math.min(100, Math.round((done / goal) * 100)) : Math.round((j.progress || 0));
      const live = ['queued', 'verifying', 'n2b_verifying', 'pushing'].includes(j.status);
      const failed = j.status === 'failed' || j.status === 'error';
      return '<div class="cx-job' + (failed ? ' failed' : '') + '"><div class="t"><b title="' + esc(j.campaign_name) + '">' + esc(j.workspace_name || '') + ' · ' + esc(j.campaign_name || '') + '</b><span>' + esc(JOB_WORD[j.status] || j.status) + (j.queuePosition ? ' (' + j.queuePosition + ')' : '') + '</span></div>' +
        '<div class="p"><i style="width:' + w + '%"></i></div><div class="m"><span>' + num(done) + (goal ? ' of ' + num(goal) : '') + ' sent</span><span>' + num(j.verified || 0) + ' verified</span>' +
        (failed && j.error ? '<span title="' + esc(j.error) + '">' + esc(String(j.error).slice(0, 40)) + '</span>' : '') +
        (live ? '<button data-job="pause" data-id="' + esc(j.id) + '">Pause</button><button data-job="cancel" data-id="' + esc(j.id) + '">Stop</button>' : '') +
        (j.status === 'paused' ? '<button data-job="resume" data-id="' + esc(j.id) + '">Resume</button><button data-job="cancel" data-id="' + esc(j.id) + '">Stop</button>' : '') + '</div></div>';
    }).join('');
    const active = jobs.some((j) => ['queued', 'verifying', 'n2b_verifying', 'pushing', 'pausing'].includes(j.status));
    jobsTimer = setTimeout(pollJobs, active || soon ? 4000 : 60000);
  }
  function bindJobs() {
    $('#jobs').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-job]');
      if (!b) return;
      if (b.dataset.job === 'cancel' && !confirm('Stop this send? Contacts already sent stay in the campaign.')) return;
      try { await api('/api/contacts/push-jobs/' + b.dataset.id + '/' + b.dataset.job, { method: 'POST' }); pollJobs(true); }
      catch (err) { toast(err.message, true); }
    });
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────
  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'select' || tag === 'textarea';
      if (e.key === 'Escape') {
        if ($('#dialogHost').firstChild) return closeDialog();
        if (openPop) return closePop();
        if ($('#drawer').classList.contains('open')) return closeDrawer();
        if ($('#rail').classList.contains('open')) return $('#rail').classList.remove('open');
        if (typing) e.target.blur();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || $('#dialogHost').firstChild) return;
      if (e.key === '/') { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
      if (S.tab !== 'contacts' || !S.rows.length) return;
      if (e.key === 'ArrowDown' || e.key === 'j') { S.kb = Math.min(S.rows.length - 1, S.kb + 1); markKb(); e.preventDefault(); if ($('#drawer').classList.contains('open')) openDrawer(S.rows[S.kb]); }
      else if (e.key === 'ArrowUp' || e.key === 'k') { S.kb = Math.max(0, S.kb - 1); markKb(); e.preventDefault(); if ($('#drawer').classList.contains('open')) openDrawer(S.rows[S.kb]); }
      else if (e.key === 'Enter' && S.kb >= 0) openDrawer(S.rows[S.kb]);
      else if ((e.key === 'x' || e.key === 'X') && S.kb >= 0) toggleSel(S.rows[S.kb]);
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  async function boot() {
    renderFunnel(); renderTabs();
    try {
      S.boot = await api('/api/cx/bootstrap');
    } catch (e) {
      $('#tablewrap').innerHTML = '<div class="cx-state"><h3>The page could not start</h3><p>' + esc(e.message) + '</p><button class="cx-btn" onclick="location.reload()">Reload</button></div>';
      return;
    }
    if (S.boot.notice) {
      const n = document.createElement('div');
      n.className = 'cx-notice';
      n.textContent = S.boot.notice;
      $('.cx-shell').prepend(n);
    }
    buildDefaults();
    readUrl();
    $('#q').value = S.f.search || '';
    renderClient(); renderRail(); renderChips(); renderTabs(); renderTable();
    bindRail(); bindChips(); bindMain(); bindDrawer(); bindJobs(); bindKeys();

    $('#clientBtn').addEventListener('click', () => (openPop && openPop.parentElement === $('#clientWrap') ? closePop() : openClientPop()));
    $('#viewsBtn').addEventListener('click', async () => { if (openPop && openPop.parentElement === $('#viewsWrap')) return closePop(); await loadViews(); openViewsPop(); });
    $('#moreBtn').addEventListener('click', () => (openPop && openPop.parentElement === $('#moreWrap') ? closePop() : openMorePop()));
    $('#railBtn').addEventListener('click', () => $('#rail').classList.toggle('open'));

    const q = $('#q');
    const typed = debounce(() => { setFilter('search', q.value.trim()); S.page = 0; writeUrl(); renderChips(); runSearch(); }, 350);
    q.addEventListener('input', typed);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { setFilter('search', q.value.trim()); S.page = 0; writeUrl(); renderChips(); runSearch(); } });

    window.addEventListener('hashchange', () => { readUrl(); $('#q').value = S.f.search || ''; renderClient(); renderRail(); renderChips(); renderTabs(); runSearch(); loadPockets(); });

    runSearch();
    loadPockets();
    if (S.tab === 'works') renderWorks();
    pollJobs();
  }
  boot();
})();
