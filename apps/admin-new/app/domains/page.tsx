'use client'

import { useEffect, useState } from 'react'

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
  if (state === null) return <span className="o-chk o-chk-none" title={title}>—</span>
  if (state === true) return <span className="o-chk o-chk-ok" title={title}>✓</span>
  if (state === 'warn') return <span className="o-chk o-chk-warn" title={title}>!</span>
  return <span className="o-chk o-chk-bad" title={title}>✕</span>
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
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function StatusPill({ status }: { status: string }) {
  const cls: Record<string, string> = {
    good: 'o-status-good', warning: 'o-status-warning', critical: 'o-status-critical',
  }
  return <span className={`o-status ${cls[status] ?? 'o-status-unknown'}`}>{status}</span>
}

function DetailModal({ domain, onClose }: { domain: Domain | null, onClose: () => void }) {
  if (!domain) return null
  const spf = domain.spf ?? {}
  const dkim = domain.dkim ?? {}
  const dmarc = domain.dmarc ?? {}
  const mx = domain.mx ?? {}
  const bl = domain.blacklists ?? []

  return (
    <div className="o-modal-overlay" onClick={onClose}>
      <div className="o-modal" onClick={e => e.stopPropagation()}>
        <div className="o-modal-header">
          <div>
            <div className="o-modal-title">{domain.domain}</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>{domain.workspace_name || 'Unassigned'} · score {domain.score}</div>
          </div>
          <button className="o-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="o-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {[
            { label: 'SPF', rows: [['Present', spf.present ? 'Yes' : 'No'], ['Strict (-all)', spf.strict ? 'Yes' : 'No'], spf.raw ? ['Record', spf.raw, true] : null] },
            { label: 'DKIM', rows: [['Present', dkim.present ? `Yes (selector: ${dkim.selector})` : 'No DKIM found on common selectors'], dkim.raw ? ['Record', dkim.raw, true] : null] },
            { label: 'DMARC', rows: [['Present', dmarc.present ? 'Yes' : 'No'], ['Policy', dmarc.policy || '—'], dmarc.raw ? ['Record', dmarc.raw, true] : null] },
            { label: 'MX', rows: [['Present', mx.present ? 'Yes' : 'No'], mx.top ? ['Top MX', mx.top] : null, mx.hosts?.length ? ['All hosts', mx.hosts!.join(', '), true] : null, mx.ips?.length ? ['IPs', mx.ips!.join(', '), true] : null] },
          ].map(section => (
            <div key={section.label}>
              <div className="o-section-h" style={{ marginTop: 0 }}>{section.label}</div>
              <div className="o-detail-grid">
                {section.rows.filter(Boolean).map((row, i) => (
                  row && <><label key={`k${i}`} className="o-detail-label">{row[0]}</label><div key={`v${i}`}>{row[2] ? <code className="o-raw">{row[1]}</code> : row[1]}</div></>
                ))}
              </div>
            </div>
          ))}
          <div>
            <div className="o-section-h" style={{ marginTop: 0 }}>Domain Blacklists</div>
            {bl.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {bl.map((b, i) => (
                  <div key={i} style={{ fontSize: 13, paddingBottom: 8, borderBottom: i < bl.length - 1 ? '1px solid #E2E6F0' : 'none' }}>
                    <span style={{ fontWeight: 700, color: '#DC2626' }}>{b.list}</span>
                    <span style={{ color: '#6B7280' }}> — {b.target || b.ip || ''} (code {b.response || '?'})</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#16A34A', fontWeight: 600 }}>Clean on all domain blacklists.</div>
            )}
          </div>
          {domain.notes && (
            <div>
              <div className="o-section-h" style={{ marginTop: 0 }}>Notes</div>
              <div style={{ fontSize: 13 }}>{domain.notes}</div>
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
    if (!domain.trim()) { setError('Enter a domain.'); return }
    setLoading(true); setError(''); setResult(null)
    try {
      const res = await fetch('/api/domains/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain.trim().toLowerCase() }),
      })
      const data: CheckResult & { error?: string } = await res.json()
      if (!res.ok) { setError(data.error || 'Check failed') }
      else {
        setResult(data)
        await new Promise(r => setTimeout(r, 1000))
        onSuccess(); onClose()
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="o-modal-overlay" onClick={onClose}>
      <div className="o-modal o-modal-sm" onClick={e => e.stopPropagation()}>
        <div className="o-modal-header">
          <div className="o-modal-title">Check a domain now</div>
          <button className="o-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="o-modal-body">
          <p style={{ fontSize: 13, color: '#6B7280', marginBottom: '0.75rem' }}>
            Runs SPF, DKIM, DMARC, MX and DNS-blacklist checks. Saved to the table.
          </p>
          <input
            className="o-input"
            type="text"
            placeholder="example.com"
            value={domain}
            onChange={e => setDomain(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !loading && handleCheck()}
            disabled={loading}
          />
          {error && <div style={{ marginTop: 10, fontSize: 13, color: '#DC2626' }}>{error}</div>}
          {result && (
            <div style={{ marginTop: 10, fontSize: 13 }}>
              Score: <strong>{result.score}</strong> — <StatusPill status={result.status} />
              <div style={{ color: '#6B7280', marginTop: 4 }}>{result.notes || 'All checks passed.'}</div>
            </div>
          )}
        </div>
        <div className="o-modal-footer">
          <button className="o-btn o-btn-ghost" onClick={onClose}>Close</button>
          <button className="o-btn o-btn-primary" onClick={handleCheck} disabled={loading}>
            {loading ? <><span className="o-spin" /> Checking…</> : 'Run check'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([])
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
      if (data.lastRun) setLastRun(new Date(data.lastRun).toLocaleString())
      setRefreshing(data.running || false)
    } catch (err) {
      showToast('Failed to load: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  const workspaces = Array.from(new Set(domains.map(d => d.workspace_name).filter(Boolean))).sort()

  const filtered = domains.filter(d => {
    const q = search.toLowerCase()
    if (search && !d.domain.includes(q) && !d.workspace_name?.toLowerCase().includes(q)) return false
    if (wsFilter && d.workspace_name !== wsFilter) return false
    if (statusFilter && d.status !== statusFilter) return false
    return true
  })

  const summary = {
    total: domains.length,
    good: domains.filter(d => d.status === 'good').length,
    warning: domains.filter(d => d.status === 'warning').length,
    critical: domains.filter(d => d.status === 'critical').length,
    blacklisted: domains.filter(d => d.blacklists?.length > 0).length,
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await fetch('/api/domains/refresh', { method: 'POST' })
      showToast('Refresh started')
      const poll = setInterval(async () => {
        const res = await fetch('/api/domains/health')
        const data: DomainsResponse = await res.json()
        setDomains(data.rows || [])
        if (data.lastRun) setLastRun(new Date(data.lastRun).toLocaleString())
        if (!data.running) { clearInterval(poll); setRefreshing(false) }
      }, 8000)
    } catch (err) {
      showToast('Refresh failed: ' + (err as Error).message)
      setRefreshing(false)
    }
  }

  const handleRemove = async (domain: string) => {
    if (!confirm(`Remove ${domain} from the dashboard?`)) return
    try {
      const res = await fetch('/api/domains/' + encodeURIComponent(domain), { method: 'DELETE' })
      if (!res.ok) { showToast('Remove failed'); return }
      setDomains(domains.filter(d => d.domain !== domain))
      showToast(domain + ' removed')
    } catch (err) {
      showToast('Error: ' + (err as Error).message)
    }
  }

  return (
    <div className="o-page">
      {/* Page header */}
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Domain Health</div>
          <div className="o-page-sub">SPF · DKIM · DMARC · MX · domain blacklists (Spamhaus DBL, SURBL, URIBL) — across all sending domains. Auto-refreshed every 6 hours.</div>
        </div>
        <div className="o-page-actions">
          {lastRun && <span style={{ fontSize: 12, color: '#6B7280' }}>Last refresh: {lastRun}</span>}
          <button className="o-btn o-btn-ghost" onClick={() => setShowCheckModal(true)}>+ Check domain</button>
          <button className="o-btn o-btn-primary" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? <><span className="o-spin" /> Refreshing…</> : '↻ Refresh all'}
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="o-metrics o-metrics-5">
        <div className="o-metric">
          <div className="o-metric-label">Total domains</div>
          <div className="o-metric-val">{summary.total}</div>
        </div>
        <div className="o-metric" style={{ borderTopColor: '#16A34A' }}>
          <div className="o-metric-label">Good</div>
          <div className="o-metric-val" style={{ color: '#16A34A' }}>{summary.good}</div>
        </div>
        <div className="o-metric" style={{ borderTopColor: '#D97706' }}>
          <div className="o-metric-label">Warning</div>
          <div className="o-metric-val" style={{ color: '#D97706' }}>{summary.warning}</div>
        </div>
        <div className="o-metric" style={{ borderTopColor: '#DC2626' }}>
          <div className="o-metric-label">Critical</div>
          <div className="o-metric-val" style={{ color: '#DC2626' }}>{summary.critical}</div>
        </div>
        <div className="o-metric" style={{ borderTopColor: '#DC2626' }}>
          <div className="o-metric-label">Blacklisted</div>
          <div className="o-metric-val" style={{ color: '#DC2626' }}>{summary.blacklisted}</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="o-toolbar">
        <div className="o-search-wrap">
          <span className="o-search-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </span>
          <input
            type="text"
            placeholder='Search domain or client (e.g. "FAIT", "ottaly.co.uk")…'
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select className="o-select" value={wsFilter} onChange={e => setWsFilter(e.target.value)}>
          <option value="">All clients</option>
          {workspaces.map(w => <option key={w} value={w}>{w}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 6 }}>
          {['All', 'Critical', 'Warning', 'Good'].map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s === 'All' ? '' : s.toLowerCase())}
              className={`o-pill ${(s === 'All' ? statusFilter === '' : statusFilter === s.toLowerCase()) ? 'o-pill-active' : ''}`}
            >{s}</button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="o-table-wrap">
        {loading ? (
          <div className="o-empty"><span className="o-spin" /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="o-empty">No domains yet. Click ↻ Refresh all to scan, or + Check domain to add one.</div>
        ) : (
          <table className="o-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th style={{ textAlign: 'center' }}>SPF</th>
                <th style={{ textAlign: 'center' }}>DKIM</th>
                <th style={{ textAlign: 'center' }}>DMARC</th>
                <th style={{ textAlign: 'center' }}>MX</th>
                <th>Blacklists</th>
                <th style={{ textAlign: 'right' }}>Score</th>
                <th>Status</th>
                <th>Last checked</th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(d => (
                <tr key={d.domain} onClick={() => setDetailDomain(d)}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{d.domain}</div>
                    <div style={{ fontSize: 11, color: '#6B7280', marginTop: 1 }}>{d.workspace_name || '—'}</div>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <CheckIcon state={spfState(d.spf)} title={d.spf?.raw || 'Missing'} />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <CheckIcon state={d.dkim?.present ? true : false} title={d.dkim?.selector ? `selector: ${d.dkim.selector}` : 'No DKIM record found'} />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <CheckIcon state={dmarcState(d.dmarc)} title={d.dmarc?.policy ? `p=${d.dmarc.policy}` : 'Missing'} />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <CheckIcon state={d.mx?.present ? true : false} title={(d.mx?.hosts || []).join(', ')} />
                  </td>
                  <td>
                    {d.blacklists.length > 0
                      ? <span style={{ fontWeight: 600, color: '#DC2626' }}>{d.blacklists.length} listing{d.blacklists.length > 1 ? 's' : ''}</span>
                      : <span style={{ fontWeight: 600, color: '#16A34A' }}>Clean</span>
                    }
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, fontSize: 14 }}>{d.score}</td>
                  <td><StatusPill status={d.status} /></td>
                  <td style={{ fontSize: 12, color: '#6B7280' }}>{formatAgo(d.last_checked)}</td>
                  <td onClick={e => e.stopPropagation()} className="no-hover">
                    <button
                      onClick={() => handleRemove(d.domain)}
                      title="Remove"
                      style={{ background: 'none', border: 'none', color: '#6B7280', cursor: 'pointer', padding: '4px 8px', borderRadius: 6, fontSize: 15, fontFamily: 'inherit' }}
                      onMouseEnter={e => { e.currentTarget.style.color = '#DC2626'; e.currentTarget.style.background = '#FEE2E2' }}
                      onMouseLeave={e => { e.currentTarget.style.color = '#6B7280'; e.currentTarget.style.background = 'none' }}
                    >✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {toast && <div className="o-toast">{toast}</div>}
      <DetailModal domain={detailDomain} onClose={() => setDetailDomain(null)} />
      {showCheckModal && <CheckDomainModal onClose={() => setShowCheckModal(false)} onSuccess={loadData} />}
    </div>
  )
}
