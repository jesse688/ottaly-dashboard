'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface WorkspaceRow {
  workspace_id: string
  workspace_name: string
  client_status: string | null
  sent_30d: number | null
  replied_30d: number | null
  reply_rate_30d: number | null
  leads_30d: number | null
}

interface StatsData {
  rows: WorkspaceRow[]
  totals: { sent: number; replies: number; leads: number }
}

interface HealthRow {
  workspace_id: string
  workspace_name: string | null
  health_score: number
  health_band: string
  reply_rate_30d: number | null
  sent_30d: number
  leads_30d: number
  mailbox_total: number
  mailbox_unhealthy: number
}

export default function Home() {
  const [stats, setStats] = useState<StatsData | null>(null)
  const [health, setHealth] = useState<HealthRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const end = new Date().toISOString().slice(0, 10)
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    Promise.all([
      fetch(`/api/stats/summary?start=${start}&end=${end}`).then(r => r.json()).then(d => ({ rows: d.workspaces || [], totals: { sent: 0, replies: 0, leads: 0 } })),
      fetch('/api/health').then(r => r.json()),
    ])
      .then(([s, h]) => {
        // Calculate totals from workspaces
        const totals = s.rows.reduce((acc: any, w: any) => ({
          sent: acc.sent + (w.totals?.sent || 0),
          replies: acc.replies + (w.totals?.replies || 0),
          leads: acc.leads + (w.totals?.leads || 0),
        }), { sent: 0, replies: 0, leads: 0 })

        setStats({
          rows: s.rows.map((w: any) => ({
            workspace_id: w.workspace_id,
            workspace_name: w.name,
            client_status: 'active',
            sent_30d: w.totals?.sent || 0,
            replied_30d: w.totals?.replies || 0,
            reply_rate_30d: w.totals?.sent > 0 ? w.totals.replies / w.totals.sent : 0,
            leads_30d: w.totals?.leads || 0,
          })),
          totals,
        })
        setHealth(Array.isArray(h) ? h : [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const totals = stats?.totals
  const replyRate =
    totals && totals.sent > 0
      ? ((totals.replies / totals.sent) * 100).toFixed(2) + '%'
      : '—'
  const activeClients = stats?.rows.filter(r => r.client_status === 'active').length ?? 0
  const greenCount = health.filter(h => h.health_band === 'green').length
  const yellowCount = health.filter(h => h.health_band === 'yellow').length
  const redCount = health.filter(h => h.health_band === 'red').length

  return (
    <div className="o-page">

      {/* Header */}
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Agency Dashboard</div>
          <div className="o-page-sub">
            Last 30 days · {loading ? '…' : `${health.length} workspaces`}
          </div>
        </div>
      </div>

      {/* Summary stat cards */}
      <div className="o-metrics o-metrics-4" style={{ marginBottom: '1.5rem' }}>
        <div className="o-metric" style={{ borderTopColor: '#224388' }}>
          <div className="o-metric-label">Emails Sent</div>
          <div className="o-metric-val" style={{ color: '#224388' }}>
            {loading ? '—' : (totals?.sent ?? 0).toLocaleString()}
          </div>
        </div>
        <div className="o-metric" style={{ borderTopColor: '#1F6F78' }}>
          <div className="o-metric-label">Reply Rate</div>
          <div className="o-metric-val" style={{ color: '#1F6F78' }}>
            {loading ? '—' : replyRate}
          </div>
        </div>
        <div className="o-metric" style={{ borderTopColor: '#16A34A' }}>
          <div className="o-metric-label">Leads Generated</div>
          <div className="o-metric-val" style={{ color: '#16A34A' }}>
            {loading ? '—' : (totals?.leads ?? 0).toLocaleString()}
          </div>
        </div>
        <div className="o-metric" style={{ borderTopColor: '#7C89CD' }}>
          <div className="o-metric-label">Active Clients</div>
          <div className="o-metric-val" style={{ color: '#7C89CD' }}>
            {loading ? '—' : String(activeClients)}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: '1.25rem' }}>

        {/* Workspace table */}
        <div className="o-card">
          <div className="o-card-header">
            <div>
              <div className="o-card-title">Workspaces</div>
              <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>Sorted by sends (30 days)</div>
            </div>
            <Link href="/stats" style={{ fontSize: 12, color: '#1F6F78', fontWeight: 600, textDecoration: 'none' }}>Full stats →</Link>
          </div>
          <div className="o-card-body" style={{ padding: 0 }}>
            <div className="o-table-wrap">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Workspace</th>
                    <th>Status</th>
                    <th>Sent</th>
                    <th>Reply Rate</th>
                    <th>Leads</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
                        <span className="o-spin" />
                      </td>
                    </tr>
                  ) : (
                    (stats?.rows ?? []).map(ws => {
                      const rr =
                        ws.reply_rate_30d != null
                          ? (Number(ws.reply_rate_30d) * 100).toFixed(2) + '%'
                          : '—'
                      const rrColor =
                        ws.reply_rate_30d == null
                          ? '#6B7280'
                          : ws.reply_rate_30d >= 0.025
                          ? '#16A34A'
                          : ws.reply_rate_30d >= 0.01
                          ? '#D97706'
                          : '#DC2626'
                      const statusCls =
                        ws.client_status === 'active'
                          ? 'o-status o-status-active'
                          : ws.client_status === 'paused'
                          ? 'o-status o-status-warning'
                          : 'o-status o-status-unknown'
                      return (
                        <tr key={ws.workspace_id}>
                          <td style={{ fontWeight: 500 }}>{ws.workspace_name}</td>
                          <td>
                            <span className={statusCls}>
                              {ws.client_status ?? '—'}
                            </span>
                          </td>
                          <td>{(ws.sent_30d ?? 0).toLocaleString()}</td>
                          <td style={{ fontWeight: 700, color: rrColor }}>{rr}</td>
                          <td>{ws.leads_30d ?? 0}</td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

          {/* Health panel */}
          <div className="o-card">
            <div className="o-card-header">
              <div className="o-card-title">Client Health</div>
            </div>
            <div className="o-card-body">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
                {[
                  { label: 'Healthy', count: greenCount, color: '#16A34A', bg: '#D1FAE5' },
                  { label: 'Warning', count: yellowCount, color: '#D97706', bg: '#FEF3C7' },
                  { label: 'At Risk', count: redCount, color: '#DC2626', bg: '#FEE2E2' },
                ].map(b => (
                  <div
                    key={b.label}
                    style={{ background: b.bg, borderRadius: 8, textAlign: 'center', padding: '12px 4px' }}
                  >
                    <div style={{ fontSize: 24, fontWeight: 700, color: b.color }}>
                      {loading ? '—' : b.count}
                    </div>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2, color: b.color }}>
                      {b.label}
                    </div>
                  </div>
                ))}
              </div>
              <Link href="/health" style={{ fontSize: 12, color: '#1F6F78', fontWeight: 600, textDecoration: 'none' }}>
                View health report →
              </Link>
            </div>
          </div>

          {/* Quick links */}
          <div className="o-card">
            <div className="o-card-header">
              <div className="o-card-title">Quick Links</div>
            </div>
            <div className="o-card-body" style={{ padding: 0 }}>
              {[
                { href: '/campaigns', label: 'Campaign Intelligence' },
                { href: '/finance', label: 'Finance' },
                { href: '/clients', label: 'Clients' },
                { href: '/diagnostics', label: 'Diagnostics' },
                { href: '/mailboxes', label: 'Mailboxes' },
                { href: '/domains', label: 'Domains' },
              ].map((link, i, arr) => (
                <Link
                  key={link.href}
                  href={link.href}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 20px',
                    borderBottom: i < arr.length - 1 ? '1px solid #F3F4F6' : 'none',
                    fontSize: 13,
                    color: '#050C29',
                    textDecoration: 'none',
                  }}
                >
                  {link.label}
                  <span style={{ color: '#9CA3AF', fontSize: 11 }}>→</span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
