#!/usr/bin/env node
/**
 * Guards the saved-campaign-filter round trip on the contacts page.
 *
 * The bug this exists to prevent: getFilterValues() emitted ~73 filter keys but
 * applyRecalledFilter() only restored 11 of them, from a hand-written map that
 * had drifted. Everything else — building ownership, the whole Companies House
 * block, gateways, SIC codes — was saved to the database and then silently
 * dropped on recall. Two hand-maintained lists is one too many, so this test
 * fails the moment they disagree again.
 *
 * Drives the REAL functions out of contacts.html against a minimal fake DOM:
 * set a wide filter state, snapshot it, wipe the UI, recall, and require the
 * result to be identical.
 *
 *   node scripts/test-filter-roundtrip.js
 */
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'contacts.html');
const src = fs.readFileSync(HTML, 'utf8');

// ── Minimal DOM ────────────────────────────────────────────────────────────
const els = new Map();
function mk(id, opts = {}) {
  const el = {
    id, value: opts.value ?? '', checked: !!opts.checked, type: opts.type || 'text',
    className: '', style: {}, innerHTML: '', textContent: '', title: '', dataset: {},
    appendChild() {}, addEventListener() {}, closest: () => null,
    querySelector: () => null, querySelectorAll: () => [],
  };
  els.set(id, el);
  return el;
}

// Tags first so an element's own value="" attribute is captured; a checkbox's
// value is markup, not user state, and must survive the wipe below.
for (const m of src.matchAll(/<(?:input|select|option)\b[^>]*>/g)) {
  const tag = m[0];
  const id = /id="([a-zA-Z0-9_]+)"/.exec(tag);
  if (!id || els.has(id[1])) continue;
  const val = /value="([^"]*)"/.exec(tag);
  const typ = /type="([a-z]+)"/.exec(tag);
  mk(id[1], { value: val ? val[1] : '', type: typ ? typ[1] : 'text' });
}
for (const m of src.matchAll(/id="([a-zA-Z0-9_]+)"/g)) if (!els.has(m[1])) mk(m[1]);

const gwValues = [...src.matchAll(/class="gwExcl" value="([^"]+)"/g)].map(m => m[1]);
const gwBoxes = gwValues.map(v => ({ value: v, checked: false }));
const gwRadios = ['exclude', 'only'].map(v => ({ value: v, checked: v === 'exclude' }));
const srcBoxes = ['ch', 'apollo', 'scraper'].map(v => ({ value: v, checked: true }));

// Reply-fact rows are tri-state (off / exclude / only), built at runtime from
// the data, so they are simulated rather than parsed out of the markup.
const factRows = ['premises_tenure:serviced_office', 'has_supplier::coffee', 'person_left:true']
  .map(spec => ({ dataset: { spec, state: 'off' }, querySelector: () => null, closest: () => null }));

global.document = {
  getElementById: id => els.get(id) || null,
  querySelector: sel => {
    const m = /input\[name="gwMode"\]\[value="([^"]+)"\]/.exec(sel);
    if (m) return gwRadios.find(r => r.value === m[1]) || null;
    if (sel === 'input[name="gwMode"]:checked') return gwRadios.find(r => r.checked) || null;
    return null;
  },
  querySelectorAll: sel => {
    if (sel === '.gwExcl') return gwBoxes;
    if (sel === '.gwExcl:checked') return gwBoxes.filter(b => b.checked);
    if (sel === '.src-cb') return srcBoxes;
    if (sel === '.factRow') return factRows;
    return [];
  },
  addEventListener() {},
};
global.window = {};

// ── Load the functions under test ──────────────────────────────────────────
function slice(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`could not locate "${from}" — has contacts.html been restructured?`);
  return src.slice(a, b);
}

const code = [
  slice('const filterDefs = {', '// ── Column definitions'),
  // getFilterValues through the end of the SCALAR_FILTERS / CHECK_GROUPS
  // registries, which applyRecalledFilter depends on. Taken as one slice so
  // the order of the helpers inside can change without breaking this test.
  slice('function getFilterValues(', '// Inject × clear buttons'),
  slice('function applyRecalledFilter()', 'async function deleteRecalledFilter'),
  `function renderFilterTags(){} function renderEmployeeBuckets(){} function renderSicChips(){}
   function updateFilterSectionStates(){} function onGatewayModeChange(){} function search(){}
   function showMessage(){} function loadFactFilters(){}
   function getEmployeeRangesValue(){ return [..._employeeSelected].join(','); }
   function setEmployeeRangesFromString(s){ _employeeSelected = new Set((s||'').split(',').filter(Boolean)); }
   function setSourcesFromHash(csv){ const w=new Set((csv||'').split(',').filter(Boolean));
     for (const b of document.querySelectorAll('.src-cb')) b.checked = w.has(b.value); }
   function getSelectedSources(){ const bs=[...document.querySelectorAll('.src-cb')];
     const on=bs.filter(b=>b.checked).map(b=>b.value); return on.length===bs.length?'':on.join(','); }
   let _employeeSelected = new Set(); let _sicSelected = [];
   let sortBy='email', sortDir='asc', pageSize=50; let _campaignFilters = [];`,
].join('\n');

