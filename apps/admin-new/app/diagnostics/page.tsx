'use client'

import { useEffect, useState } from 'react'

interface Signal { id: number; timestamp: string; signal_type: string; workspace_id: string; metric_key: string; metric_value: number; unit: string; status: string; notes: string }

const STATUS_MAP: Record<string, string> = {
  normal: 'o-status o-status-good',
  warning: 'o-status o-status-warning',
  critical: 'o-status o-status-critical',
}

export default function DiagnosticsPage() {
  const [signals, setSignals] = useState<Signal[]>([])
  const [filtered, setFiltered] = useState<Signal[]>([])
  const [loading, setLoading] = useState(true)
  const [hours, setHours] = useState('24')
  const [status, setStatus] = useState('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    setLoading(true)
    fetch(`/api/diagnostics?hours=${hours}`).then(r => r.json()).then(d => setSignals(d.signals ?? [])).catch(() => {}).finally(() => setLoading(false))
  }, [hours])

  useEffect(() => {
    let r = [...signals]
    if (status !== 'all') r = r.filter(s => s.status === status)
    if (search) { const q = search.toLowerCase(); r = r.filter(s => s.metric_key?.toLowerCase().includes(q) || s.signal_type?.toLowerCase().includes(q)) }
    setFiltered(r)
  }, [signals, status, search])

  const criticalCount = signals.filter(s => s.status === 'critical').length

  return (
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Diagnostics</div>
          <div className="o-page-sub">
            {filtered.length.toLocaleString()} signals
            {criticalCount > 0 && <span style={{ marginLeft: 8, color: '#DC2626', fontWeight: 500 }}>· {criticalCount} critical</span>}
          </div>
        </div>
      </div>

      <div className="o-toolbar">
        <div className="o-search-wrap">
          <span className="o-search-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </span>
          <input type="text" placeholder="Search metric, type..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="o-select" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="normal">Normal</option>
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
        </select>
        <select className="o-select" value={hours} onChange={e => setHours(e.target.value)}>
          <option value="1">1 hour</option>
          <option value="6">6 hours</option>
          <option value="24">24 hours</option>
          <option value="72">3 days</option>
        </select>
      </div>

      <div className="o-card">
        <div className="o-card-body">
          <div className="o-table-wrap">
            <table className="o-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Metric</th>
                  <th>Value</th>
                  <th>Status</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i}>
                        {Array.from({ length: 6 }).map((_, j) => (
                          <td key={j}><div style={{ height: 16, background: '#E2E6F0', borderRadius: 4 }} /></td>
                        ))}
                      </tr>
                    ))
                  : filtered.length === 0
                  ? <tr><td colSpan={6}><div className="o-empty">No signals found</div></td></tr>
                  : filtered.slice(0, 200).map(s => (
                      <tr key={s.id} style={s.status === 'critical' ? { background: '#FEF2F2' } : undefined}>
                        <td style={{ color: '#6B7280', fontSize: 12, whiteSpace: 'nowrap' }}>{new Date(s.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</td>
                        <td style={{ color: '#6B7280', fontSize: 12 }}>{s.signal_type}</td>
                        <td><code className="o-raw">{s.metric_key}</code></td>
                        <td style={{ fontSize: 14, fontWeight: 500 }}>{s.metric_value} <span style={{ color: '#6B7280', fontSize: 12 }}>{s.unit}</span></td>
                        <td><span className={STATUS_MAP[s.status] ?? 'o-status o-status-unknown'}>{s.status}</span></td>
                        <td style={{ fontSize: 12, color: '#6B7280', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.notes ?? '—'}</td>
                      </tr>
                    ))
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
