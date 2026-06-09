'use client'

import { useEffect, useState } from 'react'

interface WorkspaceRow {
  workspace_id: string
  workspace_name: string
  client_status: string | null
  sent_30d: number | null
  replied_30d: number | null
  reply_rate_30d: number | null
  leads_30d: number | null
  sent_90d: number | null
  replied_90d: number | null
  reply_rate_90d: number | null
  leads_90d: number | null
  mailbox_count: number | null
  contacts_total: number | null
}

interface StatsData {
  rows: WorkspaceRow[]
  totals: { sent: number; replies: number; leads: number; replyRate: number }
  period: string
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="o-metric">
      <div className="o-metric-label">{label}</div>
      <div className="o-metric-val">{value}</div>
      {sub && <div className="o-metric-sub">{sub}</div>}
    </div>
  )
}

export default function StatsPage() {
  const [data, setData] = useState<StatsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<'30d' | '90d'>('30d')

  useEffect(() => {
    setLoading(true)
    fetch('/api/stats')
      .then(r => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  const t = data?.totals
  const rows = data?.rows ?? []

  const replyRate = t?.replyRate != null ? (t.replyRate * 100).toFixed(1) + '%' : '—'

  return (
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Stats</div>
          <div className="o-page-sub">{rows.length} workspaces</div>
        </div>
        <div className="o-page-actions">
          <div style={{ display: 'flex', gap: 6 }}>
            {(['30d', '90d'] as const).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={'o-pill' + (period === p ? ' o-pill-active' : '')}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="o-metrics o-metrics-3" style={{ marginBottom: '1.5rem' }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="o-metric">
              <div className="o-metric-label"><span className="o-spin" /></div>
              <div className="o-metric-val">—</div>
            </div>
          ))}
        </div>
      ) : t ? (
        <div className="o-metrics o-metrics-3" style={{ marginBottom: '1.5rem' }}>
          <StatCard label="Sent (30d)" value={t.sent.toLocaleString()} />
          <StatCard label="Replies (30d)" value={t.replies.toLocaleString()} sub={replyRate} />
          <StatCard label="Leads (30d)" value={t.leads.toLocaleString()} />
        </div>
      ) : null}

      {rows.length > 0 && (
        <div className="o-card">
          <div className="o-card-body" style={{ padding: 0 }}>
            <div className="o-table-wrap">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Workspace</th>
                    <th style={{ textAlign: 'right' }}>Sent</th>
                    <th style={{ textAlign: 'right' }}>Replies</th>
                    <th style={{ textAlign: 'right' }}>Reply %</th>
                    <th style={{ textAlign: 'right' }}>Leads</th>
                    <th style={{ textAlign: 'right' }}>Mailboxes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => {
                    const sent = period === '30d' ? row.sent_30d : row.sent_90d
                    const replies = period === '30d' ? row.replied_30d : row.replied_90d
                    const rrRaw = period === '30d' ? row.reply_rate_30d : row.reply_rate_90d
                    const rr = rrRaw != null ? Number(rrRaw) : null
                    const leads = period === '30d' ? row.leads_30d : row.leads_90d
                    return (
                      <tr key={row.workspace_id}>
                        <td style={{ fontWeight: 500 }}>{row.workspace_name}</td>
                        <td style={{ textAlign: 'right' }}>{sent?.toLocaleString() ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{replies?.toLocaleString() ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          <span style={rr != null && rr >= 5 ? { color: '#16A34A', fontWeight: 500 } : { color: '#6B7280' }}>
                            {rr != null ? `${rr.toFixed(1)}%` : '—'}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right', color: '#224388', fontWeight: 500 }}>{leads ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{row.mailbox_count ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {!loading && !data && (
        <div className="o-empty">Failed to load stats</div>
      )}
    </div>
  )
}
