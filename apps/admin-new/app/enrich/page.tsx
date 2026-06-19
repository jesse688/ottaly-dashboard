'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { FieldPicker } from '@/components/field-picker'
import { DEFAULT_FIELD_KEYS } from '@/lib/enrich-fields'

interface InputRow { name?: string; location?: string; website?: string }

interface Job {
  id: number
  status: 'queued' | 'running' | 'done' | 'failed'
  total: number
  done: number
  ok: number
  failed: number
  error: string | null
}

interface ResultItem {
  company_name: string | null
  location: string | null
  domain: string | null
  item_status: string
  website: string | null
  emails: string[] | null
  phones: string[] | null
  address: string | null
  business_type: string | null
  industry: string | null
  keywords: string[] | null
  description: string | null
  socials: Record<string, string> | null
  scrape_status: string | null
}

// ── Minimal CSV parser (handles quotes, commas, CRLF) ──────────────────────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else inQuotes = false
      } else cell += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((c) => c.trim() !== '')) rows.push(row) }
  return rows
}

const NAME_H = /^(name|company|company.?name|business|business.?name|organi[sz]ation)$/i
const LOC_H = /^(location|town|city|postcode|postal.?code|county|area)$/i
const WEB_H = /^(website|url|domain|site|web|homepage)$/i

