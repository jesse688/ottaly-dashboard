'use client'

import { useEffect, useMemo, useState } from 'react'

interface ComboRow { workspace_id: string; date: string; from_type: string; to_type: string; sent: number; replies: number; pos_replies: number; bounces: number; leads: number; reply_rate: number; bounce_rate: number }

function pct(v: number) { return v != null ? `${(Number(v)*100).toFixed(1)}%` : '—' }

export default function ComboAnalysisPage() {
  const [rows, setRows] = useState<ComboRow[]>([])
  const [loading, setLoading] = useState(true)
  const [workspace, setWorkspace] = useState('all')

  useEffect(() => {
    fetch('/api/combo-analysis').then(r => r.json()).then(d => setRows(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const workspaces = [...new Set(rows.map(r => r.workspace_id))].sort()

  const filtered = useMemo(
    () => workspace === 'all' ? rows : rows.filter(r => r.workspace_id === workspace),
    [rows, workspace]
  )

  // Aggregate by from_type × to_type
  const matrix: Record<string, ComboRow & { count: number }> = {}
  for (const r of filtered) {
    const key = `${r.from_type}→${r.to_type}`
    if (!matrix[key]) matrix[key] = { ...r, count: 0 }
    matrix[key].sent += r.sent; matrix[key].replies += r.replies
    matrix[key].bounces += r.bounces; matrix[key].leads += r.leads
    matrix[key].count++
  }
  const aggregated = Object.entries(matrix).map(([k, v]) => ({
    ...v, key: k,
    reply_rate: v.sent > 0 ? v.replies / v.sent : 0,
    bounce_rate: v.sent > 0 ? v.bounces / v.sent : 0,
  })).sort((a, b) => b.sent - a.sent)

  return (
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Combo Analysis</div>
          <div className="o-page-sub">Sender × recipient provider performance</div>
        </div>
      </div>
      <div className="o-toolbar">
        <select className="o-select" value={workspace} onChange={e => setWorkspace(e.target.value)}>
          <option value="all">All workspaces</option>
          {workspaces.map(w => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>
      <div className="o-table-wrap">
        <table className="o-table">
          <thead>
            <tr>
              <th>From → To</th>
              <th>Sent</th>
              <th>Replies</th>
              <th>Reply %</th>
              <th>Bounce %</th>
              <th>Leads</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({length: 6}).map((_, i) => (
                  <tr key={i}>
                    {Array.from({length: 6}).map((_, j) => (
                      <td key={j}><span className="o-spin" /></td>
                    ))}
                  </tr>
                ))
              : aggregated.map(r => (
                  <tr key={r.key}>
                    <td><code className="o-raw">{r.key}</code></td>
                    <td>{r.sent.toLocaleString()}</td>
                    <td>{r.replies.toLocaleString()}</td>
                    <td><span style={{ color: r.reply_rate >= 0.05 ? '#16A34A' : undefined, fontWeight: r.reply_rate >= 0.05 ? 600 : undefined }}>{pct(r.reply_rate)}</span></td>
                    <td><span style={{ color: r.bounce_rate >= 0.03 ? '#DC2626' : undefined }}>{pct(r.bounce_rate)}</span></td>
                    <td style={{ color: '#224388', fontWeight: 600 }}>{r.leads}</td>
                  </tr>
                ))
            }
          </tbody>
        </table>
      </div>
    </div>
  )
}
