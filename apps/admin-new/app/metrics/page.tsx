'use client'

import { useEffect, useState } from 'react'

interface MetricRow { ws_id: string; date: string; data: Record<string, unknown> }

export default function MetricsPage() {
  const [rows, setRows] = useState<MetricRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/metrics').then(r => r.json()).then(d => setRows(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false))
  }, [])

  // Get all unique metric keys across all rows
  const allKeys = [...new Set(rows.flatMap(r => Object.keys(r.data ?? {})))].slice(0, 10)
  // Dedupe by ws_id keeping latest date
  const latest: Record<string, MetricRow> = {}
  for (const r of rows) { if (!latest[r.ws_id] || r.date > latest[r.ws_id].date) latest[r.ws_id] = r }
  const dedupedRows = Object.values(latest)

  function fmt(v: unknown) {
    if (v == null) return '—'
    if (typeof v === 'number') return v % 1 === 0 ? v.toLocaleString() : v.toFixed(2)
    return String(v)
  }

  return (
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Metrics</div>
          <div className="o-page-sub">{dedupedRows.length} workspaces · latest snapshot</div>
        </div>
      </div>
      <div className="o-card">
        <div className="o-table-wrap">
          <table className="o-table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Date</th>
                {allKeys.map(k => <th key={k} style={{ whiteSpace: 'nowrap', fontSize: '0.75rem' }}>{k.replace(/_/g, ' ')}</th>)}
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 2 + allKeys.length }).map((_, j) => (
                        <td key={j}><span className="o-spin" /></td>
                      ))}
                    </tr>
                  ))
                : dedupedRows.map(r => (
                    <tr key={r.ws_id}>
                      <td>{r.ws_id}</td>
                      <td style={{ color: '#6B7280' }}>{r.date}</td>
                      {allKeys.map(k => <td key={k}>{fmt((r.data ?? {})[k])}</td>)}
                    </tr>
                  ))
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
