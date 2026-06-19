// Canonical catalog of extractable fields. Mirrored in scraper-service/src/fields.js.
// Both pages render these as checkboxes; the selected keys are stored on the job
// and the worker only runs the matching extractors (and only calls Claude when a
// claude-backed field is selected).

export interface FieldDef {
  key: string
  label: string
  claude: boolean
  default: boolean
}

export const FIELD_CATALOG: FieldDef[] = [
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

export function normaliseFields(fields: unknown): string[] {
  const set = new Set(Array.isArray(fields) ? (fields as string[]) : [])
  const picked = ALL_FIELD_KEYS.filter((k) => set.has(k))
  return picked.length ? picked : DEFAULT_FIELD_KEYS
}
