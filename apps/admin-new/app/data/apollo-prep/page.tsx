'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ── Apollo net-new search URLs (preserved verbatim from the legacy page) ──────
const APOLLO_ACCT1_URL =
  'https://app.apollo.io/#/people?page=1&contactEmailStatusV2[]=verified&contactEmailStatusV2[]=user_managed&organizationLocations[]=London%2C%20United%20Kingdom&organizationLocations[]=Reading%2C%20United%20Kingdom&organizationLocations[]=Guildford%2C%20United%20Kingdom&organizationLocations[]=Oxford%2C%20United%20Kingdom&organizationLocations[]=Brighton%2C%20United%20Kingdom&organizationLocations[]=Milton%20Keynes%2C%20United%20Kingdom&organizationLocations[]=Southampton%2C%20United%20Kingdom&organizationLocations[]=Kingston%20upon%20Thames%2C%20United%20Kingdom&organizationLocations[]=Redhill%2C%20United%20Kingdom&organizationLocations[]=Slough%2C%20United%20Kingdom&organizationLocations[]=Portsmouth%2C%20United%20Kingdom&organizationLocations[]=Tonbridge%2C%20United%20Kingdom&organizationLocations[]=Medway%2C%20United%20Kingdom&organizationLocations[]=Twickenham%2C%20United%20Kingdom&organizationLocations[]=Canterbury%2C%20United%20Kingdom&organizationLocations[]=Enfield%2C%20United%20Kingdom&organizationLocations[]=Harrow%2C%20United%20Kingdom&organizationLocations[]=Dartford%2C%20United%20Kingdom&organizationLocations[]=Croydon%2C%20United%20Kingdom&organizationLocations[]=Southall%2C%20United%20Kingdom&organizationLocations[]=Romford%2C%20United%20Kingdom&organizationLocations[]=Bromley%2C%20United%20Kingdom&organizationLocations[]=Ilford%2C%20United%20Kingdom&organizationLocations[]=Sutton%2C%20United%20Kingdom&organizationLocations[]=Bracknell%2C%20United%20Kingdom&organizationLocations[]=Maidstone%2C%20United%20Kingdom&organizationLocations[]=Basingstoke%2C%20United%20Kingdom&organizationLocations[]=Woking%2C%20United%20Kingdom&organizationLocations[]=Winchester%2C%20United%20Kingdom&organizationLocations[]=Hove%2C%20United%20Kingdom&organizationLocations[]=Farnborough%2C%20United%20Kingdom&organizationLocations[]=Maidenhead%2C%20United%20Kingdom&organizationLocations[]=Chichester%2C%20United%20Kingdom&organizationLocations[]=Ashford%2C%20United%20Kingdom&organizationLocations[]=Horsham%2C%20United%20Kingdom&organizationLocations[]=High%20Wycombe%2C%20United%20Kingdom&organizationLocations[]=Crawley%2C%20United%20Kingdom&organizationLocations[]=Hastings%2C%20United%20Kingdom&organizationLocations[]=Worthing%2C%20United%20Kingdom&organizationLocations[]=Aylesbury%2C%20United%20Kingdom&organizationLocations[]=Reigate%2C%20United%20Kingdom&organizationLocations[]=Eastbourne%2C%20United%20Kingdom&organizationLocations[]=Windsor%2C%20United%20Kingdom&organizationLocations[]=Westminster%2C%20United%20Kingdom&organizationLocations[]=Wembley%2C%20United%20Kingdom&organizationLocations[]=Camden%2C%20United%20Kingdom&recommendationConfigId=score&currentlyNotUsingAnyOfTechnologyUids[]=outlook&prospectedByCurrentTeam[]=no&sortByField=person_name.raw&sortAscending=false'

