'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

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
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const startPoll = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    pollTimerRef.current = setInterval(pollEnrichStatus, 2000)
    void pollEnrichStatus()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="min-h-screen" style={{ background: '#F0F2F8', fontFamily: 'Inter, sans-serif', color: '#050C29' }}>
      <div style={{ maxWidth: 960, margin: '2rem auto', padding: '0 1.5rem' }}>

        {/* Apollo Account Split */}
        <div className="card" style={cardStyle}>
          <h1 style={h1Style}>Apollo Account Split — UK</h1>
          <p style={subStyle}>
            Export your existing database contacts split by account, or find net-new contacts in Apollo.
            Account 1 = London + South East; Account 2 = rest of the UK. No duplicates between accounts.
          </p>

          <div style={{ marginBottom: '1.5rem' }}>
            <div style={sectionLabelStyle}>Export from your database</div>
            <div style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                style={{ ...btnStyle, ...btnPrimaryStyle }}
                disabled={exportingAccount !== null}
                onClick={() => void exportSplit(1)}
              >
                {exportingAccount === 1 ? 'Exporting…' : '↓ Export Account 1 — London + South East'}
              </button>
              <button
                style={{ ...btnStyle, ...btnTealStyle }}
                disabled={exportingAccount !== null}
                onClick={() => void exportSplit(2)}
              >
                {exportingAccount === 2 ? 'Exporting…' : '↓ Export Account 2 — Rest of UK'}
              </button>
            </div>
            {exportStatus && (
              <div style={{ fontSize: 12, color: '#6B7280', marginTop: '.5rem' }}>{exportStatus}</div>
            )}
          </div>

          <div>
            <div style={sectionLabelStyle}>Find net-new contacts in Apollo</div>
            <div style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap' }}>
              <a
                href={APOLLO_URL_ACCOUNT1}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...btnStyle, ...btnPrimaryStyle, textDecoration: 'none' }}
              >
                &#x2197; Account 1 — London + South East
              </a>
              <a
                href={APOLLO_URL_ACCOUNT2}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...btnStyle, ...btnTealStyle, textDecoration: 'none' }}
              >
                &#x2197; Account 2 — Rest of UK
              </a>
            </div>
          </div>
        </div>

        {/* Apollo Upload Prep */}
        <div className="card" style={cardStyle}>
          <h1 style={h1Style}>Apollo Upload Prep</h1>
          <p style={subStyle}>
            Drop any number of CSVs. Emails are extracted, deduplicated, stripped of all other columns,
            and split into chunks ≤ 45 MB / 100,000 rows — ready to import straight into Apollo.
          </p>

          {/* Drop zone */}
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={e => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files) }}
            style={{
              border: `2px dashed ${isDragging ? '#1F6F78' : '#E2E6F0'}`,
              borderRadius: 12,
              padding: '3rem 2rem',
              textAlign: 'center',
              cursor: 'pointer',
              background: isDragging ? '#EEF9FA' : '#FAFBFF',
              transition: 'all .2s',
            }}
          >
            <div style={{ fontSize: '2.5rem', marginBottom: '.75rem' }}>📂</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Drop CSV files here, or click to browse</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: '.4rem' }}>
              Any column named Email / email / Email Address / email_address / E-mail will be detected automatically
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            multiple
            style={{ display: 'none' }}
            onChange={e => { if (e.target.files) addFiles(e.target.files) }}
          />

          {/* File list */}
          {pendingFiles.length > 0 && (
            <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
              {pendingFiles.map((p, i) => (
                <div key={i} style={fileRowStyle}>
                  <span style={{ fontSize: 16 }}>📄</span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                  </span>
                  <span style={{ fontSize: 11, color: '#6B7280' }}>{(p.file.size / 1024).toFixed(0)} KB</span>
                  <button
                    onClick={() => removeFile(i)}
                    title="Remove"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', fontSize: 16, padding: '2px 6px', borderRadius: 4 }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#FEE2E2'; (e.currentTarget as HTMLButtonElement).style.color = '#DC2626' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none'; (e.currentTarget as HTMLButtonElement).style.color = '#6B7280' }}
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}

          {pendingFiles.length > 0 && (
            <div style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '1rem' }}>
              <button
                style={{ ...btnStyle, ...btnPrimaryStyle, opacity: processing ? 0.5 : 1, cursor: processing ? 'not-allowed' : 'pointer' }}
                disabled={processing}
                onClick={() => void processCsvFiles()}
              >
                {processing ? '⏳ Processing…' : '⚡ Process files'}
              </button>
              <button
                style={{ ...btnStyle, ...btnGhostStyle }}
                disabled={processing}
                onClick={clearAll}
              >
                ✕ Clear all
              </button>
            </div>
          )}
        </div>

        {/* Results */}
        {showResults && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <div>
                <div style={{ fontSize: '1rem', fontWeight: 700 }}>Results</div>
                {resultStats && (
                  <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>
                    {resultStats.chunkCount} chunk{resultStats.chunkCount !== 1 ? 's' : ''} ready to download
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                <button
                  style={{ ...btnStyle, ...btnTealStyle, padding: '5px 12px', fontSize: 12 }}
                  onClick={downloadAll}
                  disabled={!chunks.length}
                >
                  ⬇ Download all
                </button>
                <span style={{ fontSize: 11, color: '#6B7280' }}>
                  If Chrome asks &ldquo;allow multiple downloads&rdquo; — click Allow
                </span>
              </div>
            </div>

            {resultStats && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '.75rem', marginBottom: '1.5rem' }}>
                <StatCard label="Unique emails" value={resultStats.uniqueEmails.toLocaleString()} color="#1F6F78" />
                <StatCard label="Output chunks" value={String(resultStats.chunkCount)} color="#16A34A" />
                <StatCard label="Duplicates removed" value={resultStats.dupes.toLocaleString()} color="#D97706" />
                <StatCard label="Files skipped" value={String(resultStats.skipped)} color="#224388" />
              </div>
            )}

            {/* Progress bar */}
            <div style={{ height: 6, background: '#E5E7EB', borderRadius: 3, overflow: 'hidden', margin: '.75rem 0' }}>
              <div style={{ height: '100%', background: '#1F6F78', borderRadius: 3, width: `${progress}%`, transition: 'width .3s' }} />
            </div>

            {/* Chunk list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
              {chunks.map((c, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '.75rem 1rem', background: '#F8F9FC', borderRadius: 10, border: '1px solid #E2E6F0' }}>
                  <span style={{ fontSize: 18 }}>📦</span>
                  <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{c.name}</span>
                  <span style={{ fontSize: 12, color: '#6B7280' }}>{c.rows.toLocaleString()} rows · {c.sizeMB} MB</span>
                  <button
                    style={{ ...btnStyle, ...btnTealStyle, padding: '5px 12px', fontSize: 12 }}
                    onClick={() => downloadChunk(i)}
                  >
                    ⬇ Download
                  </button>
                </div>
              ))}
            </div>

            {/* Log */}
            {logLines.length > 0 && (
              <div
                ref={logRef}
                style={{ fontFamily: '\'SF Mono\', ui-monospace, monospace', fontSize: 11, color: '#6B7280', background: '#F8F9FC', border: '1px solid #E2E6F0', borderRadius: 8, padding: '.75rem 1rem', maxHeight: 140, overflowY: 'auto', marginTop: '1rem', lineHeight: 1.6 }}
              >
                {logLines.map((l, i) => (
                  <div key={i} style={{ color: l.type === 'ok' ? '#16A34A' : l.type === 'err' ? '#DC2626' : l.type === 'warn' ? '#D97706' : '#6B7280' }}>
                    {l.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* AI Enrichment */}
        <div style={{ ...cardStyle, marginTop: '1.5rem' }}>
          <h1 style={{ ...h1Style, marginBottom: 4 }}>AI Enrichment</h1>
          <p style={subStyle}>
            Scans the database for contacts missing data, searches the web using AI, and fills in the gaps.
            Groups by company domain — one search enriches all contacts from the same company.
          </p>

          {/* Field selection */}
          <div style={{ marginBottom: '1.25rem' }}>
            <div style={sectionLabelStyle}>Claude fields (fills blanks only)</div>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '.75rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                <input type="checkbox" checked={enrichKeywords} onChange={e => setEnrichKeywords(e.target.checked)} style={{ accentColor: '#1F6F78', width: 15, height: 15 }} />
                Keywords
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                <input type="checkbox" checked={enrichIndustry} onChange={e => setEnrichIndustry(e.target.checked)} style={{ accentColor: '#1F6F78', width: 15, height: 15 }} />
                Industry
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                <input type="checkbox" checked={enrichEmployees} onChange={e => setEnrichEmployees(e.target.checked)} style={{ accentColor: '#1F6F78', width: 15, height: 15 }} />
                Company Size
              </label>
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: '#6B7280', marginBottom: '.4rem' }}>
              Companies House (always updated — live gov data)
            </div>
            <div style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.6 }}>
              Company status · Company type · Founded year · Postcode · Full address · SIC codes · Jurisdiction · Active &amp; resigned officers · Last accounts date · Insolvency history · Charges · Accounts overdue · Cessation date
            </div>
          </div>

          {/* Batch size + concurrency */}
          <div style={{ marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem' }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: '#6B7280' }}>Batch size</div>
              <select
                value={enrichLimit}
                onChange={e => setEnrichLimit(e.target.value)}
                disabled={isEnrichActive}
                style={selectStyle}
              >
                <option value="100">100 domains (test)</option>
                <option value="500">500 domains</option>
                <option value="1000">1,000 domains</option>
                <option value="5000">5,000 domains</option>
                <option value="0">Full database</option>
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem' }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: '#6B7280' }}>Speed</div>
              <select
                value={enrichConcurrency}
                onChange={e => setEnrichConcurrency(e.target.value)}
                disabled={isEnrichActive}
                style={selectStyle}
              >
                <option value="1">1 — safe</option>
                <option value="3">3 — normal</option>
                <option value="5">5 — fast (recommended)</option>
                <option value="10">10 — max</option>
              </select>
            </div>
          </div>

          {/* Controls */}
          <div style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
            {(enrichPhase === 'idle' || enrichPhase === 'completed' || enrichPhase === 'stopped') && (
              <button
                style={{ ...btnStyle, ...btnTealStyle }}
                onClick={() => void scanEnrichment()}
              >
                Scan Database
              </button>
            )}

            {enrichPhase === 'scanning' && (
              <button style={{ ...btnStyle, ...btnTealStyle, opacity: 0.5 }} disabled>
                Scanning…
              </button>
            )}

            {enrichPhase === 'scan-ready' && (
              <>
                <button
                  style={{ ...btnStyle, background: '#16A34A', color: '#fff' }}
                  onClick={() => void startEnrichment()}
                >
                  Confirm &amp; Start
                </button>
                <button
                  style={{ ...btnStyle, ...btnGhostStyle }}
                  onClick={cancelScan}
                >
                  Cancel
                </button>
              </>
            )}

            {isEnrichRunning && (
              <>
                <button style={{ ...btnStyle, ...btnGhostStyle }} onClick={() => void pauseEnrichment()}>⏸ Pause</button>
                <button style={{ ...btnStyle, ...btnGhostStyle }} onClick={() => void stopEnrichment()}>■ Stop</button>
              </>
            )}

            {isEnrichPaused && (
              <>
                <button style={{ ...btnStyle, ...btnGhostStyle }} onClick={() => void resumeEnrichment()}>▶ Resume</button>
                <button style={{ ...btnStyle, ...btnGhostStyle }} onClick={() => void stopEnrichment()}>■ Stop</button>
              </>
            )}

            {enrichStatusMsg && (
              <span style={{ fontSize: 12, color: '#6B7280' }}>{enrichStatusMsg}</span>
            )}
          </div>

          {/* Scan result confirmation box */}
          {enrichPhase === 'scan-ready' && enrichScanData && (
            <div style={{ background: '#F0FDF4', border: '1px solid #86EFAC', borderRadius: 10, padding: '1rem 1.25rem', marginBottom: '1rem' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#15803D', marginBottom: '.4rem' }}>Ready to enrich</div>
              <div style={{ fontSize: 13, color: '#166534' }}>
                <strong>{enrichScanData.domains.toLocaleString()} domains</strong> need enrichment &nbsp;·&nbsp;{' '}
                {enrichScanData.contacts.toLocaleString()} contacts affected &nbsp;·&nbsp;{' '}
                Est. cost: <strong>${enrichScanData.cost_usd.toFixed(4)}</strong>
              </div>
            </div>
          )}

          {/* Progress section */}
          {showEnrichProgress && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6B7280', marginBottom: 4 }}>
                <span>{enrichProgressLabel}</span>
                <span style={{ fontStyle: 'italic' }}>{enrichCurrentDomain}</span>
              </div>
              <div style={{ height: 6, background: '#E5E7EB', borderRadius: 3, overflow: 'hidden', margin: '.75rem 0' }}>
                <div style={{ height: '100%', background: '#1F6F78', borderRadius: 3, width: `${enrichProgress}%`, transition: 'width .3s' }} />
              </div>

              {/* Stats row */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '.75rem', marginTop: '1rem' }}>
                <StatCard label="Updated" value={enrichStats.updated.toLocaleString()} color="#1F6F78" />
                <StatCard label="Skipped" value={enrichStats.skipped.toLocaleString()} color="#224388" />
                <StatCard label="Failed" value={enrichStats.failed.toLocaleString()} color="#D97706" />
                <StatCard label="Domains" value={enrichStats.total.toLocaleString()} color="#16A34A" />
                <StatCard label="Cost (USD)" value={`$${enrichStats.cost.toFixed(4)}`} color="#8b5cf6" />
                <StatCard label="Est. Time Left" value={enrichEta} color="#ec4899" />
              </div>

              {/* Enrich log */}
              {enrichLog.length > 0 && (
                <div
                  ref={enrichLogRef}
                  style={{ fontFamily: '\'SF Mono\', ui-monospace, monospace', fontSize: 11, color: '#6B7280', background: '#F8F9FC', border: '1px solid #E2E6F0', borderRadius: 8, padding: '.75rem 1rem', maxHeight: 150, overflowY: 'auto', marginTop: '.75rem', lineHeight: 1.6 }}
                >
                  {enrichLog.map((l, i) => (
                    <div key={i} style={{ color: l.type === 'ok' ? '#16A34A' : l.type === 'err' ? '#DC2626' : '#D97706' }}>
                      {l.text}
                    </div>
                  ))}
                </div>
              )}

              {/* Sample CSV export */}
              <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #E2E6F0' }}>
                <div style={sectionLabelStyle}>Sample Export</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem', flexWrap: 'wrap' }}>
                  <button
                    style={{ ...btnStyle, ...btnGhostStyle, opacity: sampleCsvLoading ? 0.5 : 1, cursor: sampleCsvLoading ? 'not-allowed' : 'pointer' }}
                    disabled={sampleCsvLoading}
                    onClick={() => void downloadSampleCsv()}
                  >
                    Download 100 contact sample (original + enriched)
                  </button>
                  {sampleCsvStatus && (
                    <span style={{ fontSize: 12, color: '#6B7280' }}>{sampleCsvStatus}</span>
                  )}
                </div>
              </div>

              {/* Results table */}
              {showEnrichResults && enrichResults.length > 0 && (
                <div style={{ marginTop: '1.25rem' }}>
                  <div style={sectionLabelStyle}>Results</div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: '#F8F9FC', borderBottom: '2px solid #E2E6F0' }}>
                          <th style={thStyle}>Domain</th>
                          <th style={thStyle}>Industry</th>
                          <th style={thStyle}>Keywords</th>
                          <th style={thStyle}>Employees</th>
                          <th style={thStyle}>Contacts</th>
                          <th style={thStyle}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {enrichResults.map((r, i) => {
                          const statusColor = r.status === 'updated' ? '#16A34A' : r.status === 'failed' ? '#DC2626' : '#6B7280'
                          const kwArr = r.keywords ? r.keywords.split(',') : []
                          const kw = kwArr.length ? kwArr.slice(0, 4).join(', ') + (kwArr.length > 4 ? '…' : '') : '—'
                          return (
                            <tr key={i} style={{ borderBottom: '1px solid #E2E6F0' }}>
                              <td style={tdStyle}><span style={{ fontWeight: 500 }}>{r.domain}</span></td>
                              <td style={tdStyle}>{r.industry ?? '—'}</td>
                              <td style={{ ...tdStyle, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#6B7280' }} title={r.keywords ?? ''}>{kw}</td>
                              <td style={tdStyle}>{r.num_employees != null ? r.num_employees.toLocaleString() : '—'}</td>
                              <td style={tdStyle}>{r.contacts}</td>
                              <td style={{ ...tdStyle, fontWeight: 600, color: statusColor }}>{r.status}</td>
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
        </div>

      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      background: '#fff',
      borderRadius: 10,
      border: '1px solid #E2E6F0',
      borderTop: `3px solid ${color}`,
      padding: '.9rem 1rem',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: '#6B7280' }}>{label}</div>
      <div style={{ fontSize: '1.4rem', fontWeight: 700, marginTop: 3 }}>{value}</div>
    </div>
  )
}

// ── Style objects ─────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 14,
  border: '1px solid #E2E6F0',
  padding: '1.75rem',
  marginBottom: '1.25rem',
}

const h1Style: React.CSSProperties = {
  fontSize: '1.4rem',
  fontWeight: 700,
  marginBottom: 4,
}

const subStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#6B7280',
  marginBottom: '1.5rem',
}

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '.5px',
  color: '#6B7280',
  marginBottom: '.6rem',
}

const btnStyle: React.CSSProperties = {
  padding: '9px 20px',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  border: 'none',
  transition: 'all .15s',
  display: 'inline-flex',
  alignItems: 'center',
}

const btnPrimaryStyle: React.CSSProperties = {
  background: '#224388',
  color: '#fff',
}

const btnTealStyle: React.CSSProperties = {
  background: '#1F6F78',
  color: '#fff',
}

const btnGhostStyle: React.CSSProperties = {
  background: 'transparent',
  color: '#6B7280',
  border: '1px solid #E2E6F0',
}

const fileRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '.75rem',
  padding: '.6rem .9rem',
  background: '#F8F9FC',
  borderRadius: 8,
  border: '1px solid #E2E6F0',
}

const selectStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid #E2E6F0',
  fontSize: 13,
  fontWeight: 500,
  background: '#fff',
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  fontWeight: 600,
  color: '#6B7280',
}

const tdStyle: React.CSSProperties = {
  padding: '7px 10px',
}
