// Canonical catalog of extractable fields. Mirrored in admin-new/lib/enrich-fields.ts.
// `claude: true` means the field is filled by the LLM classifier (only run when
// at least one such field is selected). `source` is informational for the UI.

export const FIELD_CATALOG = [
  { key: 'website',       label: 'Website / domain', claude: false, default: true },
  { key: 'emails',        label: 'Email addresses',  claude: false, default: true },
  { key: 'phones',        label: 'Phone numbers',    claude: false, default: true },
  { key: 'address',       label: 'Address',          claude: false, default: true },
  { key: 'social_links',  label: 'Social profiles',  claude: false, default: false },
  { key: 'description',   label: 'Description',       claude: false, default: false },
  { key: 'business_type', label: 'Business type',    claude: true,  default: true },
  { key: 'industry',      label: 'Industry',         claude: true,  default: true },
  { key: 'keywords',      label: 'Keywords',         claude: true,  default: false },
]

export const ALL_FIELD_KEYS = FIELD_CATALOG.map((f) => f.key)
export const CLAUDE_FIELD_KEYS = FIELD_CATALOG.filter((f) => f.claude).map((f) => f.key)
export const DEFAULT_FIELD_KEYS = FIELD_CATALOG.filter((f) => f.default).map((f) => f.key)

// Normalise an arbitrary fields array to known keys; fall back to defaults.
export function normaliseFields(fields) {
  const set = new Set(Array.isArray(fields) ? fields : [])
  const picked = ALL_FIELD_KEYS.filter((k) => set.has(k))
  return picked.length ? picked : DEFAULT_FIELD_KEYS
}

export function wantsClaude(fields) {
  return CLAUDE_FIELD_KEYS.some((k) => fields.includes(k))
}