const APOLLO_ACCT2_URL =
  'https://app.apollo.io/#/people?page=1&contactEmailStatusV2[]=verified&contactEmailStatusV2[]=user_managed&organizationLocations[]=United%20Kingdom&organizationNotLocations[]=London%2C%20United%20Kingdom&organizationNotLocations[]=Reading%2C%20United%20Kingdom&organizationNotLocations[]=Guildford%2C%20United%20Kingdom&organizationNotLocations[]=Oxford%2C%20United%20Kingdom&organizationNotLocations[]=Brighton%2C%20United%20Kingdom&organizationNotLocations[]=Milton%20Keynes%2C%20United%20Kingdom&organizationNotLocations[]=Southampton%2C%20United%20Kingdom&organizationNotLocations[]=Kingston%20upon%20Thames%2C%20United%20Kingdom&organizationNotLocations[]=Redhill%2C%20United%20Kingdom&organizationNotLocations[]=Slough%2C%20United%20Kingdom&organizationNotLocations[]=Portsmouth%2C%20United%20Kingdom&organizationNotLocations[]=Tonbridge%2C%20United%20Kingdom&organizationNotLocations[]=Medway%2C%20United%20Kingdom&organizationNotLocations[]=Twickenham%2C%20United%20Kingdom&organizationNotLocations[]=Canterbury%2C%20United%20Kingdom&organizationNotLocations[]=Enfield%2C%20United%20Kingdom&organizationNotLocations[]=Harrow%2C%20United%20Kingdom&organizationNotLocations[]=Dartford%2C%20United%20Kingdom&organizationNotLocations[]=Croydon%2C%20United%20Kingdom&organizationNotLocations[]=Southall%2C%20United%20Kingdom&organizationNotLocations[]=Romford%2C%20United%20Kingdom&organizationNotLocations[]=Bromley%2C%20United%20Kingdom&organizationNotLocations[]=Ilford%2C%20United%20Kingdom&organizationNotLocations[]=Sutton%2C%20United%20Kingdom&organizationNotLocations[]=Bracknell%2C%20United%20Kingdom&organizationNotLocations[]=Maidstone%2C%20United%20Kingdom&organizationNotLocations[]=Basingstoke%2C%20United%20Kingdom&organizationNotLocations[]=Woking%2C%20United%20Kingdom&organizationNotLocations[]=Winchester%2C%20United%20Kingdom&organizationNotLocations[]=Hove%2C%20United%20Kingdom&organizationNotLocations[]=Farnborough%2C%20United%20Kingdom&organizationNotLocations[]=Maidenhead%2C%20United%20Kingdom&organizationNotLocations[]=Chichester%2C%20United%20Kingdom&organizationNotLocations[]=Ashford%2C%20United%20Kingdom&organizationNotLocations[]=Horsham%2C%20United%20Kingdom&organizationNotLocations[]=High%20Wycombe%2C%20United%20Kingdom&organizationNotLocations[]=Crawley%2C%20United%20Kingdom&organizationNotLocations[]=Hastings%2C%20United%20Kingdom&organizationNotLocations[]=Worthing%2C%20United%20Kingdom&organizationNotLocations[]=Aylesbury%2C%20United%20Kingdom&organizationNotLocations[]=Reigate%2C%20United%20Kingdom&organizationNotLocations[]=Eastbourne%2C%20United%20Kingdom&organizationNotLocations[]=Windsor%2C%20United%20Kingdom&organizationNotLocations[]=Westminster%2C%20United%20Kingdom&organizationNotLocations[]=Wembley%2C%20United%20Kingdom&organizationNotLocations[]=Camden%2C%20United%20Kingdom&recommendationConfigId=score&currentlyNotUsingAnyOfTechnologyUids[]=outlook&prospectedByCurrentTeam[]=no&sortByField=person_name.raw&sortAscending=false'

// ── Region split (company_region values, matching the legacy export logic) ────
const ACCT1_REGIONS = ['London', 'South East']
const ALL_REGIONS = [
  'London', 'South East', 'North West', 'East of England', 'West Midlands',
  'South West', 'Yorkshire and the Humber', 'East Midlands', 'Scotland',
  'North East', 'Northern Ireland', 'Wales',
]
const ACCT2_REGIONS = ALL_REGIONS.filter(r => !ACCT1_REGIONS.includes(r))

// ── CSV split constants ───────────────────────────────────────────────────────
const MAX_BYTES = 45 * 1024 * 1024 // 45 MB
const MAX_ROWS = 99999 // Apollo counts the header row, so 99999 data rows = 100000 total
const EMAIL_COLS = ['email', 'e-mail', 'email address', 'email_address', 'emailaddress', 'e-mail address', 'mail']

type PendingFile = { name: string; file: File }
type Chunk = { name: string; csv: string; rows: number; sizeMB: string }
type LogLine = { msg: string; type: '' | 'ok' | 'warn' | 'err' }

// ── CSV parsing (ported verbatim from the legacy page) ────────────────────────
function parseCSV(text: string): { emails: string[]; headerFound: string } | null {
  const lines = text.split(/\r?\n/)
  if (!lines.length) return null
  const firstLine = lines[0]
  const delim = firstLine.includes('\t') ? '\t' : firstLine.includes(';') ? ';' : ','

  function parseLine(line: string): string[] {
    const fields: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
        else inQ = !inQ
      } else if (ch === delim && !inQ) { fields.push(cur); cur = '' }
      else cur += ch
    }
    fields.push(cur)
    return fields
  }

  const headers = parseLine(lines[0]).map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''))
  const emailIdx = headers.findIndex(h => EMAIL_COLS.includes(h))
  if (emailIdx === -1) return null

  const emails: string[] = []
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const row = parseLine(lines[i])
    const raw = (row[emailIdx] || '').trim().toLowerCase().replace(/^"|"$/g, '')
    if (raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) emails.push(raw)
  }
  return { emails, headerFound: headers[emailIdx] }
}