const ctx = new Function(code + `
  return { getFilterValues, getFilterSnapshot, applyRecalledFilter, filterDefs,
           get sic(){ return _sicSelected; }, get emp(){ return _employeeSelected; },
           setRows(r){ _campaignFilters = r; } };
`)();

// ── Set a wide filter state ────────────────────────────────────────────────
const set = (id, v) => { const e = els.get(id); if (e) e.value = v; };
const tick = id => { const e = els.get(id); if (e) e.checked = true; };

ctx.filterDefs.jobTitle.selected = ['Director', 'Owner'];
ctx.filterDefs.jobTitle.excluded = ['Assistant'];
ctx.filterDefs.industry.selected = ['Manufacturing'];
ctx.filterDefs.companyCounty.selected = ['Kent'];
ctx.filterDefs.companyCounty.excluded = ['Surrey'];

set('globalSearch', 'solar'); set('status', 'new'); set('company', 'Alpine');
set('ownsBuilding', 'yes'); set('chStatusFilter', 'active'); set('solarStatus', 'none');
set('solarMinKwp', '50'); set('adsRunsAds', 'true'); set('hasName', 'yes');
set('hasCompany', 'yes'); set('updatedAge', '90');
['chInsolvency', 'chOnlyEnriched', 'filterExcludeDNC', 'filterNotSentToPV',
 'emailGoogle', 'emailOther', 'vfSafe', 'vfSafeCatchall'].forEach(tick);
gwBoxes[0].checked = true;
srcBoxes[2].checked = false;
factRows[0].dataset.state = 'exclude';   // hide serviced offices
factRows[2].dataset.state = 'only';      // show only departed people
ctx.emp.add('11-50');
ctx.sic.push({ code: '35110', label: 'Electric power' });

const saved = ctx.getFilterSnapshot();

// ── Wipe, then recall ──────────────────────────────────────────────────────
for (const e of els.values()) {
  e.checked = false;
  if (e.type !== 'checkbox' && e.type !== 'radio') e.value = '';
}
gwBoxes.forEach(b => { b.checked = false; });
srcBoxes.forEach(b => { b.checked = true; });
factRows.forEach(r => { r.dataset.state = 'off'; });
Object.keys(ctx.filterDefs).forEach(k => { ctx.filterDefs[k].selected = []; ctx.filterDefs[k].excluded = []; });

els.get('recallClient').value = 'ws1';
els.get('recallCampaign').value = 'camp1';
if (!els.has('recallInfo')) mk('recallInfo');
ctx.setRows([{ workspace_id: 'ws1', campaign_id: 'camp1', campaign_name: 'Test', filters: saved, saved_at: new Date().toISOString() }]);
ctx.applyRecalledFilter();

const after = ctx.getFilterSnapshot();

// ── Compare ────────────────────────────────────────────────────────────────
const keys = [...new Set([...Object.keys(saved), ...Object.keys(after)])].sort();
const diffs = keys.filter(k => JSON.stringify(saved[k]) !== JSON.stringify(after[k]));

console.log(`filters saved   : ${Object.keys(saved).length}`);
console.log(`after recall    : ${Object.keys(after).length}`);

const pageKeys = ['limit', 'offset', 'sortBy', 'sortDir'].filter(k => k in saved);
if (pageKeys.length) {
  console.log(`\nFAIL: pagination/sort leaked into the snapshot: ${pageKeys.join(', ')}`);
  process.exit(1);
}
if (diffs.length) {
  console.log(`\nFAIL — ${diffs.length} filter(s) lost or changed on recall:`);
  diffs.forEach(k => console.log(`  ${k}: saved=${JSON.stringify(saved[k])} after=${JSON.stringify(after[k])}`));
  process.exit(1);
}
console.log('\nPASS — every saved filter came back identical.');
