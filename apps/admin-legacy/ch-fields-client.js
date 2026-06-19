// Browser-side mirror of ch-fields.js / scraper-service fields.js.
// Loaded by enrichment.html and companies-house.html so the field tick-boxes
// match the keys the worker understands. Exposes globals (no module system).
window.FIELD_CATALOG = [
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
window.ALL_FIELD_KEYS = window.FIELD_CATALOG.map(function (f) { return f.key; });
window.DEFAULT_FIELD_KEYS = window.FIELD_CATALOG.filter(function (f) { return f.default; }).map(function (f) { return f.key; });
