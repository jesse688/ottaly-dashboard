// Domain normalisation + list parsing for the ads checker.
// The server is authoritative — the UI may pre-clean for display, but every
// domain that reaches the queue goes through normalizeDomain() here.

/**
 * lower → strip scheme → strip leading www. → drop path/query → strip quotes/commas.
 * Returns null for anything that isn't a plausible hostname.
 */
function normalizeDomain(raw) {
  if (!raw) return null;
  let d = String(raw).trim().toLowerCase();
  d = d
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0]
    .replace(/[",;]/g, '')
    .trim();
  // An email slipped into the list — take the domain half.
  if (d.includes('@')) d = d.split('@').pop();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
  return d;
}

/** Normalise + dedupe, preserving first-seen order. */
function normalizeList(values) {
  const seen = new Set();
  const out = [];
  for (const v of values || []) {
    const d = normalizeDomain(v);
    if (d && !seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}

// Split one CSV line, honouring simple double-quoted cells. Enough for the
// exports we feed this (Apollo/PlusVibe/CH), which never embed newlines.
function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/**
 * Pull domains out of pasted/uploaded text. Detects CSV by looking for a
 * Domain/Website/URL column in the first line; otherwise treats it as one
 * domain per line.
 */
function parseDomainText(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  let col = header.findIndex((h) => h === 'domain' || h === 'website' || h === 'url' || h === 'company domain');
  if (col === -1) col = header.findIndex((h) => h.includes('domain') || h.includes('website'));

  // Only treat it as a CSV if the header row itself isn't already a domain —
  // a plain .txt list whose first line is "acme.com" must not lose that line.
  if (col !== -1 && !normalizeDomain(header[col])) {
    return normalizeList(lines.slice(1).map((l) => splitCsvLine(l)[col]));
  }
  // Fall back to "first cell of each line", which also covers a headerless CSV.
  return normalizeList(lines.map((l) => (l.includes(',') ? splitCsvLine(l)[0] : l)));
}

module.exports = { normalizeDomain, normalizeList, parseDomainText, splitCsvLine };