const SUBHEAD = 'text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-2'

export default function ApolloPrepPage() {
  // ── Account split export ────────────────────────────────────────────────
  const [splitStatus, setSplitStatus] = useState('')
  const [exporting, setExporting] = useState<0 | 1 | 2>(0)

  async function exportSplit(account: 1 | 2) {
    const regions = account === 1 ? ACCT1_REGIONS : ACCT2_REGIONS
    setExporting(account)
    let offset = 0
    let fileNum = 1
    let totalExported = 0
    try {
      while (true) {
        setSplitStatus(
          `Exporting Account ${account} — file ${fileNum}${
            totalExported ? `, ${totalExported.toLocaleString()} rows so far` : ''
          }...`
        )
        const params = new URLSearchParams({ offset: String(offset), companyRegion: regions.join(',') })
        const r = await fetch(`/api/data/apollo-prep/export?${params}`)
        if (!r.ok) { setSplitStatus(`Export failed (${r.status})`); break }

        const hasMore = r.headers.get('X-Has-More') === 'true'
        const nextOffset = parseInt(r.headers.get('X-Next-Offset') || '0')
        const rowsInFile = parseInt(r.headers.get('X-Rows-In-File') || '0')

        const blob = await r.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `apollo-account${account}-export-${fileNum}.csv`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)

        totalExported += rowsInFile
        fileNum++
        offset = nextOffset
        if (!hasMore) break
      }
      setSplitStatus(
        `Done — Account ${account} export complete: ${totalExported.toLocaleString()} rows in ${
          fileNum - 1
        } file${fileNum > 2 ? 's' : ''}.`
      )
    } catch (err) {
      setSplitStatus(`Error: ${(err as Error).message}`)
    } finally {
      setExporting(0)
    }
  }

  // ── CSV upload prep ─────────────────────────────────────────────────────
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [chunks, setChunks] = useState<Chunk[]>([])
  const [processing, setProcessing] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const [progress, setProgress] = useState(0)
  const [log, setLog] = useState<LogLine[]>([])
  const [stats, setStats] = useState<{ total: number; dupes: number; skipped: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function addFiles(fileList: FileList | null) {
    if (!fileList) return
    setPendingFiles(prev => {
      const next = [...prev]
      for (const f of Array.from(fileList)) {
        if (!f.name.toLowerCase().endsWith('.csv')) continue
        if (next.some(p => p.name === f.name && p.file.size === f.size)) continue
        next.push({ name: f.name, file: f })
      }
      return next
    })
  }

  function removeFile(idx: number) {
    setPendingFiles(prev => prev.filter((_, i) => i !== idx))
  }

  function clearAll() {
    setPendingFiles([])
    setChunks([])
    setShowResults(false)
    setLog([])
    setStats(null)
  }

  async function process() {
    if (!pendingFiles.length) return
    setProcessing(true)
    setShowResults(true)
    setLog([])
    setProgress(0)
    const newLog: LogLine[] = []
    const pushLog = (msg: string, type: LogLine['type'] = '') => {
      newLog.push({ msg, type })
      setLog([...newLog])
    }

    const allEmails = new Set<string>()
    let skippedNoCol = 0
    let dupes = 0

    for (let fi = 0; fi < pendingFiles.length; fi++) {
      const { name, file } = pendingFiles[fi]
      setProgress(Math.round((fi / pendingFiles.length) * 60))
      const text = await file.text()
      const result = parseCSV(text)
      if (!result) {
        pushLog(`⚠ ${name} — no email column found (looked for: ${EMAIL_COLS.slice(0, 4).join(', ')}…)`, 'warn')
        skippedNoCol++
        continue
      }
      const before = allEmails.size
      for (const e of result.emails) {
        if (allEmails.has(e)) dupes++
        else allEmails.add(e)
      }
      const added = allEmails.size - before
      pushLog(`✓ ${name} — col "${result.headerFound}", ${result.emails.length} valid, ${added} new`, 'ok')
    }

    setProgress(70)
    const total = allEmails.size
    if (!total) {
      pushLog('No valid emails found across all files.', 'err')
      setProcessing(false)
      return
    }

    // Split into chunks ≤ 45 MB / 99,999 rows.
    const emailArr = [...allEmails]
    const header = 'Email'
    const newChunks: Chunk[] = []
    let chunkIdx = 0
    let i = 0
    while (i < emailArr.length) {
      chunkIdx++
      let rows = 0
      let sizeBytes = header.length + 1
      const lines = [header]
      while (i < emailArr.length && rows < MAX_ROWS) {
        const line = emailArr[i]
        const lineBytes = line.length + 1
        if (sizeBytes + lineBytes > MAX_BYTES && rows > 0) break
        lines.push(line)
        sizeBytes += lineBytes
        rows++
        i++
      }
      const csv = lines.join('\n')
      const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1)
      newChunks.push({ name: `apollo-chunk-${String(chunkIdx).padStart(2, '0')}.csv`, csv, rows, sizeMB })
      pushLog(`Chunk ${chunkIdx}: ${rows.toLocaleString()} emails, ~${sizeMB} MB`)
    }

    setProgress(100)
    setChunks(newChunks)
    setStats({ total, dupes, skipped: skippedNoCol })
    setProcessing(false)
  }

  function downloadChunk(idx: number) {
    const c = chunks[idx]
    const blob = new Blob([c.csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = Object.assign(document.createElement('a'), { href: url, download: c.name })
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  function downloadAll() {
    if (!chunks.length) return
    chunks.forEach(c => {
      const blob = new Blob([c.csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = Object.assign(document.createElement('a'), { href: url, download: c.name })
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    })
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-5">

        {/* ── Apollo Account Split ─────────────────────────────────────── */}
        <section className="bg-white border border-gray-200 rounded-xl p-6">
          <h1 className="text-xl font-bold text-gray-900">Apollo Account Split — UK</h1>
          <p className="text-sm text-gray-500 mt-1 mb-5">
            Export your existing database contacts split by account, or find net-new contacts in Apollo.
            Account 1 = London + South East; Account 2 = rest of the UK. No duplicates between accounts.
          </p>

          <div className="mb-6">
            <div className={SUBHEAD}>Export from your database</div>
            <div className="flex gap-3 flex-wrap items-center">
              <Button
                onClick={() => exportSplit(1)}
                disabled={exporting !== 0}
                className="bg-[#224388] hover:bg-[#1a3370] text-white"
              >
                {exporting === 1 ? '↓ Exporting…' : '↓ Export Account 1 — London + South East'}
              </Button>
              <Button
                onClick={() => exportSplit(2)}
                disabled={exporting !== 0}
                className="bg-[#1F6F78] hover:bg-[#185f67] text-white"
              >
                {exporting === 2 ? '↓ Exporting…' : '↓ Export Account 2 — Rest of UK'}
              </Button>
            </div>
            {splitStatus && <div className="text-xs text-gray-500 mt-2">{splitStatus}</div>}
          </div>

          <div>
            <div className={SUBHEAD}>Find net-new contacts in Apollo</div>
            <div className="flex gap-3 flex-wrap">
              <a href={APOLLO_ACCT1_URL} target="_blank" rel="noopener noreferrer">
                <Button className="bg-[#224388] hover:bg-[#1a3370] text-white">
                  ↗ Account 1 — London + South East
                </Button>
              </a>
              <a href={APOLLO_ACCT2_URL} target="_blank" rel="noopener noreferrer">
                <Button className="bg-[#1F6F78] hover:bg-[#185f67] text-white">
                  ↗ Account 2 — Rest of UK
                </Button>
              </a>
            </div>
          </div>
        </section>

        {/* ── Apollo Upload Prep ───────────────────────────────────────── */}
        <section className="bg-white border border-gray-200 rounded-xl p-6">
          <h1 className="text-xl font-bold text-gray-900">Apollo Upload Prep</h1>
          <p className="text-sm text-gray-500 mt-1 mb-5">
            Drop any number of CSVs. Emails are extracted, deduplicated, stripped of all other columns,
            and split into chunks ≤ 45 MB / 100,000 rows — ready to import straight into Apollo.
          </p>

          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files) }}
            className={`border-2 border-dashed rounded-xl px-8 py-12 text-center cursor-pointer transition-colors ${
              dragOver ? 'border-[#1F6F78] bg-[#EEF9FA]' : 'border-gray-200 bg-gray-50'
            }`}
          >
            <div className="text-4xl mb-3">📂</div>
            <div className="text-[15px] font-semibold text-gray-900">Drop CSV files here, or click to browse</div>
            <div className="text-xs text-gray-500 mt-1">
              Any column named Email / email / Email Address / email_address / E-mail will be detected automatically
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            multiple
            className="hidden"
            onChange={e => { addFiles(e.target.files); e.target.value = '' }}
          />

          {pendingFiles.length > 0 && (
            <div className="mt-4 flex flex-col gap-2">
              {pendingFiles.map((p, i) => (
                <div key={`${p.name}-${i}`} className="flex items-center gap-3 px-3 py-2 bg-gray-50 rounded-lg border border-gray-200">
                  <span className="text-base">📄</span>
                  <span className="flex-1 text-sm font-medium truncate">{p.name}</span>
                  <span className="text-[11px] text-gray-500">{(p.file.size / 1024).toFixed(0)} KB</span>
                  <button
                    onClick={() => removeFile(i)}
                    title="Remove"
                    className="text-gray-400 hover:text-red-600 text-base px-1.5 rounded"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {pendingFiles.length > 0 && (
            <div className="flex gap-3 flex-wrap items-center mt-4">
              <Button onClick={process} disabled={processing} className="bg-[#224388] hover:bg-[#1a3370] text-white">
                {processing ? '⏳ Processing…' : '⚡ Process files'}
              </Button>
              <Button onClick={clearAll} variant="outline">✕ Clear all</Button>
            </div>
          )}
        </section>

        {/* ── Results ──────────────────────────────────────────────────── */}
        {showResults && (
          <section className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div>
                <div className="text-base font-bold text-gray-900">Results</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {chunks.length} chunk{chunks.length !== 1 ? 's' : ''} ready to download
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={downloadAll} size="sm" className="bg-[#1F6F78] hover:bg-[#185f67] text-white">
                  ⬇ Download all
                </Button>
                <span className="text-[11px] text-gray-500">
                  If Chrome asks &quot;allow multiple downloads&quot; — click Allow
                </span>
              </div>
            </div>

            {stats && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3 mb-5">
                <Stat label="Unique emails" value={stats.total.toLocaleString()} color="border-t-[#1F6F78]" />
                <Stat label="Output chunks" value={String(chunks.length)} color="border-t-[#16A34A]" />
                <Stat label="Duplicates removed" value={stats.dupes.toLocaleString()} color="border-t-[#D97706]" />
                <Stat label="Files skipped" value={String(stats.skipped)} color="border-t-[#224388]" />
              </div>
            )}

            {processing && (
              <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden my-3">
                <div className="h-full bg-[#1F6F78] rounded-full transition-all" style={{ width: `${progress}%` }} />
              </div>
            )}

            <div className="flex flex-col gap-2">
              {chunks.map((c, i) => (
                <div key={c.name} className="flex items-center gap-4 px-4 py-3 bg-gray-50 rounded-lg border border-gray-200">
                  <span className="text-lg">📦</span>
                  <span className="flex-1 font-semibold text-sm">{c.name}</span>
                  <span className="text-xs text-gray-500">{c.rows.toLocaleString()} rows · {c.sizeMB} MB</span>
                  <Button onClick={() => downloadChunk(i)} size="sm" className="bg-[#1F6F78] hover:bg-[#185f67] text-white">
                    ⬇ Download
                  </Button>
                </div>
              ))}
            </div>

            {log.length > 0 && (
              <div className="font-mono text-[11px] bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 max-h-36 overflow-y-auto mt-4 leading-relaxed">
                {log.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.type === 'ok' ? 'text-green-600'
                        : l.type === 'warn' ? 'text-amber-600'
                          : l.type === 'err' ? 'text-red-600'
                            : 'text-gray-500'
                    }
                  >
                    {l.msg}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ── AI Enrichment (proxied to legacy) ────────────────────────── */}
        <Enrichment />
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className={`bg-white rounded-lg border border-gray-200 border-t-[3px] ${color} px-4 py-3`}>
      <div className="text-[10px] font-bold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-[1.4rem] font-bold mt-0.5">{value}</div>
    </div>
  )
}

// ── AI Enrichment ─────────────────────────────────────────────────────────────
type EnrichStatus = {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'stopped'
  total?: number
  processed?: number
  updated?: number
  skipped?: number
  failed?: number
  total_cost?: number
  current_domain?: string
  domain_ms?: number[]
  log?: string[]
  results?: {
    domain: string
    industry?: string
    keywords?: string
    num_employees?: number
    contacts: number
    status: string
  }[]
}

function Enrichment() {
  const [keywords, setKeywords] = useState(true)
  const [industry, setIndustry] = useState(true)
  const [employees, setEmployees] = useState(true)
  const [sic, setSic] = useState(false)
  const [mode, setMode] = useState<'missing' | 'all'>('missing')
  const [limit, setLimit] = useState('100')
  const [concurrency, setConcurrency] = useState('5')

  const [statusMsg, setStatusMsg] = useState('')
  const [scanResult, setScanResult] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'scanned' | 'running' | 'paused'>('idle')
  const [data, setData] = useState<EnrichStatus | null>(null)
  const [sampleStatus, setSampleStatus] = useState('')
  const [sampleBusy, setSampleBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const selectedFields = useCallback(() => {
    const fields: string[] = []
    if (keywords) fields.push('keywords')
    if (industry) fields.push('industry')
    if (employees) fields.push('num_employees')
    if (sic) fields.push('ch_sic')
    return fields
  }, [keywords, industry, employees, sic])

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  const pollStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/data/apollo-prep/enrich/status')
      const d: EnrichStatus = await r.json()
      if (d.status === 'idle') return
      setData(d)
      if (d.status === 'running') setPhase('running')
      else if (d.status === 'paused') setPhase('paused')
      if (d.status === 'completed' || d.status === 'stopped') {
        stopPoll()
        setPhase('idle')
        setStatusMsg(
          d.status === 'completed'
            ? `Done — ${(d.updated || 0).toLocaleString()} contacts enriched`
            : 'Stopped'
        )
      }
    } catch (err) {
      console.warn('[enrich poll]', (err as Error).message)
    }
  }, [stopPoll])

  const startPoll = useCallback(() => {
    stopPoll()
    pollRef.current = setInterval(pollStatus, 2000)
    pollStatus()
  }, [pollStatus, stopPoll])

  // Auto-restore a running job on mount.
  useEffect(() => {
    ;(async () => {
      try {
        const r = await fetch('/api/data/apollo-prep/enrich/status')
        const d: EnrichStatus = await r.json()
        if (!d || d.status === 'idle') return
        setData(d)
        if (d.status === 'running') { setPhase('running'); startPoll() }
        else if (d.status === 'paused') { setPhase('paused') }
      } catch {
        // legacy server unavailable — leave idle
      }
    })()
    return () => stopPoll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function scan() {
    const fields = selectedFields()
    if (!fields.length) { alert('Select at least one field to enrich.'); return }
    setScanning(true)
    setStatusMsg('Scanning database…')
    try {
      const r = await fetch(`/api/data/apollo-prep/enrich/scan?fields=${fields.join(',')}&mode=${mode}`)
      const d = await r.json()
      if (!r.ok) { alert(d.error || 'Scan failed'); return }
      const verb = mode === 'all' ? 'to re-process (overwrite)' : 'need enrichment'
      setScanResult(
        `${(d.domains as number).toLocaleString()} domains ${verb} · ` +
        `${(d.contacts as number).toLocaleString()} contacts affected · ` +
        `Est. cost: $${(d.cost_usd as number).toFixed(4)}`
      )
      setPhase('scanned')
      setStatusMsg('')
    } catch (err) {
      alert('Error: ' + (err as Error).message)
    } finally {
      setScanning(false)
    }
  }

  function cancelScan() {
    setScanResult(null)
    setPhase('idle')
    setStatusMsg('')
  }

  async function start() {
    setStatusMsg('Starting…')
    setScanResult(null)
    try {
      const r = await fetch('/api/data/apollo-prep/enrich/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: selectedFields(),
          limit: parseInt(limit, 10),
          concurrency: parseInt(concurrency, 10),
          mode,
        }),
      })
      const d = await r.json()
      if (!r.ok) {
        if (r.status === 409) { startPoll(); setPhase('running'); return }
        alert(d.error || 'Failed to start')
        setPhase('idle')
        return
      }
      setData({ status: 'running', total: d.total, processed: 0 })
      setPhase('running')
      setStatusMsg(`Enriching ${(d.total as number).toLocaleString()} domains…`)
      startPoll()
    } catch (err) {
      alert('Error: ' + (err as Error).message)
    }
  }

  async function pause() {
    await fetch('/api/data/apollo-prep/enrich/pause', { method: 'POST' })
    setPhase('paused')
    setStatusMsg('Paused')
  }
  async function resume() {
    await fetch('/api/data/apollo-prep/enrich/resume', { method: 'POST' })
    setPhase('running')
    setStatusMsg('Running…')
    startPoll()
  }
  async function stop() {
    await fetch('/api/data/apollo-prep/enrich/stop', { method: 'POST' })
    stopPoll()
    setPhase('idle')
    setStatusMsg('Stopped')
  }

  async function downloadSample() {
    setSampleBusy(true)
    setSampleStatus('Enriching 100 contacts… (~60 seconds)')
    try {
      const r = await fetch('/api/data/apollo-prep/enrich/sample-csv')
      const d = await r.json()
      if (!r.ok) { setSampleStatus(d.error || 'Failed'); return }
      const dl = (b64: string, filename: string) => {
        const a = document.createElement('a')
        a.href = 'data:text/csv;base64,' + b64
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      }
      dl(d.original.data, d.original.filename)
      setTimeout(() => dl(d.enriched.data, d.enriched.filename), 500)
      const s = d.summary
      setSampleStatus(
        `Done — ${s.contacts} contacts, ${s.tokens.toLocaleString()} tokens, ` +
        `$${s.cost_usd.toFixed(5)} cost (est. full DB: $${s.est_full_db_usd})`
      )
    } catch (err) {
      setSampleStatus('Error: ' + (err as Error).message)
    } finally {
      setSampleBusy(false)
    }
  }

  const total = data?.total || 0
  const processed = data?.processed || 0
  const pct = total ? Math.round((processed / total) * 100) : 0
  const avgMs = data?.domain_ms?.length
    ? data.domain_ms.reduce((a, b) => a + b, 0) / data.domain_ms.length
    : 0
  const remaining = total - processed
  let eta = '—'
  if (avgMs && remaining > 0) {
    const secs = Math.round((avgMs * remaining) / 1000)
    eta = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`
  } else if (processed >= total && total > 0) {
    eta = 'Done'
  }

  const showProgress = phase === 'running' || phase === 'paused' || (!!data && data.status !== 'idle')

  return (
    <section className="bg-white border border-gray-200 rounded-xl p-6">
      <h1 className="text-xl font-bold text-gray-900">AI Enrichment</h1>
      <p className="text-sm text-gray-500 mt-1 mb-5">
        Scans the database for contacts missing data, searches the web using AI, and fills in the gaps.
        Groups by company domain — one search enriches all contacts from the same company.
      </p>

      <div className="mb-5">
        <div className={SUBHEAD}>AI fields (fills blanks only)</div>
        <div className="flex gap-4 flex-wrap mb-3">
          <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
            <Checkbox checked={keywords} onCheckedChange={v => setKeywords(!!v)} /> Keywords
          </label>
          <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
            <Checkbox checked={industry} onCheckedChange={v => setIndustry(!!v)} /> Industry
          </label>
          <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
            <Checkbox checked={employees} onCheckedChange={v => setEmployees(!!v)} /> Company Size
          </label>
        </div>
        <div className="text-[11px] text-gray-500 mb-3">Uses Gemini when GEMINI_API_KEY is set, otherwise Claude.</div>
        <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1.5">Companies House (live gov data — free)</div>
        <label className="flex items-center gap-2 text-sm font-medium cursor-pointer mb-1.5" title="Backfill SIC codes (and other CH fields) for companies that never got Companies House data.">
          <Checkbox checked={sic} onCheckedChange={v => setSic(!!v)} /> SIC codes / Companies House backfill
        </label>
        <div className="text-xs text-gray-500 leading-relaxed">
          Company status · Company type · Founded year · Postcode · Full address · SIC codes · Jurisdiction ·
          Active &amp; resigned officers · Last accounts date · Insolvency history · Charges · Accounts overdue · Cessation date
        </div>
      </div>

      <div className="mb-4">
        <div className={SUBHEAD}>Mode</div>
        <div className="flex gap-5 flex-wrap">
          <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
            <input type="radio" name="enrichMode" checked={mode === 'missing'} onChange={() => setMode('missing')} className="accent-[#1F6F78]" />
            Fill missing only <span className="font-normal text-gray-500">(recommended)</span>
          </label>
          <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
            <input type="radio" name="enrichMode" checked={mode === 'all'} onChange={() => setMode('all')} className="accent-[#1F6F78]" />
            Update all <span className="font-normal text-gray-500">(overwrite existing)</span>
          </label>
        </div>
      </div>

      <div className="mb-2 flex items-center gap-6 flex-wrap">
        <div className="flex items-center gap-3">
          <Label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Batch size</Label>
          <Select value={limit} onValueChange={v => setLimit(v ?? '0')}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="100">100 domains (test)</SelectItem>
              <SelectItem value="500">500 domains</SelectItem>
              <SelectItem value="1000">1,000 domains</SelectItem>
              <SelectItem value="5000">5,000 domains</SelectItem>
              <SelectItem value="0">Full database</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-3">
          <Label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Speed</Label>
          <Select value={concurrency} onValueChange={v => setConcurrency(v ?? '5')}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1 — safe</SelectItem>
              <SelectItem value="3">3 — normal</SelectItem>
              <SelectItem value="5">5 — fast (recommended)</SelectItem>
              <SelectItem value="10">10 — max</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="text-[11px] text-gray-500 mb-5 leading-snug">
        Companies House lookups are globally throttled to ~2.5/sec to respect CH&apos;s rate limit — so for
        SIC-only backfills, higher speed won&apos;t go faster. AI fields still run at the chosen concurrency.
      </div>

      <div className="flex gap-3 flex-wrap items-center mb-4">
        {phase === 'idle' && (
          <Button onClick={scan} disabled={scanning} className="bg-[#1F6F78] hover:bg-[#185f67] text-white">
            Scan Database
          </Button>
        )}
        {phase === 'scanned' && (
          <>
            <Button onClick={start} className="bg-[#16A34A] hover:bg-[#15803D] text-white">Confirm &amp; Start</Button>
            <Button onClick={cancelScan} variant="outline">Cancel</Button>
          </>
        )}
        {phase === 'running' && (
          <>
            <Button onClick={pause} variant="outline">⏸ Pause</Button>
            <Button onClick={stop} variant="outline">■ Stop</Button>
          </>
        )}
        {phase === 'paused' && (
          <>
            <Button onClick={resume} variant="outline">▶ Resume</Button>
            <Button onClick={stop} variant="outline">■ Stop</Button>
          </>
        )}
        {statusMsg && <span className="text-xs text-gray-500">{statusMsg}</span>}
      </div>

      {phase === 'scanned' && scanResult && (
        <div className="bg-green-50 border border-green-300 rounded-lg px-5 py-4 mb-4">
          <div className="text-sm font-semibold text-green-700 mb-1">Ready to enrich</div>
          <div className="text-[13px] text-green-800">{scanResult}</div>
        </div>
      )}

      {showProgress && (
        <div>
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{processed.toLocaleString()} / {total.toLocaleString()} domains</span>
            <span className="italic">{data?.current_domain ? `Processing: ${data.current_domain}` : ''}</span>
          </div>
          <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div className="h-full bg-[#1F6F78] rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3 mt-4">
            <Stat label="Updated" value={(data?.updated || 0).toLocaleString()} color="border-t-[#1F6F78]" />
            <Stat label="Skipped" value={(data?.skipped || 0).toLocaleString()} color="border-t-[#224388]" />
            <Stat label="Failed" value={(data?.failed || 0).toLocaleString()} color="border-t-[#D97706]" />
            <Stat label="Domains" value={total.toLocaleString()} color="border-t-[#16A34A]" />
            <Stat label="Cost (USD)" value={`$${(data?.total_cost || 0).toFixed(4)}`} color="border-t-[#8b5cf6]" />
            <Stat label="Est. Time Left" value={eta} color="border-t-[#ec4899]" />
          </div>

          {data?.log && data.log.length > 0 && (
            <div className="font-mono text-[11px] bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 max-h-[150px] overflow-y-auto mt-3 leading-relaxed">
              {data.log.map((l, i) => (
                <div key={i} className={l.startsWith('✓') ? 'text-green-600' : l.startsWith('✗') ? 'text-red-600' : 'text-amber-600'}>
                  {l}
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-gray-200">
            <div className={SUBHEAD}>Sample Export</div>
            <div className="flex items-center gap-3 flex-wrap">
              <Button onClick={downloadSample} disabled={sampleBusy} variant="outline">
                Download 100 contact sample (original + enriched)
              </Button>
              {sampleStatus && <span className="text-xs text-gray-500">{sampleStatus}</span>}
            </div>
          </div>

          {data?.results && data.results.length > 0 && (
            <div className="mt-5">
              <div className={SUBHEAD}>Results</div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-gray-50 border-b-2 border-gray-200">
                      {['Domain', 'Industry', 'Keywords', 'Employees', 'Contacts', 'Status'].map(h => (
                        <th key={h} className="text-left px-2.5 py-2 font-semibold text-gray-500">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.results.map((r, i) => {
                      const kwParts = r.keywords ? r.keywords.split(',') : []
                      const kw = kwParts.length ? kwParts.slice(0, 4).join(', ') + (kwParts.length > 4 ? '…' : '') : '—'
                      const sc = r.status === 'updated' ? 'text-green-600' : r.status === 'failed' ? 'text-red-600' : 'text-gray-500'
                      return (
                        <tr key={i} className="border-b border-gray-200">
                          <td className="px-2.5 py-1.5 font-medium">{r.domain}</td>
                          <td className="px-2.5 py-1.5">{r.industry || '—'}</td>
                          <td className="px-2.5 py-1.5 text-gray-500 max-w-[200px] truncate" title={r.keywords || ''}>{kw}</td>
                          <td className="px-2.5 py-1.5">{r.num_employees ? r.num_employees.toLocaleString() : '—'}</td>
                          <td className="px-2.5 py-1.5">{r.contacts}</td>
                          <td className={`px-2.5 py-1.5 font-semibold ${sc}`}>{r.status}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
