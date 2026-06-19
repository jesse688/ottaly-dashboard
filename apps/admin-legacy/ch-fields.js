// Canonical catalog of extractable fields for the website scraper / enrichment.
// MUST stay in sync with apps/scraper-service/src/fields.js (the worker) and
// apps/admin-new/lib/enrich-fields.ts. The dashboard renders these as tick-boxes;
// the selected keys are stored on the scrape_jobs row and the worker only runs the
// matching extractors (and only calls Claude when a `claude:true` field is picked).

const FIELD_CATALOG = [
  { key: 'website',       label: 'Website / domain', claude: false, default: true },
  { key: 'emails',        label: 'Email addresses',  claude: false, default: true },
  { key: 'phones',        label: 'Phone numbers',    claude: false, default: true },
  { key: 'address',       label: 'Address',          claude: false, default: true },
  { key: 'social_links',  label: 'Social profiles',  claude: false, default: false },
  { key: 'description',   label: 'Description',       claude: false, default: false },
  { key: 'business_type', label: 'Business type',    claude: true,  default: true },
  { key: 'industry',      label: 'Industry',         claude: true,  default: true },
  { key: 'keywords',      label: 'Keywords',         claude: true,  default: false },
];

const ALL_FIELD_KEYS = FIELD_CATALOG.map((f) => f.key);
const CLAUDE_FIELD_KEYS = FIELD_CATALOG.filter((f) => f.claude).map((f) => f.key);
const DEFAULT_FIELD_KEYS = FIELD_CATALOG.filter((f) => f.default).map((f) => f.key);

// Normalise an arbitrary fields array to known keys; fall back to defaults.
function normaliseFields(fields) {
  const set = new Set(Array.isArray(fields) ? fields : []);
  const picked = ALL_FIELD_KEYS.filter((k) => set.has(k));
  return picked.length ? picked : DEFAULT_FIELD_KEYS;
}

function wantsClaude(fields) {
  return CLAUDE_FIELD_KEYS.some((k) => fields.includes(k));
}

module.exports = {
  FIELD_CATALOG,
  ALL_FIELD_KEYS,
  CLAUDE_FIELD_KEYS,
  DEFAULT_FIELD_KEYS,
  normaliseFields,
  wantsClaude,
};
