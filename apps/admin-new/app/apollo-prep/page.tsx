'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnrichResult {
  domain: string
  industry: string | null
  keywords: string | null
  num_employees: number | null
  contacts: number
  status: string
}

interface EnrichStatusResponse {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'stopped'
  total?: number
  processed?: number
  updated?: number
  skipped?: number
  failed?: number
  current_domain?: string | null
  log?: string[]
  results?: EnrichResult[]
  total_cost?: number
  domain_ms?: number[]
  pid?: number
}

interface EnrichScanResponse {
  domains: number
  contacts: number
  cost_usd: number
}

interface SampleCsvSummary {
  contacts: number
  tokens: number
  cost_usd: number
  est_full_db_usd: number
}

interface SampleCsvFile {
  filename: string
  data: string
}

interface SampleCsvResponse {
  original: SampleCsvFile
  enriched: SampleCsvFile
  summary: SampleCsvSummary
}

interface PendingFile {
  name: string
  file: File
}

interface Chunk {
  name: string
  csv: string
  rows: number
  sizeMB: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_BYTES = 45 * 1024 * 1024
const MAX_ROWS = 99999
const EMAIL_COLS = ['email', 'e-mail', 'email address', 'email_address', 'emailaddress', 'e-mail address', 'mail']

const ACCT1_REGIONS = ['London', 'South East']
const ALL_REGIONS = [
  'London', 'South East', 'North West', 'East of England', 'West Midlands',
  'South West', 'Yorkshire and the Humber', 'East Midlands', 'Scotland',
  'North East', 'Northern Ireland', 'Wales',
]
const ACCT2_REGIONS = ALL_REGIONS.filter(r => !ACCT1_REGIONS.includes(r))

const APOLLO_URL_ACCOUNT1 =
  'https://app.apollo.io/#/people?page=1&contactEmailStatusV2[]=verified&contactEmailStatusV2[]=user_managed' +
  '&organizationLocations[]=London%2C%20United%20Kingdom&organizationLocations[]=Reading%2C%20United%20Kingdom' +
  '&organizationLocations[]=Guildford%2C%20United%20Kingdom&organizationLocations[]=Oxford%2C%20United%20Kingdom' +
  '&organizationLocations[]=Brighton%2C%20United%20Kingdom&organizationLocations[]=Milton%20Keynes%2C%20United%20Kingdom' +
  '&organizationLocations[]=Southampton%2C%20United%20Kingdom&organizationLocations[]=Kingston%20upon%20Thames%2C%20United%20Kingdom' +
  '&organizationLocations[]=Redhill%2C%20United%20Kingdom&organizationLocations[]=Slough%2C%20United%20Kingdom' +
  '&organizationLocations[]=Portsmouth%2C%20United%20Kingdom&organizationLocations[]=Tonbridge%2C%20United%20Kingdom' +
  '&organizationLocations[]=Medway%2C%20United%20Kingdom&organizationLocations[]=Twickenham%2C%20United%20Kingdom' +
  '&organizationLocations[]=Canterbury%2C%20United%20Kingdom&organizationLocations[]=Enfield%2C%20United%20Kingdom' +
  '&organizationLocations[]=Harrow%2C%20United%20Kingdom&organizationLocations[]=Dartford%2C%20United%20Kingdom' +
  '&organizationLocations[]=Croydon%2C%20United%20Kingdom&organizationLocations[]=Southall%2C%20United%20Kingdom' +
  '&organizationLocations[]=Romford%2C%20United%20Kingdom&organizationLocations[]=Bromley%2C%20United%20Kingdom' +
  '&organizationLocations[]=Ilford%2C%20United%20Kingdom&organizationLocations[]=Sutton%2C%20United%20Kingdom' +
  '&organizationLocations[]=Bracknell%2C%20United%20Kingdom&organizationLocations[]=Maidstone%2C%20United%20Kingdom' +
  '&organizationLocations[]=Basingstoke%2C%20United%20Kingdom&organizationLocations[]=Woking%2C%20United%20Kingdom' +
  '&organizationLocations[]=Winchester%2C%20United%20Kingdom&organizationLocations[]=Hove%2C%20United%20Kingdom' +
  '&organizationLocations[]=Farnborough%2C%20United%20Kingdom&organizationLocations[]=Maidenhead%2C%20United%20Kingdom' +
  '&organizationLocations[]=Chichester%2C%20United%20Kingdom&organizationLocations[]=Ashford%2C%20United%20Kingdom' +
  '&organizationLocations[]=Horsham%2C%20United%20Kingdom&organizationLocations[]=High%20Wycombe%2C%20United%20Kingdom' +
  '&organizationLocations[]=Crawley%2C%20United%20Kingdom&organizationLocations[]=Hastings%2C%20United%20Kingdom' +
  '&organizationLocations[]=Worthing%2C%20United%20Kingdom&organizationLocations[]=Aylesbury%2C%20United%20Kingdom' +
  '&organizationLocations[]=Reigate%2C%20United%20Kingdom&organizationLocations[]=Eastbourne%2C%20United%20Kingdom' +
  '&organizationLocations[]=Windsor%2C%20United%20Kingdom&organizationLocations[]=Westminster%2C%20United%20Kingdom' +
  '&organizationLocations[]=Wembley%2C%20United%20Kingdom&organizationLocations[]=Camden%2C%20United%20Kingdom' +
  '&recommendationConfigId=score&currentlyNotUsingAnyOfTechnologyUids[]=outlook&prospectedByCurrentTeam[]=no' +
  '&sortByField=person_name.raw&sortAscending=false'

const APOLLO_URL_ACCOUNT2 =
  'https://app.apollo.io/#/people?page=1&contactEmailStatusV2[]=verified&contactEmailStatusV2[]=user_managed' +
  '&organizationLocations[]=United%20Kingdom' +
  '&organizationNotLocations[]=London%2C%20United%20Kingdom&organizationNotLocations[]=Reading%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Guildford%2C%20United%20Kingdom&organizationNotLocations[]=Oxford%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Brighton%2C%20United%20Kingdom&organizationNotLocations[]=Milton%20Keynes%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Southampton%2C%20United%20Kingdom&organizationNotLocations[]=Kingston%20upon%20Thames%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Redhill%2C%20United%20Kingdom&organizationNotLocations[]=Slough%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Portsmouth%2C%20United%20Kingdom&organizationNotLocations[]=Tonbridge%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Medway%2C%20United%20Kingdom&organizationNotLocations[]=Twickenham%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Canterbury%2C%20United%20Kingdom&organizationNotLocations[]=Enfield%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Harrow%2C%20United%20Kingdom&organizationNotLocations[]=Dartford%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Croydon%2C%20United%20Kingdom&organizationNotLocations[]=Southall%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Romford%2C%20United%20Kingdom&organizationNotLocations[]=Bromley%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Ilford%2C%20United%20Kingdom&organizationNotLocations[]=Sutton%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Bracknell%2C%20United%20Kingdom&organizationNotLocations[]=Maidstone%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Basingstoke%2C%20United%20Kingdom&organizationNotLocations[]=Woking%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Winchester%2C%20United%20Kingdom&organizationNotLocations[]=Hove%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Farnborough%2C%20United%20Kingdom&organizationNotLocations[]=Maidenhead%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Chichester%2C%20United%20Kingdom&organizationNotLocations[]=Ashford%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Horsham%2C%20United%20Kingdom&organizationNotLocations[]=High%20Wycombe%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Crawley%2C%20United%20Kingdom&organizationNotLocations[]=Hastings%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Worthing%2C%20United%20Kingdom&organizationNotLocations[]=Aylesbury%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Reigate%2C%20United%20Kingdom&organizationNotLocations[]=Eastbourne%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Windsor%2C%20United%20Kingdom&organizationNotLocations[]=Westminster%2C%20United%20Kingdom' +
  '&organizationNotLocations[]=Wembley%2C%20United%20Kingdom&organizationNotLocations[]=Camden%2C%20United%20Kingdom' +
  '&recommendationConfigId=score&currentlyNotUsingAnyOfTechnologyUids[]=outlook&prospectedByCurrentTeam[]=no' +
  '&sortByField=person_name.raw&sortAscending=false'

// ── CSV Parsing ───────────────────────────────────────────────────────────────

function parseLine(line: string, delim: string): string[] {
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

interface ParseResult {
  emails: string[]
  headerFound: string
}

function parseCSV(text: string): ParseResult | null {
  const lines = text.split(/\r?\n/)
  if (!lines.length) return null
  const firstLine = lines[0]
  const delim = firstLine.includes('\t') ? '\t' : firstLine.includes(';') ? ';' : ','
  const headers = parseLine(lines[0], delim).map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''))
  const emailIdx = headers.findIndex(h => EMAIL_COLS.includes(h))
  if (emailIdx === -1) return null
  const emails: string[] = []
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const row = parseLine(lines[i], delim)
    const raw = (row[emailIdx] ?? '').trim().toLowerCase().replace(/^"|"$/g, '')
    if (raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) emails.push(raw)
  }
  return { emails, headerFound: headers[emailIdx] }
}

