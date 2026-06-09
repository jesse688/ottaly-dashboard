'use client'

import { useEffect, useState } from 'react'

interface HealthRow {
  workspace_id: string
  workspace_name: string | null
  health_score: number
  health_band: string
  sent_7d: number
  sent_30d: number
  replies_30d: number
  leads_30d: number
  reply_rate_30d: number | null
  bounce_rate_7d: number | null
  mailbox_total: number
  mailbox_unhealthy: number
  snapshot_date: string
}

const BAND_COLORS: Record<string, string> = {
  green: 'bg-green-100 text-green-800',
  yellow: 'bg-yellow-100 text-yellow-700',
  red: 'bg-red-100 text-red-700',
}

function pct(n: number | null) {
  if (n == null) return '—'
  return (Number(n) * 100).toFixed(1) + '%'
}

export default function HealthPage() {
  const [rows, setRows] = useState<HealthRow[]>([])
  const [filtered, setFiltered] = useState<HealthRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(d => setRows(Array.isArray(d) ? d : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!search) { setFiltered(rows); return }
    const q = search.toLowerCase()
    setFiltered(rows.filter(r => (r.workspace_name ?? '').toLowerCase().includes(q)))
  }, [rows, search])

  const redCount = filtered.filter(r => r.health_band === 'red').length
  const avgScore = filtered.length
    ? Math.round(filtered.reduce((s, r) => s + r.health_score, 0) / filtered.length)
    : 0

  return (
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Health</div>
          <div className="o-page-sub">
            {filtered.length} workspaces · avg score {avgScore}
            {redCount > 0 && <span style={{ marginLeft: 8, color: '#DC2626', fontWeight: 500 }}>· {redCount} critical</span>}
          </div>
        </div>
      </div>

      <div className="o-toolbar">
        <div className="o-search-wrap">
          <span className="o-search-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <input
            type="text"
            placeholder="Search workspace..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="o-table-wrap">
        <table className="o-table">
          <thead>
            <tr>
              <th>Workspace</th>
              <th style={{ textAlign: 'center' }}>Score</th>
              <th>Sent 30d</th>
              <th>Replies 30d</th>
              <th>Reply % 30d</th>
              <th>Leads 30d</th>
              <th>Bounce % 7d</th>
              <th>Mailboxes</th>
              <th>Unhealthy</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 9 }).map((_, j) => (
                    <td key={j}><span className="o-spin" /></td>
                  ))}
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={9}><div className="o-empty">No data found</div></td>
              </tr>
            ) : (
              filtered.map(r => (
                <tr key={r.workspace_id} style={r.health_band === 'red' ? { background: '#FEF2F2' } : undefined}>
                  <td style={{ fontWeight: 500 }}>{r.workspace_name ?? r.workspace_id}</td>
                  <td style={{ textAlign: 'center' }}>
                    {r.health_band === 'green' && (
                      <span className="o-status o-status-good">{r.health_score}</span>
                    )}
                    {r.health_band === 'yellow' && (
                      <span className="o-status o-status-warning">{r.health_score}</span>
                    )}
                    {r.health_band === 'red' && (
                      <span className="o-status o-status-critical">{r.health_score}</span>
                    )}
                    {r.health_band !== 'green' && r.health_band !== 'yellow' && r.health_band !== 'red' && (
                      <span className="o-status o-status-unknown">{r.health_score}</span>
                    )}
                  </td>
                  <td>{r.sent_30d?.toLocaleString() ?? '—'}</td>
                  <td>{r.replies_30d?.toLocaleString() ?? '—'}</td>
                  <td>
                    <span style={r.reply_rate_30d != null && Number(r.reply_rate_30d) >= 0.05 ? { color: '#16A34A', fontWeight: 500 } : undefined}>
                      {pct(r.reply_rate_30d)}
                    </span>
                  </td>
                  <td style={{ color: '#224388', fontWeight: 500 }}>{r.leads_30d ?? '—'}</td>
                  <td>
                    <span style={r.bounce_rate_7d != null && Number(r.bounce_rate_7d) >= 0.03 ? { color: '#DC2626' } : undefined}>
                      {pct(r.bounce_rate_7d)}
                    </span>
                  </td>
                  <td>{r.mailbox_total ?? '—'}</td>
                  <td>
                    <span style={r.mailbox_unhealthy > 0 ? { color: '#DC2626', fontWeight: 500 } : { color: '#6B7280' }}>
                      {r.mailbox_unhealthy}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
