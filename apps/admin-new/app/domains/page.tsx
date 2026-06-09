'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface SpfCheck {
  present?: boolean
  strict?: boolean
  valid?: boolean
  raw?: string
}

interface DkimCheck {
  present?: boolean
  selector?: string
  raw?: string
}

interface DmarcCheck {
  present?: boolean
  policy?: string
  raw?: string
}

interface MxCheck {
  present?: boolean
  top?: string
  hosts?: string[]
  ips?: string[]
}

interface Blacklist {
  list: string
  response?: string
  target?: string
  ip?: string
}

interface Domain {
  domain: string
  workspace_name: string
  score: number
  status: 'good' | 'warning' | 'critical'
  spf: SpfCheck | null
  dkim: DkimCheck | null
  dmarc: DmarcCheck | null
  mx: MxCheck | null
  blacklists: Blacklist[]
  last_checked: string | null
  notes: string | null
}

interface DomainsResponse {
  rows: Domain[]
  lastRun?: string
  running?: boolean
}

interface CheckResult {
  score: number
  status: 'good' | 'warning' | 'critical'
  notes?: string
}

function CheckIcon({ state, title }: { state: boolean | 'warn' | null, title: string }) {
  if (state === null) {
    return <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-400 font-bold text-xs" title={title}>—</span>
  }
  if (state === true) {
    return <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-700 font-bold text-xs" title={title}>✓</span>
  }
  if (state === 'warn') {
    return <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-yellow-100 text-yellow-800 font-bold text-xs" title={title}>!</span>
  }
  return <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-100 text-red-700 font-bold text-xs" title={title}>✕</span>
}

function spfState(spf: SpfCheck | null): boolean | 'warn' | null {
  if (!spf || !spf.present) return null
  if (spf.valid && spf.strict) return true
  if (spf.valid) return 'warn'
  return false
}

function dmarcState(dmarc: DmarcCheck | null): boolean | 'warn' | null {
  if (!dmarc || !dmarc.present) return null
  if (dmarc.policy === 'reject' || dmarc.policy === 'quarantine') return true
  return 'warn'
}