function rowsFromCsv(text: string): InputRow[] {
  const grid = parseCsv(text)
  if (grid.length === 0) return []
  const header = grid[0].map((h) => h.trim())
  const ni = header.findIndex((h) => NAME_H.test(h))
  const li = header.findIndex((h) => LOC_H.test(h))
  const wi = header.findIndex((h) => WEB_H.test(h))

  // No recognisable header → treat every line's first cell as a business name.
  if (ni === -1 && wi === -1) {
    return grid.map((r) => ({ name: (r[0] || '').trim() })).filter((r) => r.name)
  }
  return grid.slice(1).map((r) => ({
    name: ni >= 0 ? (r[ni] || '').trim() : undefined,
    location: li >= 0 ? (r[li] || '').trim() : undefined,
    website: wi >= 0 ? (r[wi] || '').trim() : undefined,
  })).filter((r) => (r.name && r.name) || (r.website && r.website))
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export default function EnrichPage() {
  const [raw, setRaw] = useState('')
  const [rows, setRows] = useState<InputRow[]>([])
  const [fields, setFields] = useState<string[]>(DEFAULT_FIELD_KEYS)
  const [activeJob, setActiveJob] = useState<Job | null>(null)
  const [results, setResults] = useState<ResultItem[]>([])
  const [toast, setToast] = useState('')

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  useEffect(() => { setRows(rowsFromCsv(raw)) }, [raw])

  const onFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => setRaw(String(reader.result || ''))
    reader.readAsText(file)
  }

  const loadResults = useCallback(async (jobId: number) => {
    try {
      const res = await fetch(`/api/ch/jobs/${jobId}`)
      const data = await res.json()
      if (res.ok) setResults(data.items || [])
    } catch { /* ignore */ }
  }, [])

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startPolling = useCallback((jobId: number) => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/ch/jobs')
        const data = await res.json()
        const job: Job | undefined = (data.rows || []).find((j: Job) => j.id === jobId)
        if (!job) return
        setActiveJob(job)
        await loadResults(jobId)
        if (job.status === 'done' || job.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          showToast(job.status === 'done' ? `Done — ${job.ok}/${job.total} enriched` : `Failed: ${job.error || 'error'}`)
        }
      } catch { /* keep polling */ }
    }, 5000)
  }, [loadResults])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const start = async () => {
    if (rows.length === 0) { showToast('Paste or upload some rows first'); return }
    if (fields.length === 0) { showToast('Tick at least one field to extract'); return }
    try {
      const res = await fetch('/api/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, fields, label: `list: ${rows.length}` }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      setResults([])
      setActiveJob({ id: data.jobId, status: 'queued', total: data.total, done: 0, ok: 0, failed: 0, error: null })
      startPolling(data.jobId)
      showToast(`Queued job #${data.jobId} — ${data.total} businesses`)
    } catch (err) {
      showToast('Could not start: ' + (err as Error).message)
    }
  }

  const exportCsv = () => {
    if (results.length === 0) return
    const cols = ['name', 'location', 'domain', ...fields.filter((f) => f !== 'website')]
    const header = cols.join(',')
    const lines = results.map((r) => {
      const cell = (f: string): string => {
        switch (f) {
          case 'name': return r.company_name || ''
          case 'location': return r.location || ''
          case 'domain': return r.domain || r.website || ''
          case 'emails': return (r.emails || []).join('; ')
          case 'phones': return (r.phones || []).join('; ')
          case 'address': return r.address || ''
          case 'social_links': return r.socials ? Object.values(r.socials).join('; ') : ''
          case 'description': return r.description || ''
          case 'business_type': return r.business_type || ''
          case 'industry': return r.industry || ''
          case 'keywords': return (r.keywords || []).join('; ')
          default: return ''
        }
      }
      return cols.map((c) => csvEscape(cell(c))).join(',')
    })
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `enrichment-${activeJob?.id ?? 'results'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const jobRunning = activeJob && (activeJob.status === 'queued' || activeJob.status === 'running')
  const pct = activeJob && activeJob.total > 0 ? Math.round((activeJob.done / activeJob.total) * 100) : 0
  const show = (f: string) => fields.includes(f)

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b px-8 py-6">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-2xl font-bold text-gray-900">Business Enrichment</h1>
          <p className="text-sm text-gray-600 mt-1">
            Drop in a list of businesses — get back websites, contact details, address, business type, industry and keywords.
          </p>
        </div>
      </div>

      {/* Input */}
      <div className="px-8 py-6">
        <div className="max-w-7xl mx-auto grid md:grid-cols-2 gap-6">
          <div className="bg-white rounded-lg border p-5">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-bold uppercase tracking-wider text-gray-600">1. Your list</div>
              <label className="text-xs text-blue-600 cursor-pointer hover:underline">
                Upload CSV
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
              </label>
            </div>
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={'name,location,website\nAcme Care Ltd,Leeds,\nSmith Plumbing,Bristol,smithplumbing.co.uk'}
              className="w-full h-48 px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:border-blue-500"
            />
            <div className="text-xs text-gray-500 mt-2">
              CSV with a header row. Recognised columns: <code>name</code>, <code>location</code>/<code>postcode</code>, <code>website</code>.
              A known website skips discovery. {rows.length > 0 && <span className="font-semibold text-gray-700">· {rows.length} rows parsed</span>}
            </div>
          </div>

          <div className="bg-white rounded-lg border p-5">
            <div className="text-sm font-bold uppercase tracking-wider text-gray-600 mb-3">2. What to extract</div>
            <FieldPicker value={fields} onChange={setFields} />
            <div className="mt-5 flex items-center gap-3">
              <Button onClick={start} disabled={rows.length === 0 || !!jobRunning}>
                {jobRunning ? 'Running…' : `Enrich ${rows.length || ''} businesses`}
              </Button>
              {results.length > 0 && <Button variant="outline" onClick={exportCsv}>Download CSV</Button>}
            </div>
          </div>
        </div>
      </div>

      {/* Progress */}
      {activeJob && (
        <div className="px-8 pb-2">
          <div className="max-w-7xl mx-auto bg-white rounded-lg border p-4">
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="font-semibold">Job #{activeJob.id} · {activeJob.status}</span>
              <span className="text-gray-600">{activeJob.done}/{activeJob.total} done · {activeJob.ok} enriched · {activeJob.failed} failed</span>
            </div>
            <div className="h-2 w-full bg-gray-200 rounded-full overflow-hidden">
              <div className={`h-full transition-all ${activeJob.status === 'failed' ? 'bg-red-500' : 'bg-blue-600'}`} style={{ width: `${activeJob.status === 'done' ? 100 : pct}%` }} />
            </div>
          </div>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="px-8 py-6">
          <div className="max-w-7xl mx-auto bg-white rounded-lg border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50 hover:bg-gray-50">
                  <TableHead className="text-xs font-bold uppercase">Business</TableHead>
                  <TableHead className="text-xs font-bold uppercase">Website</TableHead>
                  {show('emails') && <TableHead className="text-xs font-bold uppercase">Emails</TableHead>}
                  {show('phones') && <TableHead className="text-xs font-bold uppercase">Phones</TableHead>}
                  {show('address') && <TableHead className="text-xs font-bold uppercase">Address</TableHead>}
                  {show('business_type') && <TableHead className="text-xs font-bold uppercase">Type</TableHead>}
                  {show('industry') && <TableHead className="text-xs font-bold uppercase">Industry</TableHead>}
                  {show('keywords') && <TableHead className="text-xs font-bold uppercase">Keywords</TableHead>}
                  <TableHead className="text-xs font-bold uppercase">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r, i) => (
                  <TableRow key={i} className="hover:bg-blue-50 align-top">
                    <TableCell>
                      <div className="font-semibold">{r.company_name || '—'}</div>
                      {r.location && <div className="text-xs text-gray-500">{r.location}</div>}
                    </TableCell>
                    <TableCell className="text-sm">{r.domain || <span className="text-gray-400">—</span>}</TableCell>
                    {show('emails') && <TableCell className="text-sm">{(r.emails || []).join(', ') || <span className="text-gray-400">—</span>}</TableCell>}
                    {show('phones') && <TableCell className="text-sm">{(r.phones || []).join(', ') || <span className="text-gray-400">—</span>}</TableCell>}
                    {show('address') && <TableCell className="text-sm max-w-48 truncate" title={r.address || ''}>{r.address || <span className="text-gray-400">—</span>}</TableCell>}
                    {show('business_type') && <TableCell className="text-sm">{r.business_type || <span className="text-gray-400">—</span>}</TableCell>}
                    {show('industry') && <TableCell className="text-sm">{r.industry || <span className="text-gray-400">—</span>}</TableCell>}
                    {show('keywords') && <TableCell className="text-sm max-w-48 truncate" title={(r.keywords || []).join(', ')}>{(r.keywords || []).join(', ') || <span className="text-gray-400">—</span>}</TableCell>}
                    <TableCell>
                      <span className={`text-xs font-bold uppercase ${r.item_status === 'error' ? 'text-red-600' : r.scrape_status ? 'text-green-600' : 'text-gray-400'}`}>
                        {r.item_status === 'error' ? 'failed' : r.scrape_status || (r.item_status === 'done' ? 'done' : 'pending')}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 bg-gray-900 text-white px-4 py-3 rounded-lg text-sm font-medium shadow-lg">{toast}</div>
      )}
    </div>
  )
}
