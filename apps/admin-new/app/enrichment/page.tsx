'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

// ── Field catalog (mirror of legacy ch-fields-client.js) ───────────────────
type FieldDef = { key: string; label: string; claude: boolean; default: boolean }
const FIELD_CATALOG: FieldDef[] = [
  { key: 'website', label: 'Website / domain', claude: false, default: true },
  { key: 'emails', label: 'Email addresses', claude: false, default: true },
  { key: 'phones', label: 'Phone numbers', claude: false, default: true },
  { key: 'address', label: 'Address', claude: false, default: true },
  { key: 'social_links', label: 'Social profiles', claude: false, default: false },
  { key: 'description', label: 'Description', claude: false, default: false },
  { key: 'business_type', label: 'Business type', claude: true, default: true },
  { key: 'industry', label: 'Industry', claude: true, default: true },
  { key: 'keywords', label: 'Keywords', claude: true, default: false },
]
const DEFAULT_FIELD_KEYS = FIELD_CATALOG.filter((f) => f.default).map((f) => f.key)

// ── Types ──────────────────────────────────────────────────────────────────
type CsvRow = { name?: string; location?: string; website?: string }
type Job = {
  id: number
  status: string
  total: number
  done: number
  ok: number
  failed: number
  error: string | null
}
type ResultItem = {
  company_name?: string | null
  location?: string | null
  domain?: string | null
  website?: string | null
  item_status?: string | null
  scrape_status?: string | null
  emails?: string[] | null
  phones?: string[] | null
  address?: string | null
  business_type?: string | null
  industry?: string | null
  keywords?: string[] | null
  description?: string | null
  socials?: Record<string, string> | null
}

// ── CSV parsing (quotes, commas, CRLF) — ported verbatim ───────────────────
function parseCsv(text: string): string[][] {
  const grid: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else q = false
      } else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.some((c) => c.trim() !== '')) grid.push(row)
      row = []
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    if (row.some((c) => c.trim() !== '')) grid.push(row)
  }
  return grid
}
const NAME_H = /^(name|company|company.?name|business|business.?name|organi[sz]ation)$/i
const LOC_H = /^(location|town|city|postcode|postal.?code|county|area)$/i
const WEB_H = /^(website|url|domain|site|web|homepage)$/i
function rowsFromCsv(text: string): CsvRow[] {
  const grid = parseCsv(text)
  if (!grid.length) return []
  const header = grid[0].map((h) => h.trim())
  const ni = header.findIndex((h) => NAME_H.test(h))
  const li = header.findIndex((h) => LOC_H.test(h))
  const wi = header.findIndex((h) => WEB_H.test(h))
  if (ni === -1 && wi === -1) {
    return grid
      .map((r) => ({ name: (r[0] || '').trim() }))
      .filter((r) => r.name)
  }
  return grid
    .slice(1)
    .map((r) => ({
      name: ni >= 0 ? (r[ni] || '').trim() : undefined,
      location: li >= 0 ? (r[li] || '').trim() : undefined,
      website: wi >= 0 ? (r[wi] || '').trim() : undefined,
    }))
    .filter((r) => r.name || r.website)
}

// ── Results columns ─────────────────────────────────────────────────────────
type Col = { key: string; label: string; always?: boolean }
const COLS: Col[] = [
  { key: 'business', label: 'Business', always: true },
  { key: 'website', label: 'Website', always: true },
  { key: 'emails', label: 'Emails' },
  { key: 'phones', label: 'Phones' },
  { key: 'address', label: 'Address' },
  { key: 'business_type', label: 'Type' },
  { key: 'industry', label: 'Industry' },
  { key: 'keywords', label: 'Keywords' },
  { key: 'status', label: 'Status', always: true },
]

function cellVal(r: ResultItem, k: string): string {
  switch (k) {
    case 'emails':
      return (r.emails || []).join(', ')
    case 'phones':
      return (r.phones || []).join(', ')
    case 'address':
      return r.address || ''
    case 'business_type':
      return r.business_type || ''
    case 'industry':
      return r.industry || ''
    case 'keywords':
      return (r.keywords || []).join(', ')
    default:
      return ''
  }
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
}