function formatAgo(ts: string | null): string {
  if (!ts) return '—'
  const ms = Date.now() - new Date(ts).getTime()
  const h = Math.floor(ms / 3600000)
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function StatusPill({ status }: { status: string }) {
  const classes = {
    good: 'bg-green-100 text-green-700',
    warning: 'bg-yellow-100 text-yellow-800',
    critical: 'bg-red-100 text-red-700',
  }
  const baseClass = classes[status as keyof typeof classes] || 'bg-gray-100 text-gray-700'
  return <span className={`inline-block px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${baseClass}`}>{status}</span>
}

function DetailModal({ domain, onClose }: { domain: Domain | null, onClose: () => void }) {
  if (!domain) return null

  const spf = domain.spf || {}
  const dkim = domain.dkim || {}
  const dmarc = domain.dmarc || {}
  const mx = domain.mx || {}
  const bl = domain.blacklists || []

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-lg" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between">
          <div>
            <div className="text-lg font-bold">{domain.domain}</div>
            <div className="text-sm text-gray-600">{domain.workspace_name || 'Unassigned'} · score {domain.score}</div>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-gray-500 hover:text-gray-700">×</button>
        </div>
        <div className="p-6 space-y-6">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-gray-600 mb-2">SPF</div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-gray-600">Present</div>
              <div>{spf.present ? 'Yes' : 'No'}</div>
              <div className="text-gray-600">Strict (-all)</div>
              <div>{spf.strict ? 'Yes' : 'No'}</div>
              {spf.raw && (
                <>
                  <div className="text-gray-600">Record</div>
                  <code className="bg-gray-100 text-xs px-2 py-1 rounded overflow-x-auto">{spf.raw}</code>
                </>
              )}
            </div>
          </div>

          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-gray-600 mb-2">DKIM</div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-gray-600">Present</div>
              <div>{dkim.present ? `Yes (selector: ${dkim.selector})` : 'No DKIM record found on common selectors'}</div>
              {dkim.raw && (
                <>
                  <div className="text-gray-600">Record</div>
                  <code className="bg-gray-100 text-xs px-2 py-1 rounded overflow-x-auto">{dkim.raw}</code>
                </>
              )}
            </div>
          </div>

          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-gray-600 mb-2">DMARC</div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-gray-600">Present</div>
              <div>{dmarc.present ? 'Yes' : 'No'}</div>
              <div className="text-gray-600">Policy</div>
              <div>{dmarc.policy || '—'}</div>
              {dmarc.raw && (
                <>
                  <div className="text-gray-600">Record</div>
                  <code className="bg-gray-100 text-xs px-2 py-1 rounded overflow-x-auto">{dmarc.raw}</code>
                </>
              )}
            </div>
          </div>

          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-gray-600 mb-2">MX</div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-gray-600">Present</div>
              <div>{mx.present ? 'Yes' : 'No'}</div>
              {mx.top && (
                <>
                  <div className="text-gray-600">Top MX</div>
                  <div>{mx.top}</div>
                </>
              )}
              {mx.hosts && mx.hosts.length > 0 && (
                <>
                  <div className="text-gray-600">All</div>
                  <code className="bg-gray-100 text-xs px-2 py-1 rounded">{mx.hosts.join(', ')}</code>
                </>
              )}
              {mx.ips && mx.ips.length > 0 && (
                <>
                  <div className="text-gray-600">IPs</div>
                  <code className="bg-gray-100 text-xs px-2 py-1 rounded">{mx.ips.join(', ')}</code>
                </>
              )}
            </div>
          </div>

          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-gray-600 mb-2">Domain Blacklists</div>
            {bl.length > 0 ? (
              <div className="space-y-2">
                {bl.map((b, i) => (
                  <div key={i} className="text-sm border-b pb-2 last:border-b-0">
                    <span className="font-bold text-red-600">{b.list}</span>{' '}
                    <span className="text-gray-600">— {b.target || b.ip || ''} (code {b.response || '?'})</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-green-600 font-semibold">Clean on all domain blacklists.</div>
            )}
          </div>

          {domain.notes && (
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-gray-600 mb-2">Notes</div>
              <div className="text-sm">{domain.notes}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CheckDomainModal({ onClose, onSuccess }: { onClose: () => void, onSuccess: () => void }) {
  const [domain, setDomain] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<CheckResult | null>(null)
  const [error, setError] = useState('')

  const handleCheck = async () => {
    if (!domain.trim()) {
      setError('Enter a domain.')
      return
    }

    setLoading(true)
    setError('')
    setResult(null)

    try {
      const res = await fetch('/api/domains/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain.trim().toLowerCase() })
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Check failed')
      } else {
        setResult(data)
        await new Promise(r => setTimeout(r, 1000))
        onSuccess()
        onClose()
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md shadow-lg" onClick={e => e.stopPropagation()}>
        <div className="border-b px-6 py-4 flex items-center justify-between">
          <div className="text-lg font-bold">Check a domain now</div>
          <button onClick={onClose} className="text-2xl leading-none text-gray-500 hover:text-gray-700">×</button>
        </div>
        <div className="p-6">
          <p className="text-sm text-gray-600 mb-4">Runs SPF, DKIM, DMARC, MX and DNS-blacklist checks. Saved to the table.</p>
          <input
            type="text"
            placeholder="example.com"
            value={domain}
            onChange={e => setDomain(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !loading && handleCheck()}
            disabled={loading}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:border-blue-500"
          />
          {error && <div className="mt-3 text-sm text-red-600">{error}</div>}
          {result && (
            <div className="mt-3 text-sm">
              <div>Score: <b>{result.score}</b> — <StatusPill status={result.status} /></div>
              <div className="text-gray-600 mt-1">{result.notes || 'All checks passed.'}</div>
            </div>
          )}
        </div>
        <div className="border-t px-6 py-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={handleCheck} disabled={loading}>{loading ? 'Checking...' : 'Run check'}</Button>
        </div>
      </div>
    </div>
  )
}

export default function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([])
  const [filtered, setFiltered] = useState<Domain[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [wsFilter, setWsFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [lastRun, setLastRun] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [detailDomain, setDetailDomain] = useState<Domain | null>(null)
  const [showCheckModal, setShowCheckModal] = useState(false)
  const [toast, setToast] = useState('')

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 2400)
  }

  const loadData = async () => {
    try {
      const res = await fetch('/api/domains/health')
      const data: DomainsResponse = await res.json()
      setDomains(data.rows || [])
      if (data.lastRun) {
        setLastRun(new Date(data.lastRun).toLocaleString())
      }
      setRefreshing(data.running || false)
    } catch (err) {
      showToast('Failed to load: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  const workspaces = Array.from(new Set(domains.map(d => d.workspace_name).filter(Boolean))).sort()

  useEffect(() => {
    let result = [...domains]
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(d =>
        d.domain.includes(q) || (d.workspace_name?.toLowerCase().includes(q))
      )
    }
    if (wsFilter) result = result.filter(d => d.workspace_name === wsFilter)
    if (statusFilter) result = result.filter(d => d.status === statusFilter)
    setFiltered(result)
  }, [domains, search, wsFilter, statusFilter])

  const summary = {
    total: domains.length,
    good: domains.filter(d => d.status === 'good').length,
    warning: domains.filter(d => d.status === 'warning').length,
    critical: domains.filter(d => d.status === 'critical').length,
    blacklisted: domains.filter(d => d.blacklists?.length > 0).length
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const res = await fetch('/api/domains/refresh', { method: 'POST' })
      const data = await res.json()
      showToast(data.message || 'Refresh started')

      const poll = setInterval(async () => {
        const res = await fetch('/api/domains/health')
        const data: DomainsResponse = await res.json()
        setDomains(data.rows || [])
        if (data.lastRun) {
          setLastRun(new Date(data.lastRun).toLocaleString())
        }
        if (!data.running) {
          clearInterval(poll)
          setRefreshing(false)
        }
      }, 8000)
    } catch (err) {
      showToast('Refresh failed: ' + (err as Error).message)
      setRefreshing(false)
    }
  }

  const handleRemove = async (domain: string) => {
    if (!confirm(`Remove ${domain} from the dashboard?\n\nThe domain stays in PlusVibe, but it won't show up here and won't be re-added on the next auto-refresh.`)) return

    try {
      const res = await fetch('/api/domains/' + encodeURIComponent(domain), { method: 'DELETE' })
      if (!res.ok) {
        showToast('Remove failed')
        return
      }
      setDomains(domains.filter(d => d.domain !== domain))
      showToast(domain + ' removed')
    } catch (err) {
      showToast('Remove error: ' + (err as Error).message)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-8 py-6">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Domain Health</h1>
            <p className="text-sm text-gray-600 mt-1">SPF · DKIM · DMARC · MX · domain blacklists (Spamhaus DBL, SURBL, URIBL) — across all sending domains. Auto-refreshed every 6 hours.</p>
          </div>
          <div className="flex items-center gap-3">
            {lastRun && <span className="text-xs text-gray-600">Last refresh: {lastRun}</span>}
            <Button variant="outline" size="sm" onClick={() => setShowCheckModal(true)}>+ Check domain</Button>
            <Button size="sm" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? '↻ Refreshing…' : '↻ Refresh all'}
            </Button>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="bg-white border-b px-8 py-6">
        <div className="max-w-7xl mx-auto grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-gray-900">
            <div className="text-xs font-bold uppercase text-gray-600">Total domains</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">{summary.total}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-green-500">
            <div className="text-xs font-bold uppercase text-gray-600">Good</div>
            <div className="text-2xl font-bold text-green-600 mt-1">{summary.good}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-yellow-500">
            <div className="text-xs font-bold uppercase text-gray-600">Warning</div>
            <div className="text-2xl font-bold text-yellow-600 mt-1">{summary.warning}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-red-500">
            <div className="text-xs font-bold uppercase text-gray-600">Critical</div>
            <div className="text-2xl font-bold text-red-600 mt-1">{summary.critical}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-red-500">
            <div className="text-xs font-bold uppercase text-gray-600">Blacklisted</div>
            <div className="text-2xl font-bold text-red-600 mt-1">{summary.blacklisted}</div>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="bg-white border-b px-8 py-4">
        <div className="max-w-7xl mx-auto flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-64 relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
            <input
              type="text"
              placeholder='Search domain or client (e.g. "FAIT", "ottaly.co.uk")...'
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-10 pr-3 py-2 border rounded-lg text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          <select
            value={wsFilter}
            onChange={e => setWsFilter(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm focus:outline-none focus:border-blue-500 min-w-40"
          >
            <option value="">All clients</option>
            {workspaces.map(w => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
          <div className="flex gap-2">
            {['All', 'Critical', 'Warning', 'Good'].map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s === 'All' ? '' : s.toLowerCase())}
                className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider transition ${
                  (s === 'All' ? statusFilter === '' : statusFilter === s.toLowerCase())
                    ? 'bg-gray-900 text-white'
                    : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-50'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="px-8 py-6">
        <div className="max-w-7xl mx-auto bg-white rounded-lg border overflow-hidden">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-gray-600">
              {loading ? 'Loading...' : 'No domains yet. Either click "Refresh all" to scan now, or add one via "Check domain".'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50 hover:bg-gray-50">
                  <TableHead className="text-xs font-bold uppercase">Domain</TableHead>
                  <TableHead className="text-center text-xs font-bold uppercase">SPF</TableHead>
                  <TableHead className="text-center text-xs font-bold uppercase">DKIM</TableHead>
                  <TableHead className="text-center text-xs font-bold uppercase">DMARC</TableHead>
                  <TableHead className="text-center text-xs font-bold uppercase">MX</TableHead>
                  <TableHead className="text-xs font-bold uppercase">Blacklists</TableHead>
                  <TableHead className="text-right text-xs font-bold uppercase">Score</TableHead>
                  <TableHead className="text-xs font-bold uppercase">Status</TableHead>
                  <TableHead className="text-xs font-bold uppercase">Last checked</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(d => (
                  <TableRow
                    key={d.domain}
                    onClick={() => setDetailDomain(d)}
                    className="hover:bg-blue-50 cursor-pointer"
                  >
                    <TableCell>
                      <div className="font-bold">{d.domain}</div>
                      <div className="text-xs text-gray-600">{d.workspace_name || '—'}</div>
                    </TableCell>
                    <TableCell className="text-center">
                      <CheckIcon state={spfState(d.spf)} title={d.spf?.raw || 'Missing'} />
                    </TableCell>
                    <TableCell className="text-center">
                      <CheckIcon state={d.dkim?.present === true ? true : false} title={d.dkim?.selector ? `selector: ${d.dkim.selector}` : 'No DKIM record found'} />
                    </TableCell>
                    <TableCell className="text-center">
                      <CheckIcon state={dmarcState(d.dmarc)} title={d.dmarc?.policy ? `p=${d.dmarc.policy}` : 'Missing'} />
                    </TableCell>
                    <TableCell className="text-center">
                      <CheckIcon state={d.mx?.present === true ? true : false} title={(d.mx?.hosts || []).join(', ')} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {d.blacklists.length > 0 ? (
                        <>
                          <span className="font-bold text-red-600">{d.blacklists.length} listing{d.blacklists.length > 1 ? 's' : ''}</span>
                          <span className="text-gray-600 text-xs ml-1">{d.blacklists.slice(0, 2).map(b => b.list).join(', ')}{d.blacklists.length > 2 ? '…' : ''}</span>
                        </>
                      ) : (
                        <span className="font-bold text-green-600">Clean</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-bold">{d.score}</TableCell>
                    <TableCell>
                      <StatusPill status={d.status} />
                    </TableCell>
                    <TableCell className="text-xs text-gray-600">{formatAgo(d.last_checked)}</TableCell>
                    <TableCell onClick={e => e.stopPropagation()} className="text-right">
                      <button
                        onClick={() => handleRemove(d.domain)}
                        className="text-gray-500 hover:text-red-600 hover:bg-red-50 px-2 py-1 rounded text-lg leading-none"
                        title="Remove"
                      >
                        ✕
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 bg-gray-900 text-white px-4 py-3 rounded-lg text-sm font-medium animate-in">
          {toast}
        </div>
      )}

      {/* Detail modal */}
      <DetailModal domain={detailDomain} onClose={() => setDetailDomain(null)} />

      {/* Check domain modal */}
      {showCheckModal && (
        <CheckDomainModal onClose={() => setShowCheckModal(false)} onSuccess={loadData} />
      )}
    </div>
  )
}
