'use client'

import { useEffect, useState } from 'react'

interface LogEntry { id: number; workspace_id: string; date: string; tier: string; reply_rate: number; send_volume: number; narrative: string; recommendations: string }
interface Pattern { id: number; pattern_type: string; pattern_value: string; workspace_id: string; avg_reply_rate: number; avg_bounce_rate: number; sample_size: number; correlation_strength: number }

const TIER_COLORS: Record<string, string> = {
  excellent: 'o-status o-status-good',
  good: 'o-status o-status-active',
  average: 'o-status o-status-warning',
  poor: 'o-status o-status-critical',
}

export default function IntelligencePage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [patterns, setPatterns] = useState<Pattern[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'logs' | 'patterns'>('logs')

  useEffect(() => {
    fetch('/api/intelligence').then(r => r.json()).then(d => { setLogs(d.logs ?? []); setPatterns(d.patterns ?? []) }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  return (
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Intelligence</div>
          <div className="o-page-sub">{logs.length} log entries · {patterns.length} patterns</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {(['logs', 'patterns'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={'o-pill' + (tab === t ? ' o-pill-active' : '')} style={{ textTransform: 'capitalize' }}>{t}</button>
        ))}
      </div>

      <div className="o-card">
        <div className="o-card-body" style={{ padding: 0 }}>
          {tab === 'logs' ? (
            <div className="o-table-wrap">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Workspace</th>
                    <th>Tier</th>
                    <th>Reply %</th>
                    <th>Sends</th>
                    <th>Narrative</th>
                  </tr>
                </thead>
                <tbody>
                  {loading
                    ? Array.from({ length: 5 }).map((_, i) => (
                        <tr key={i}>
                          {Array.from({ length: 6 }).map((_, j) => (
                            <td key={j}><span className="o-spin" /></td>
                          ))}
                        </tr>
                      ))
                    : logs.map(l => (
                        <tr key={l.id}>
                          <td style={{ color: '#6B7280' }}>{l.date}</td>
                          <td>{l.workspace_id}</td>
                          <td><span className={TIER_COLORS[l.tier] ?? 'o-status o-status-unknown'}>{l.tier}</span></td>
                          <td>{l.reply_rate != null ? `${(Number(l.reply_rate) * 100).toFixed(1)}%` : '—'}</td>
                          <td>{l.send_volume?.toLocaleString() ?? '—'}</td>
                          <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#6B7280' }}>{l.narrative ?? '—'}</td>
                        </tr>
                      ))
                  }
                </tbody>
              </table>
            </div>
          ) : (
            <div className="o-table-wrap">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Pattern</th>
                    <th>Value</th>
                    <th>Avg Reply %</th>
                    <th>Avg Bounce %</th>
                    <th>Samples</th>
                    <th>Correlation</th>
                  </tr>
                </thead>
                <tbody>
                  {patterns.map(p => (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 500 }}>{p.pattern_type}</td>
                      <td>{p.pattern_value}</td>
                      <td>{p.avg_reply_rate != null ? `${(Number(p.avg_reply_rate) * 100).toFixed(1)}%` : '—'}</td>
                      <td>{p.avg_bounce_rate != null ? `${(Number(p.avg_bounce_rate) * 100).toFixed(1)}%` : '—'}</td>
                      <td>{p.sample_size}</td>
                      <td style={{ fontWeight: 500 }}>{p.correlation_strength?.toFixed(2) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