export default function EnrichmentPage() {
  const [raw, setRaw] = useState('')
  const [rows, setRows] = useState<CsvRow[]>([])
  const [fields, setFields] = useState<string[]>(DEFAULT_FIELD_KEYS.slice())
  const [job, setJob] = useState<Job | null>(null)
  const [results, setResults] = useState<ResultItem[]>([])
  const [starting, setStarting] = useState(false)
  const [sending, setSending] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3500)
  }, [])

  useEffect(() => {
    setRows(rowsFromCsv(raw))
  }, [raw])

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  function toggleField(key: string, checked: boolean) {
    setFields((prev) =>
      checked
        ? prev.includes(key)
          ? prev
          : [...prev, key]
        : prev.filter((k) => k !== key)
    )
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setRaw(String(reader.result || ''))
    reader.readAsText(file)
  }

  function startPolling(jobId: number) {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/data/ch/jobs/' + jobId)
        if (!res.ok) return
        const data = await res.json()
        const j: Job = data.job
        setJob(j)
        setResults(data.items || [])
        if (j.status === 'done' || j.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          setStarting(false)
          showToast(
            j.status === 'done'
              ? `Done — ${j.ok}/${j.total} enriched`
              : `Failed: ${j.error || 'error'}`
          )
        }
      } catch {
        /* keep polling */
      }
    }, 5000)
  }

  async function start() {
    if (!rows.length) {
      showToast('Paste or upload some rows first')
      return
    }
    if (!fields.length) {
      showToast('Tick at least one field to extract')
      return
    }
    setStarting(true)
    try {
      const res = await fetch('/api/data/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, fields, label: `list: ${rows.length}` }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      setResults([])
      setJob({
        id: data.jobId,
        status: 'queued',
        total: data.total,
        done: 0,
        ok: 0,
        failed: 0,
        error: null,
      })
      showToast(`Queued job #${data.jobId} — ${data.total} businesses`)
      startPolling(data.jobId)
    } catch (e) {
      showToast('Could not start: ' + (e as Error).message)
      setStarting(false)
    }
  }

  function cancelJob() {
    if (!job) return
    if (
      !confirm(
        'Cancel job #' + job.id + '? Businesses already processed are kept.'
      )
    )
      return
    fetch('/api/data/ch/jobs/' + job.id + '/cancel', { method: 'POST' })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then((res) => {
        if (!res.ok) throw new Error(res.d.error || 'Failed')
        showToast('Cancelled job #' + job.id)
        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
        setStarting(false)
        setJob((j) => (j ? { ...j, status: 'cancelled' } : j))
      })
      .catch((e) => showToast('Could not cancel: ' + e.message))
  }

  function sendToContacts() {
    if (!job || job.status !== 'done') return
    if (
      !confirm(
        "Send this job's scraped emails into Contacts? They'll appear on the Contacts page ready to verify and push to PlusVibe."
      )
    )
      return
    setSending(true)
    fetch('/api/data/ch/jobs/' + job.id + '/to-contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then((res) => {
        setSending(false)
        if (!res.ok) throw new Error(res.d.error || 'Failed')
        showToast(
          `Added ${res.d.contacts_inserted} contact(s) from ${res.d.companies} companies — open Contacts to verify & push.`
        )
      })
      .catch((e) => {
        setSending(false)
        showToast('Could not send: ' + e.message)
      })
  }

  function exportCsv() {
    if (!results.length) return
    const cols = ['name', 'location', 'domain', ...fields.filter((f) => f !== 'website')]
    const cell = (r: ResultItem, f: string): string => {
      switch (f) {
        case 'name':
          return r.company_name || ''
        case 'location':
          return r.location || ''
        case 'domain':
          return r.domain || r.website || ''
        case 'emails':
          return (r.emails || []).join('; ')
        case 'phones':
          return (r.phones || []).join('; ')
        case 'address':
          return r.address || ''
        case 'social_links':
          return r.socials ? Object.values(r.socials).join('; ') : ''
        case 'description':
          return r.description || ''
        case 'business_type':
          return r.business_type || ''
        case 'industry':
          return r.industry || ''
        case 'keywords':
          return (r.keywords || []).join('; ')
        default:
          return ''
      }
    }
    const lines = [cols.join(',')].concat(
      results.map((r) => cols.map((c) => csvEscape(cell(r, c))).join(','))
    )
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `enrichment-${job ? job.id : 'results'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const show = (k: string) => fields.includes(k)
  const visibleCols = COLS.filter((c) => c.always || show(c.key))
  const jobActive = job && (job.status === 'queued' || job.status === 'running')
  const pct = job
    ? job.status === 'done'
      ? 100
      : job.total > 0
        ? Math.round((job.done / job.total) * 100)
        : 0
    : 0
  const canSendToContacts = !!(
    job &&
    job.status === 'done' &&
    (job.ok || 0) > 0
  )

  return (
    <div className="mx-auto max-w-[1400px] p-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Business Enrichment</h1>
        <p className="mt-1 text-sm text-gray-500">
          Drop in any list of businesses — get back websites, contact details,
          address, type, industry and keywords. For Companies House data, use the{' '}
          <a href="/data/ch-pipeline" className="text-blue-600 hover:underline">
            CH Pipeline
          </a>
          .
        </p>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Input */}
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
              1. Your list
            </span>
            <label className="cursor-pointer text-xs text-blue-600">
              Upload CSV
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={onFile}
              />
            </label>
          </div>
          <div className="p-4">
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={
                'name,location,website\nAcme Care Ltd,Leeds,\nSmith Plumbing,Bristol,smithplumbing.co.uk'
              }
              className="h-48 w-full resize-y rounded-md border border-gray-200 bg-white p-2.5 font-mono text-xs text-gray-800 outline-none focus:border-blue-500"
            />
            <div className="mt-2 text-xs leading-relaxed text-gray-500">
              CSV with a header row. Recognised columns:{' '}
              <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] text-blue-600">
                name
              </code>
              ,{' '}
              <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] text-blue-600">
                location
              </code>
              /
              <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] text-blue-600">
                postcode
              </code>
              ,{' '}
              <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] text-blue-600">
                website
              </code>
              . A known website skips discovery.{' '}
              {rows.length ? `· ${rows.length} rows parsed` : ''}
            </div>
          </div>
        </div>

        {/* Fields */}
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
              2. What to extract
            </span>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {FIELD_CATALOG.map((f) => (
                <label
                  key={f.key}
                  className="flex cursor-pointer items-center gap-2 text-sm text-gray-700"
                >
                  <Checkbox
                    checked={fields.includes(f.key)}
                    onCheckedChange={(c) => toggleField(f.key, c === true)}
                  />
                  <span>{f.label}</span>
                  {f.claude && (
                    <span className="rounded border border-blue-200 px-1 text-[10px] font-bold text-blue-600">
                      AI
                    </span>
                  )}
                </label>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-2.5">
              <Button onClick={start} disabled={starting}>
                Enrich businesses
              </Button>
              {results.length > 0 && (
                <Button variant="outline" onClick={exportCsv}>
                  Download CSV
                </Button>
              )}
              {canSendToContacts && (
                <Button
                  variant="outline"
                  onClick={sendToContacts}
                  disabled={sending}
                >
                  {sending ? 'Sending…' : '→ Send to Contacts'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Progress */}
      {job && (
        <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-1.5 flex items-center justify-between text-sm">
            <span>
              <strong>Job #{job.id}</strong> · {job.status}
            </span>
            <span className="flex items-center gap-3">
              <span className="text-gray-400">
                {job.done}/{job.total} done · {job.ok} enriched · {job.failed}{' '}
                failed
              </span>
              {jobActive && (
                <Button
                  variant="outline"
                  className="h-7 px-3"
                  onClick={cancelJob}
                >
                  Cancel
                </Button>
              )}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-gray-100">
            <div
              className={`h-full transition-all ${
                job.status === 'failed' ? 'bg-red-500' : 'bg-blue-600'
              }`}
              style={{ width: pct + '%' }}
            />
          </div>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <div className="max-h-[600px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {visibleCols.map((c) => (
                    <TableHead key={c.key}>{c.label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r, i) => (
                  <TableRow key={i}>
                    {visibleCols.map((c) => {
                      if (c.key === 'business') {
                        return (
                          <TableCell key={c.key}>
                            <div className="font-semibold text-gray-900">
                              {r.company_name || '—'}
                            </div>
                            {r.location && (
                              <div className="text-[11px] text-gray-500">
                                {r.location}
                              </div>
                            )}
                          </TableCell>
                        )
                      }
                      if (c.key === 'website') {
                        const w = r.domain || r.website
                        return (
                          <TableCell key={c.key}>
                            {w || <span className="text-gray-400">—</span>}
                          </TableCell>
                        )
                      }
                      if (c.key === 'status') {
                        const isError = r.item_status === 'error'
                        const cls = isError
                          ? 'text-red-600'
                          : r.scrape_status
                            ? 'text-green-600'
                            : 'text-gray-500'
                        const txt = isError
                          ? 'failed'
                          : r.scrape_status ||
                            (r.item_status === 'done' ? 'done' : 'pending')
                        return (
                          <TableCell key={c.key}>
                            <span
                              className={`text-[11px] font-bold uppercase ${cls}`}
                            >
                              {txt}
                            </span>
                          </TableCell>
                        )
                      }
                      const v = cellVal(r, c.key)
                      return (
                        <TableCell
                          key={c.key}
                          className="max-w-[220px] truncate"
                          title={v}
                        >
                          {v || <span className="text-gray-400">—</span>}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 rounded-md bg-gray-900 px-4 py-3 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
