'use client'

import { useEffect, useState } from 'react'

interface Signal {
  date: string
  signal_type: string
  metric_key: string
  avg_value: number
  max_value: number
  sample_count: number
}

interface ExternalFactor {
  date: string
  type: string
  description: string
  severity: string
}

interface MetricSnapshot {
  label: string
  value: string
  status: 'normal' | 'warning' | 'critical' | 'none'
}

export default function DiagnosticsPage() {
  const [days, setDays] = useState(7)
  const [allSignals, setAllSignals] = useState<Signal[]>([])
  const [externalFactors, setExternalFactors] = useState<ExternalFactor[]>([])
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [efDate, setEfDate] = useState(new Date().toISOString().slice(0, 10))
  const [efType, setEfType] = useState('')
  const [efDesc, setEfDesc] = useState('')
  const [efSeverity, setEfSeverity] = useState('medium')

  useEffect(() => {
    const fetch = async () => {
      setLoading(true)
      try {
        const [sigRes, efRes] = await Promise.all([
          fetchApi(`/api/diagnostics/signals?days=${days}`),
          fetchApi(`/api/diagnostics/external-factors?days=${days}`),
        ])
        setAllSignals(sigRes.signals || [])
        setExternalFactors(efRes.factors || [])
        if (!selectedDate) {
          const yesterday = new Date()
          yesterday.setDate(yesterday.getDate() - 1)
          setSelectedDate(yesterday.toISOString().slice(0, 10))
        }
      } catch (err) {
        console.error('Failed to fetch diagnostics:', err)
      } finally {
        setLoading(false)
      }
    }
    fetch()
  }, [days])

  const fetchApi = async (path: string) => {
    const res = await fetch(path)
    return res.json()
  }

  const handleLogFactor = async () => {
    if (!efDate || !efType || !efDesc) return
    try {
      await fetch('/api/diagnostics/external-factors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: efDate, type: efType, description: efDesc, severity: efSeverity }),
      })
      setEfType('')
      setEfDesc('')
      // Reload factors
      const res = await fetch(`/api/diagnostics/external-factors?days=${days}`)
      const data = await res.json()
      setExternalFactors(data.factors || [])
    } catch (err) {
      console.error('Failed to log factor:', err)
    }
  }

  // Get signal status for a date and type
  const getSignalStatus = (date: string, signalType: string): 'normal' | 'warning' | 'critical' | 'none' => {
    const signals = allSignals.filter(s => s.date === date && s.signal_type === signalType)
    if (!signals.length) return 'none'
    const statuses = signals.map(s => {
      const v = parseFloat(String(s.avg_value))
      if (signalType === 'reply_rate') return v < 5 ? 'critical' : v < 10 ? 'warning' : 'normal'
      if (signalType === 'bounce_rate') return v > 10 ? 'critical' : v > 5 ? 'warning' : 'normal'
      if (signalType === 'warmup') return v < 60 ? 'critical' : v < 80 ? 'warning' : 'normal'
      if (signalType === 'api_latency') return v > 1000 ? 'critical' : v > 500 ? 'warning' : 'normal'
      return 'normal'
    })
    if (statuses.includes('critical')) return 'critical'
    if (statuses.includes('warning')) return 'warning'
    return 'normal'
  }

  const getDates = () => {
    const dates = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      dates.push(d.toISOString().slice(0, 10))
    }
    return dates
  }

  const dates = getDates()
  const signalTypes = ['reply_rate', 'bounce_rate', 'warmup', 'api_latency']
  const signalLabels: Record<string, string> = {
    reply_rate: 'Reply Rate',
    bounce_rate: 'Bounce Rate',
    warmup: 'Warmup %',
    api_latency: 'API Latency',
  }

  const statusColors = {
    normal: { bg: '#D1FAE5', border: '#059669' },
    warning: { bg: '#FEF3C7', border: '#D97706' },
    critical: { bg: '#FEE2E2', border: '#DC2626' },
    none: { bg: '#F3F4F6', border: '#9CA3AF' },
  }

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '1.5rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 700 }}>Diagnostics</h1>
          <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>Root cause analysis · click any day to see what drove performance</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {[7, 14, 30].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #E2E6F0', background: days === d ? '#050C29' : '#fff', color: days === d ? '#fff' : '#050C29', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              {d} Days
            </button>
          ))}
        </div>
      </div>

      {/* 3-Column Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
        {/* LEFT: Timeline + External Factors */}
        <div>
          {/* Timeline */}
          <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #E2E6F0', padding: '1rem', marginBottom: '1rem' }}>
            <h3 style={{ fontSize: 12, fontWeight: 700, margin: '0 0 1rem 0' }}>Signal Timeline</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {signalTypes.map(st => (
                <div key={st} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, minWidth: 80 }}>{signalLabels[st]}</div>
                  <div style={{ display: 'flex', gap: '2px' }}>
                    {dates.map(d => {
                      const status = getSignalStatus(d, st)
                      const c = statusColors[status]
                      return (
                        <button
                          key={d}
                          onClick={() => setSelectedDate(d)}
                          title={d}
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: 3,
                            border: `1px solid ${c.border}`,
                            background: c.bg,
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            boxShadow: selectedDate === d ? `0 0 0 2px ${c.border}` : 'none',
                          }}
                        />
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* External Factors */}
          <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #E2E6F0', padding: '1rem' }}>
            <h3 style={{ fontSize: 12, fontWeight: 700, margin: '0 0 0.75rem 0' }}>External Factors</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: 12, marginBottom: '0.75rem' }}>
              <input
                type="date"
                value={efDate}
                onChange={e => setEfDate(e.target.value)}
                style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #E2E6F0', fontSize: 12, outline: 'none' }}
              />
              <select
                value={efType}
                onChange={e => setEfType(e.target.value)}
                style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #E2E6F0', fontSize: 12, outline: 'none' }}
              >
                <option value="">Factor type…</option>
                <option value="strike">Strike / Industrial action</option>
                <option value="outage">ISP / Email provider outage</option>
                <option value="filter">Gmail / Outlook filter change</option>
                <option value="ratelimit">Rate limit change</option>
                <option value="maintenance">Scheduled maintenance</option>
                <option value="other">Other</option>
              </select>
              <input
                type="text"
                value={efDesc}
                onChange={e => setEfDesc(e.target.value)}
                placeholder="Short description"
                style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #E2E6F0', fontSize: 12, outline: 'none' }}
              />
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <select
                  value={efSeverity}
                  onChange={e => setEfSeverity(e.target.value)}
                  style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #E2E6F0', fontSize: 12, outline: 'none' }}
                >
                  <option value="low">Low impact</option>
                  <option value="medium">Medium impact</option>
                  <option value="high">High impact</option>
                </select>
                <button
                  onClick={handleLogFactor}
                  style={{ padding: '6px 12px', borderRadius: 6, background: '#050C29', color: '#fff', border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                >
                  Log
                </button>
              </div>
            </div>
            {externalFactors.map(ef => (
              <div key={`${ef.date}${ef.type}`} style={{ fontSize: 11, padding: '0.5rem', background: '#FFF7ED', border: '1px solid #FDE68A', borderRadius: 6, marginTop: '0.25rem' }}>
                <strong style={{ color: '#92400E' }}>{ef.date}</strong>: {ef.description}
              </div>
            ))}
          </div>
        </div>

        {/* CENTER: Metrics snapshot + Signals table */}
        <div>
          {selectedDate && (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#050C29', marginBottom: '1rem' }}>
                {new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              </div>
              <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #E2E6F0', padding: '1rem', marginBottom: '1rem' }}>
                <h3 style={{ fontSize: 12, fontWeight: 700, margin: '0 0 0.75rem 0' }}>Metrics Snapshot</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', fontSize: 12 }}>
                  {signalTypes.map(st => {
                    const signals = allSignals.filter(s => s.date === selectedDate && s.signal_type === st)
                    const value = signals.length ? signals[0].avg_value : null
                    return (
                      <div key={st} style={{ padding: '0.75rem', background: '#F9FAFB', borderRadius: 6 }}>
                        <div style={{ fontSize: 11, color: '#6B7280', fontWeight: 600 }}>{signalLabels[st]}</div>
                        <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, color: '#050C29' }}>
                          {value != null ? typeof value === 'number' ? value.toFixed(1) : value : '—'}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}

          {/* Signals table */}
          <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #E2E6F0', padding: '1rem' }}>
            <h3 style={{ fontSize: 12, fontWeight: 700, margin: '0 0 0.75rem 0' }}>All Signals — Selected Day</h3>
            {!selectedDate ? (
              <div style={{ color: '#6B7280', fontSize: 12 }}>← Click a day on the timeline to see signals</div>
            ) : (
              <div style={{ fontSize: 11 }}>
                {allSignals
                  .filter(s => s.date === selectedDate)
                  .map((s, i) => (
                    <div key={i} style={{ padding: '0.5rem 0', borderBottom: i < allSignals.filter(x => x.date === selectedDate).length - 1 ? '1px solid #F3F4F6' : 'none' }}>
                      <div style={{ fontWeight: 600, color: '#050C29' }}>{signalLabels[s.signal_type] || s.signal_type}</div>
                      <div style={{ color: '#6B7280', fontSize: 10, marginTop: 2 }}>
                        {s.metric_key}: {s.avg_value.toFixed(1)} (max: {s.max_value.toFixed(1)})
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: RCA + Legend */}
        <div>
          {/* Root Cause */}
          <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #E2E6F0', padding: '1rem', marginBottom: '1rem' }}>
            <h3 style={{ fontSize: 12, fontWeight: 700, margin: '0 0 0.75rem 0' }}>Root Cause Analysis</h3>
            {!selectedDate ? (
              <div style={{ color: '#6B7280', fontSize: 12 }}>Select a day to run diagnosis</div>
            ) : (
              <div style={{ fontSize: 11, color: '#050C29', lineHeight: 1.6 }}>
                Based on signals for {selectedDate}:
                <ul style={{ marginTop: '0.5rem', paddingLeft: '1.25rem', color: '#6B7280' }}>
                  <li>Monitor key metrics for anomalies</li>
                  <li>Check external factors log for events</li>
                  <li>Review API latency trends</li>
                  <li>Verify supplier performance stats</li>
                </ul>
              </div>
            )}
          </div>

          {/* Legend */}
          <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #E2E6F0', padding: '1rem' }}>
            <h3 style={{ fontSize: 12, fontWeight: 700, margin: '0 0 0.75rem 0' }}>Signal Guide</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: 11 }}>
              {(['normal', 'warning', 'critical', 'none'] as const).map(s => {
                const labels = { normal: 'Normal', warning: 'Warning', critical: 'Critical', none: 'No data' }
                const c = statusColors[s]
                return (
                  <div key={s} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div style={{ width: 12, height: 12, borderRadius: 2, background: c.bg, border: `1px solid ${c.border}` }} />
                    <strong>{labels[s]}</strong> — {s === 'normal' ? 'within healthy range' : s === 'warning' ? 'slightly degraded' : s === 'critical' ? 'likely causing issues' : 'signal not collected'}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
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