// ── File download helper ──────────────────────────────────────────────────────

function triggerDownload(content: string, filename: string, mimeType = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function triggerDownloadBase64(b64: string, filename: string) {
  const a = document.createElement('a')
  a.href = 'data:text/csv;base64,' + b64
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// ── ETA helper ────────────────────────────────────────────────────────────────

function formatEta(domainMs: number[], remaining: number): string {
  if (!domainMs.length || remaining <= 0) return remaining <= 0 ? 'Done' : '—'
  const avgMs = domainMs.reduce((a, b) => a + b, 0) / domainMs.length
  const secs = Math.round((avgMs * remaining) / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  return `${(secs / 3600).toFixed(1)}h`
}

// ── Small presentational helpers ───────────────────────────────────────────────

function Card({ title, subtitle, actions, children }: {
  title: string
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="mb-5 rounded-lg border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-5 py-3.5">
        <div className="min-w-0">
          <div className="font-[family-name:var(--font-display)] text-[15px] font-bold text-foreground">{title}</div>
          {subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  )
}

function LogBox({ logRef, lines }: {
  logRef: React.RefObject<HTMLDivElement | null>
  lines: Array<{ text: string; type: 'ok' | 'warn' | 'err' | '' }>
}) {
  return (
    <div
      ref={logRef}
      className="mt-3 max-h-40 overflow-y-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed"
    >
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            l.type === 'ok' ? 'text-emerald-600 dark:text-emerald-400'
              : l.type === 'err' ? 'text-destructive'
                : l.type === 'warn' ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground'
          }
        >
          {l.text}
        </div>
      ))}
    </div>
  )
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="my-3 h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-[var(--chart-1)] transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ApolloPrep() {
  // ── CSV Upload state ────────────────────────────────────────────
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [chunks, setChunks] = useState<Chunk[]>([])
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [showResults, setShowResults] = useState(false)
  const [resultStats, setResultStats] = useState<{ uniqueEmails: number; chunkCount: number; dupes: number; skipped: number } | null>(null)
  const [logLines, setLogLines] = useState<Array<{ text: string; type: 'ok' | 'warn' | 'err' | '' }>>([])
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // ── Split export state ──────────────────────────────────────────
  const [exportStatus, setExportStatus] = useState('')
  const [exportingAccount, setExportingAccount] = useState<1 | 2 | null>(null)

  // ── Enrichment state ────────────────────────────────────────────
  const [enrichKeywords, setEnrichKeywords] = useState(true)
  const [enrichIndustry, setEnrichIndustry] = useState(true)
  const [enrichEmployees, setEnrichEmployees] = useState(true)
  const [enrichLimit, setEnrichLimit] = useState('100')
  const [enrichConcurrency, setEnrichConcurrency] = useState('5')

  type EnrichPhase = 'idle' | 'scanning' | 'scan-ready' | 'running' | 'paused' | 'completed' | 'stopped'
  const [enrichPhase, setEnrichPhase] = useState<EnrichPhase>('idle')
  const [enrichScanData, setEnrichScanData] = useState<EnrichScanResponse | null>(null)
  const [enrichStatusMsg, setEnrichStatusMsg] = useState('')
  const [enrichProgress, setEnrichProgress] = useState(0)
  const [enrichProgressLabel, setEnrichProgressLabel] = useState('0 / 0 domains')
  const [enrichCurrentDomain, setEnrichCurrentDomain] = useState('')
  const [enrichStats, setEnrichStats] = useState({ updated: 0, skipped: 0, failed: 0, total: 0, cost: 0 })
  const [enrichEta, setEnrichEta] = useState('—')
  const [enrichLog, setEnrichLog] = useState<Array<{ text: string; type: 'ok' | 'err' | 'warn' }>>([])
  const [enrichResults, setEnrichResults] = useState<EnrichResult[]>([])
  const [showEnrichResults, setShowEnrichResults] = useState(false)
  const enrichLogRef = useRef<HTMLDivElement>(null)

  // Saved fields/limit/concurrency for when confirmation happens
  const pendingEnrichFields = useRef<string[]>([])
  const pendingEnrichLimit = useRef(0)
  const pendingEnrichConcurrency = useRef(5)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Sample CSV state ────────────────────────────────────────────
  const [sampleCsvLoading, setSampleCsvLoading] = useState(false)
  const [sampleCsvStatus, setSampleCsvStatus] = useState('')

  // ── Auto-scroll log ─────────────────────────────────────────────
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logLines])

  useEffect(() => {
    if (enrichLogRef.current) enrichLogRef.current.scrollTop = enrichLogRef.current.scrollHeight
  }, [enrichLog])

  // ── Restore enrichment state on page load ───────────────────────
  useEffect(() => {
    void initEnrichment()
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startPoll = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    pollTimerRef.current = setInterval(pollEnrichStatus, 2000)
    void pollEnrichStatus()
  }, [])

  async function pollEnrichStatus() {
    try {
      const res = await fetch('/api/apollo-prep/enrich/status')
      const d: EnrichStatusResponse = await res.json()
      if (d.status === 'idle') return

      const total = d.total ?? 0
      const processed = d.processed ?? 0
      const pct = total ? Math.round((processed / total) * 100) : 0

      setEnrichProgress(pct)
      setEnrichProgressLabel(`${processed.toLocaleString()} / ${total.toLocaleString()} domains`)
      setEnrichCurrentDomain(d.current_domain ? `Processing: ${d.current_domain}` : '')
      setEnrichStats({
        updated: d.updated ?? 0,
        skipped: d.skipped ?? 0,
        failed: d.failed ?? 0,
        total,
        cost: d.total_cost ?? 0,
      })
      setEnrichEta(formatEta(d.domain_ms ?? [], total - processed))

      if (d.log?.length) {
        setEnrichLog(
          d.log.map(l => ({
            text: l,
            type: l.startsWith('✓') ? 'ok' : l.startsWith('✗') ? 'err' : 'warn',
          })),
        )
      }

      if (d.results?.length) {
        setEnrichResults(d.results)
        setShowEnrichResults(true)
      }

      if (d.status === 'completed' || d.status === 'stopped') {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current)
        setEnrichPhase(d.status)
        setEnrichCurrentDomain('')
        setEnrichStatusMsg(
          d.status === 'completed'
            ? `Done — ${(d.updated ?? 0).toLocaleString()} contacts enriched`
            : 'Stopped',
        )
      }
    } catch (err) {
      console.warn('[enrich poll]', err)
    }
  }

  async function initEnrichment() {
    try {
      const res = await fetch('/api/apollo-prep/enrich/status')
      const d: EnrichStatusResponse = await res.json()
      if (!d || d.status === 'idle') return

      const total = d.total ?? 0
      const processed = d.processed ?? 0
      const pct = total ? Math.round((processed / total) * 100) : 0

      setEnrichStats({
        updated: d.updated ?? 0,
        skipped: d.skipped ?? 0,
        failed: d.failed ?? 0,
        total,
        cost: d.total_cost ?? 0,
      })
      setEnrichProgress(pct)
      setEnrichProgressLabel(`${processed.toLocaleString()} / ${total.toLocaleString()} domains`)
      setEnrichEta(formatEta(d.domain_ms ?? [], total - processed))

      if (d.status === 'running') {
        setEnrichPhase('running')
        setEnrichStatusMsg(`Enriching ${total.toLocaleString()} domains…`)
        startPoll()
      } else if (d.status === 'paused') {
        setEnrichPhase('paused')
        setEnrichStatusMsg('Paused')
      } else if (d.status === 'completed' || d.status === 'stopped') {
        setEnrichPhase(d.status)
        setEnrichStatusMsg(
          d.status === 'completed'
            ? `Done — ${(d.updated ?? 0).toLocaleString()} contacts enriched`
            : 'Stopped',
        )
      }
    } catch { /* silent */ }
  }

  // ── File drop / pick ────────────────────────────────────────────

  function addFiles(fileList: FileList) {
    const added: PendingFile[] = []
    for (const f of fileList) {
      if (!f.name.toLowerCase().endsWith('.csv')) continue
      if (pendingFiles.some(p => p.name === f.name && p.file.size === f.size)) continue
      added.push({ name: f.name, file: f })
    }
    if (added.length) setPendingFiles(prev => [...prev, ...added])
  }

  function removeFile(idx: number) {
    setPendingFiles(prev => prev.filter((_, i) => i !== idx))
  }

  function clearAll() {
    setPendingFiles([])
    setChunks([])
    setShowResults(false)
    setLogLines([])
    setResultStats(null)
    setProgress(0)
  }

  // ── CSV Processing ──────────────────────────────────────────────

  async function processCsvFiles() {
    if (!pendingFiles.length) return
    setProcessing(true)
    setShowResults(true)
    setLogLines([])
    setProgress(0)
    setChunks([])

    const allEmails = new Set<string>()
    let skippedNoCol = 0
    let dupes = 0

    const newLog: Array<{ text: string; type: 'ok' | 'warn' | 'err' | '' }> = []

    for (let fi = 0; fi < pendingFiles.length; fi++) {
      const { name, file } = pendingFiles[fi]
      setProgress(Math.round((fi / pendingFiles.length) * 60))
      const text = await file.text()
      const result = parseCSV(text)
      if (!result) {
        newLog.push({ text: `⚠ ${name} — no email column found (looked for: ${EMAIL_COLS.slice(0, 4).join(', ')}…)`, type: 'warn' })
        skippedNoCol++
        continue
      }
      const before = allEmails.size
      for (const e of result.emails) {
        if (allEmails.has(e)) dupes++
        else allEmails.add(e)
      }
      const added = allEmails.size - before
      newLog.push({ text: `✓ ${name} — col "${result.headerFound}", ${result.emails.length} valid, ${added} new`, type: 'ok' })
    }

    setLogLines(newLog)
    setProgress(70)

    const total = allEmails.size
    if (!total) {
      setLogLines(prev => [...prev, { text: 'No valid emails found across all files.', type: 'err' }])
      setProcessing(false)
      return
    }

    const emailArr = [...allEmails]
    const header = 'Email'
    let chunkIdx = 0
    let i = 0
    const builtChunks: Chunk[] = []

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
      builtChunks.push({ name: `apollo-chunk-${String(chunkIdx).padStart(2, '0')}.csv`, csv, rows, sizeMB })
      setLogLines(prev => [...prev, { text: `Chunk ${chunkIdx}: ${rows.toLocaleString()} emails, ~${sizeMB} MB`, type: '' }])
    }

    setProgress(100)
    setChunks(builtChunks)
    setResultStats({ uniqueEmails: total, chunkCount: builtChunks.length, dupes, skipped: skippedNoCol })
    setProcessing(false)
  }

  function downloadChunk(idx: number) {
    const c = chunks[idx]
    triggerDownload(c.csv, c.name)
  }

  function downloadAll() {
    chunks.forEach(c => {
      triggerDownload(c.csv, c.name)
    })
  }

  // ── Split export ────────────────────────────────────────────────

  async function exportSplit(account: 1 | 2) {
    setExportingAccount(account)
    const regions = account === 1 ? ACCT1_REGIONS : ACCT2_REGIONS
    let offset = 0
    let fileNum = 1
    let totalExported = 0

    try {
      while (true) {
        setExportStatus(
          `Exporting Account ${account} — file ${fileNum}${totalExported ? `, ${totalExported.toLocaleString()} rows so far` : ''}...`,
        )
        const params = new URLSearchParams({ offset: String(offset), companyRegion: regions.join(',') })
        const r = await fetch(`/api/apollo-prep/contacts/export?${params}`)
        if (!r.ok) {
          setExportStatus(`Export failed (${r.status})`)
          break
        }

        const hasMore = r.headers.get('X-Has-More') === 'true'
        const nextOffset = parseInt(r.headers.get('X-Next-Offset') ?? '0')
        const rowsInFile = parseInt(r.headers.get('X-Rows-In-File') ?? '0')

        const blob = await r.blob()
        const url = URL.createObjectURL(blob)
        const a = Object.assign(document.createElement('a'), {
          href: url,
          download: `apollo-account${account}-export-${fileNum}.csv`,
        })
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 5000)

        totalExported += rowsInFile
        fileNum++
        offset = nextOffset
        if (!hasMore) break
      }
      setExportStatus(
        `Done — Account ${account} export complete: ${totalExported.toLocaleString()} rows in ${fileNum - 1} file${fileNum > 2 ? 's' : ''}.`,
      )
    } catch (err) {
      setExportStatus(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setExportingAccount(null)
    }
  }

  // ── Enrichment actions ──────────────────────────────────────────

  async function scanEnrichment() {
    const fields: string[] = []
    if (enrichKeywords) fields.push('keywords')
    if (enrichIndustry) fields.push('industry')
    if (enrichEmployees) fields.push('num_employees')
    if (!fields.length) { alert('Select at least one field to enrich.'); return }

    pendingEnrichFields.current = fields
    pendingEnrichLimit.current = parseInt(enrichLimit, 10)
    pendingEnrichConcurrency.current = parseInt(enrichConcurrency, 10)

    setEnrichPhase('scanning')
    setEnrichStatusMsg('Scanning database…')

    try {
      const res = await fetch(`/api/apollo-prep/enrich/scan?fields=${fields.join(',')}`)
      const d: EnrichScanResponse & { error?: string } = await res.json()
      if (!res.ok) {
        alert(d.error ?? 'Scan failed')
        setEnrichPhase('idle')
        setEnrichStatusMsg('')
        return
      }
      setEnrichScanData(d)
      setEnrichPhase('scan-ready')
      setEnrichStatusMsg('')
    } catch (err) {
      alert('Error: ' + (err instanceof Error ? err.message : String(err)))
      setEnrichPhase('idle')
      setEnrichStatusMsg('')
    }
  }

  function cancelScan() {
    setEnrichPhase('idle')
    setEnrichScanData(null)
    setEnrichStatusMsg('')
  }

  async function startEnrichment() {
    setEnrichPhase('running')
    setEnrichStatusMsg('Starting…')
    setEnrichScanData(null)

    try {
      const res = await fetch('/api/apollo-prep/enrich/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: pendingEnrichFields.current,
          limit: pendingEnrichLimit.current,
          concurrency: pendingEnrichConcurrency.current,
        }),
      })
      const d: { ok?: boolean; total?: number; error?: string } = await res.json()
      if (!res.ok) {
        if (res.status === 409) {
          await initEnrichment()
          return
        }
        alert(d.error ?? 'Failed to start')
        setEnrichPhase('idle')
        return
      }

      const total = d.total ?? 0
      setEnrichStats(prev => ({ ...prev, total }))
      setEnrichProgressLabel(`0 / ${total.toLocaleString()} domains`)
      setEnrichStatusMsg(`Enriching ${total.toLocaleString()} domains…`)
      startPoll()
    } catch (err) {
      alert('Error: ' + (err instanceof Error ? err.message : String(err)))
      setEnrichPhase('idle')
    }
  }

  async function pauseEnrichment() {
    await fetch('/api/apollo-prep/enrich/pause', { method: 'POST' })
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    setEnrichPhase('paused')
    setEnrichStatusMsg('Paused')
  }

  async function resumeEnrichment() {
    await fetch('/api/apollo-prep/enrich/resume', { method: 'POST' })
    setEnrichPhase('running')
    setEnrichStatusMsg('Running…')
    startPoll()
  }

  async function stopEnrichment() {
    await fetch('/api/apollo-prep/enrich/stop', { method: 'POST' })
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    setEnrichPhase('stopped')
    setEnrichStatusMsg('Stopped')
    setEnrichCurrentDomain('')
  }

  // ── Sample CSV ──────────────────────────────────────────────────

  async function downloadSampleCsv() {
    setSampleCsvLoading(true)
    setSampleCsvStatus('Enriching 100 contacts… (~60 seconds)')
    try {
      const res = await fetch('/api/apollo-prep/enrich/sample-csv')
      const d: SampleCsvResponse & { error?: string } = await res.json()
      if (!res.ok) {
        setSampleCsvStatus(d.error ?? 'Failed')
        return
      }
      triggerDownloadBase64(d.original.data, d.original.filename)
      setTimeout(() => triggerDownloadBase64(d.enriched.data, d.enriched.filename), 500)
      const s = d.summary
      setSampleCsvStatus(
        `Done — ${s.contacts} contacts, ${s.tokens.toLocaleString()} tokens, $${s.cost_usd.toFixed(5)} cost (est. full DB: $${s.est_full_db_usd})`,
      )
    } catch (err) {
      setSampleCsvStatus('Error: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSampleCsvLoading(false)
    }
  }

  // ── Derived booleans for enrichment UI ─────────────────────────

  const isEnrichRunning = enrichPhase === 'running'
  const isEnrichPaused = enrichPhase === 'paused'
  const isEnrichActive = isEnrichRunning || isEnrichPaused
  const showEnrichProgress = isEnrichRunning || isEnrichPaused || enrichPhase === 'completed' || enrichPhase === 'stopped'

  const enrichJobTone: StatusTone =
    enrichPhase === 'running' ? 'ok'
      : enrichPhase === 'paused' ? 'paused'
        : enrichPhase === 'scanning' ? 'info'
          : enrichPhase === 'completed' ? 'ok'
            : enrichPhase === 'stopped' ? 'error'
              : enrichPhase === 'scan-ready' ? 'info'
                : 'neutral'

  const resultColumns: Column<EnrichResult>[] = [
    {
      key: 'domain', header: 'Domain', sortValue: r => r.domain.toLowerCase(),
      cell: r => <span className="font-medium text-foreground">{r.domain}</span>,
    },
    { key: 'industry', header: 'Industry', sortValue: r => r.industry ?? '', cell: r => r.industry ?? '—' },
    {
      key: 'keywords', header: 'Keywords',
      cell: r => {
        const kwArr = r.keywords ? r.keywords.split(',') : []
        const kw = kwArr.length ? kwArr.slice(0, 4).join(', ') + (kwArr.length > 4 ? '…' : '') : '—'
        return (
          <span className="block max-w-[200px] truncate text-muted-foreground" title={r.keywords ?? ''}>{kw}</span>
        )
      },
    },
    {
      key: 'num_employees', header: 'Employees', numeric: true, sortValue: r => r.num_employees ?? -1,
      cell: r => (r.num_employees != null ? r.num_employees.toLocaleString() : '—'),
    },
    { key: 'contacts', header: 'Contacts', numeric: true, sortValue: r => r.contacts, cell: r => r.contacts },
    {
      key: 'status', header: 'Status', sortValue: r => r.status,
      cell: r => (
        <StatusBadge status={r.status === 'updated' ? 'ok' : r.status === 'failed' ? 'error' : 'neutral'}>
          {r.status}
        </StatusBadge>
      ),
    },
  ]

  // ── Render ──────────────────────────────────────────────────────

  return (
    <PageShell
      title="Apollo Prep"
      subtitle="Split your database by account, prep CSVs for Apollo import, and enrich contacts with AI."
    >
      {/* Apollo Account Split */}
      <Card
        title="Apollo Account Split — UK"
        subtitle="Account 1 = London + South East · Account 2 = rest of the UK · no duplicates between accounts."
      >
        <p className="mb-6 text-[13px] text-muted-foreground">
          Export your existing database contacts split by account, or find net-new contacts in Apollo.
        </p>

        <div className="mb-6">
          <SectionLabel>Export from your database</SectionLabel>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={exportingAccount !== null} onClick={() => void exportSplit(1)}>
              {exportingAccount === 1 ? 'Exporting…' : '↓ Export Account 1 — London + South East'}
            </Button>
            <Button variant="secondary" disabled={exportingAccount !== null} onClick={() => void exportSplit(2)}>
              {exportingAccount === 2 ? 'Exporting…' : '↓ Export Account 2 — Rest of UK'}
            </Button>
          </div>
          {exportStatus && <div className="mt-2 text-xs text-muted-foreground">{exportStatus}</div>}
        </div>

        <div>
          <SectionLabel>Find net-new contacts in Apollo</SectionLabel>
          <div className="flex flex-wrap gap-2">
            <Button render={<a href={APOLLO_URL_ACCOUNT1} target="_blank" rel="noopener noreferrer" />}>
              ↗ Account 1 — London + South East
            </Button>
            <Button variant="secondary" render={<a href={APOLLO_URL_ACCOUNT2} target="_blank" rel="noopener noreferrer" />}>
              ↗ Account 2 — Rest of UK
            </Button>
          </div>
        </div>
      </Card>

      {/* Apollo Upload Prep */}
      <Card
        title="Apollo Upload Prep"
        subtitle="Drop CSVs — emails are extracted, deduplicated, and split into chunks ≤ 45 MB / 100,000 rows."
      >
        {/* Drop zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={e => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files) }}
          className={`cursor-pointer rounded-xl border-2 border-dashed px-8 py-12 text-center transition-colors ${
            isDragging ? 'border-primary bg-accent/50' : 'border-border bg-muted/30 hover:bg-muted/50'
          }`}
        >
          <div className="mb-3 text-4xl">📂</div>
          <div className="text-[15px] font-semibold text-foreground">Drop CSV files here, or click to browse</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Any column named Email / email / Email Address / email_address / E-mail will be detected automatically
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          multiple
          className="hidden"
          onChange={e => { if (e.target.files) addFiles(e.target.files) }}
        />

        {/* File list */}
        {pendingFiles.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {pendingFiles.map((p, i) => (
              <div key={i} className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3.5 py-2.5">
                <span className="text-base">📄</span>
                <span className="flex-1 truncate text-[13px] font-medium text-foreground">{p.name}</span>
                <span className="text-[11px] text-muted-foreground">{(p.file.size / 1024).toFixed(0)} KB</span>
                <Button variant="ghost" size="icon-sm" title="Remove" onClick={() => removeFile(i)}>×</Button>
              </div>
            ))}
          </div>
        )}

        {pendingFiles.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button disabled={processing} onClick={() => void processCsvFiles()}>
              {processing ? 'Processing…' : '⚡ Process files'}
            </Button>
            <Button variant="ghost" disabled={processing} onClick={clearAll}>✕ Clear all</Button>
          </div>
        )}
      </Card>

      {/* Results */}
      {showResults && (
        <Card
          title="Results"
          subtitle={resultStats ? `${resultStats.chunkCount} chunk${resultStats.chunkCount !== 1 ? 's' : ''} ready to download` : undefined}
          actions={
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={downloadAll} disabled={!chunks.length}>⬇ Download all</Button>
              <span className="text-[11px] text-muted-foreground">If Chrome asks &ldquo;allow multiple downloads&rdquo; — click Allow</span>
            </div>
          }
        >
          {resultStats && (
            <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
              <KpiCard label="Unique emails" value={resultStats.uniqueEmails.toLocaleString()} tone="teal" />
              <KpiCard label="Output chunks" value={String(resultStats.chunkCount)} tone="green" />
              <KpiCard label="Duplicates removed" value={resultStats.dupes.toLocaleString()} tone="yellow" />
              <KpiCard label="Files skipped" value={String(resultStats.skipped)} tone="navy" />
            </div>
          )}

          <ProgressBar pct={progress} />

          {/* Chunk list */}
          <div className="flex flex-col gap-2">
            {chunks.map((c, i) => (
              <div key={i} className="flex items-center gap-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
                <span className="text-lg">📦</span>
                <span className="flex-1 text-[13px] font-semibold text-foreground">{c.name}</span>
                <span className="text-xs text-muted-foreground">{c.rows.toLocaleString()} rows · {c.sizeMB} MB</span>
                <Button variant="secondary" size="sm" onClick={() => downloadChunk(i)}>⬇ Download</Button>
              </div>
            ))}
          </div>

          {logLines.length > 0 && <LogBox logRef={logRef} lines={logLines} />}
        </Card>
      )}

      {/* AI Enrichment */}
      <Card
        title="AI Enrichment"
        subtitle="Scans the database for contacts missing data, searches the web with AI, and fills the gaps — grouped by company domain."
        actions={<StatusBadge status={enrichJobTone}>{enrichPhase}</StatusBadge>}
      >
        {/* Field selection */}
        <div className="mb-5">
          <SectionLabel>Claude fields (fills blanks only)</SectionLabel>
          <div className="mb-3 flex flex-wrap gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-foreground">
              <Checkbox checked={enrichKeywords} onCheckedChange={v => setEnrichKeywords(Boolean(v))} />
              Keywords
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-foreground">
              <Checkbox checked={enrichIndustry} onCheckedChange={v => setEnrichIndustry(Boolean(v))} />
              Industry
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-foreground">
              <Checkbox checked={enrichEmployees} onCheckedChange={v => setEnrichEmployees(Boolean(v))} />
              Company Size
            </label>
          </div>
          <SectionLabel>Companies House (always updated — live gov data)</SectionLabel>
          <div className="text-xs leading-relaxed text-muted-foreground">
            Company status · Company type · Founded year · Postcode · Full address · SIC codes · Jurisdiction · Active &amp; resigned officers · Last accounts date · Insolvency history · Charges · Accounts overdue · Cessation date
          </div>
        </div>

        {/* Batch size + concurrency */}
        <div className="mb-5 flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-3">
            <SectionLabel>Batch size</SectionLabel>
            <Select value={enrichLimit} onValueChange={v => setEnrichLimit(v ?? '100')} disabled={isEnrichActive}>
              <SelectTrigger className="min-w-[180px]"><SelectValue /></SelectTrigger>
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
            <SectionLabel>Speed</SectionLabel>
            <Select value={enrichConcurrency} onValueChange={v => setEnrichConcurrency(v ?? '5')} disabled={isEnrichActive}>
              <SelectTrigger className="min-w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 — safe</SelectItem>
                <SelectItem value="3">3 — normal</SelectItem>
                <SelectItem value="5">5 — fast (recommended)</SelectItem>
                <SelectItem value="10">10 — max</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Controls */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {(enrichPhase === 'idle' || enrichPhase === 'completed' || enrichPhase === 'stopped') && (
            <Button variant="secondary" onClick={() => void scanEnrichment()}>Scan Database</Button>
          )}

          {enrichPhase === 'scanning' && (
            <Button variant="secondary" disabled>Scanning…</Button>
          )}

          {enrichPhase === 'scan-ready' && (
            <>
              <Button onClick={() => void startEnrichment()}>Confirm &amp; Start</Button>
              <Button variant="ghost" onClick={cancelScan}>Cancel</Button>
            </>
          )}

          {isEnrichRunning && (
            <>
              <Button variant="ghost" onClick={() => void pauseEnrichment()}>⏸ Pause</Button>
              <Button variant="destructive" onClick={() => void stopEnrichment()}>■ Stop</Button>
            </>
          )}

          {isEnrichPaused && (
            <>
              <Button variant="ghost" onClick={() => void resumeEnrichment()}>▶ Resume</Button>
              <Button variant="destructive" onClick={() => void stopEnrichment()}>■ Stop</Button>
            </>
          )}

          {enrichStatusMsg && <span className="text-xs text-muted-foreground">{enrichStatusMsg}</span>}
        </div>

        {/* Scan result confirmation box */}
        {enrichPhase === 'scan-ready' && enrichScanData && (
          <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-5 py-4">
            <div className="mb-1 text-sm font-semibold text-emerald-700 dark:text-emerald-400">Ready to enrich</div>
            <div className="text-[13px] text-foreground">
              <strong>{enrichScanData.domains.toLocaleString()} domains</strong> need enrichment &nbsp;·&nbsp;{' '}
              {enrichScanData.contacts.toLocaleString()} contacts affected &nbsp;·&nbsp;{' '}
              Est. cost: <strong>${enrichScanData.cost_usd.toFixed(4)}</strong>
            </div>
          </div>
        )}

        {/* Progress section */}
        {showEnrichProgress && (
          <div>
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>{enrichProgressLabel}</span>
              <span className="italic">{enrichCurrentDomain}</span>
            </div>
            <ProgressBar pct={enrichProgress} />

            {/* Stats row */}
            <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
              <KpiCard label="Updated" value={enrichStats.updated.toLocaleString()} tone="teal" />
              <KpiCard label="Skipped" value={enrichStats.skipped.toLocaleString()} tone="navy" />
              <KpiCard label="Failed" value={enrichStats.failed.toLocaleString()} tone="yellow" />
              <KpiCard label="Domains" value={enrichStats.total.toLocaleString()} tone="green" />
              <KpiCard label="Cost (USD)" value={`$${enrichStats.cost.toFixed(4)}`} tone="purple" />
              <KpiCard label="Est. Time Left" value={enrichEta} tone="yellow" />
            </div>

            {/* Enrich log */}
            {enrichLog.length > 0 && <LogBox logRef={enrichLogRef} lines={enrichLog} />}

            {/* Sample CSV export */}
            <div className="mt-4 border-t border-border pt-4">
              <SectionLabel>Sample Export</SectionLabel>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="ghost" disabled={sampleCsvLoading} onClick={() => void downloadSampleCsv()}>
                  {sampleCsvLoading ? 'Working…' : 'Download 100 contact sample (original + enriched)'}
                </Button>
                {sampleCsvStatus && <span className="text-xs text-muted-foreground">{sampleCsvStatus}</span>}
              </div>
            </div>

            {/* Results table */}
            {showEnrichResults && enrichResults.length > 0 && (
              <div className="mt-5">
                <SectionLabel>Results</SectionLabel>
                <DataTable
                  columns={resultColumns}
                  rows={enrichResults}
                  getRowKey={(r, i) => `${r.domain}-${i}`}
                />
              </div>
            )}
          </div>
        )}
      </Card>
    </PageShell>
  )
}
