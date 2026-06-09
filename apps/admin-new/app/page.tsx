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
    Promise.all([
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/health').then(r => r.json()),
    ])
      .then(([s, h]) => {
        setStats(s)
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
    <div
      className="min-h-screen"
      style={{ background: '#F0F2F8', color: '#050C29', fontFamily: 'Inter, sans-serif' }}
    >
      <div className="max-w-[1400px] mx-auto px-8 py-8">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Agency Dashboard</h1>
          <p className="text-sm text-[#6B7280] mt-0.5">
            Last 30 days · {loading ? '…' : `${health.length} workspaces`}
          </p>
        </div>

        {/* Summary stat cards */}
        <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          {[
            { label: 'Emails Sent', value: loading ? '—' : (totals?.sent ?? 0).toLocaleString(), accent: '#224388' },
            { label: 'Reply Rate', value: loading ? '—' : replyRate, accent: '#1F6F78' },
            { label: 'Leads Generated', value: loading ? '—' : (totals?.leads ?? 0).toLocaleString(), accent: '#059669' },
            { label: 'Active Clients', value: loading ? '—' : String(activeClients), accent: '#7C89CD' },
          ].map(card => (
            <div
              key={card.label}
              className="bg-white rounded-xl border border-[#E2E6F0] px-5 py-4"
              style={{ borderTop: `3px solid ${card.accent}` }}
            >
              <div className="text-xs font-bold uppercase tracking-wider text-[#6B7280]">{card.label}</div>
              <div className="text-3xl font-bold mt-1">{card.value}</div>
            </div>
          ))}
        </div>

        <div className="grid gap-5" style={{ gridTemplateColumns: '1fr 280px' }}>

          {/* Workspace table */}
          <div className="bg-white rounded-xl border border-[#E2E6F0] overflow-hidden">
            <div className="px-5 py-4 border-b border-[#E2E6F0] flex items-center justify-between">
              <div>
                <div className="font-bold text-[14px]">Workspaces</div>
                <div className="text-xs text-[#6B7280] mt-0.5">Sorted by sends (30 days)</div>
              </div>
              <Link href="/stats" className="text-[12px] text-[#1F6F78] font-semibold">Full stats →</Link>
            </div>
            <table className="w-full border-collapse">
              <thead style={{ background: '#F8F9FC' }}>
                <tr>
                  {['Workspace', 'Status', 'Sent', 'Reply Rate', 'Leads'].map(col => (
                    <th
                      key={col}
                      className="py-2 px-4 text-left text-[11px] font-bold uppercase tracking-wider text-[#6B7280] border-b border-[#E2E6F0]"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5} className="text-center py-10 text-[#6B7280] text-sm">Loading…</td>
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
                        ? '#059669'
                        : ws.reply_rate_30d >= 0.01
                        ? '#D97706'
                        : '#DC2626'
                    const statusCls =
                      ws.client_status === 'active'
                        ? 'bg-[#D1FAE5] text-[#065F46]'
                        : ws.client_status === 'paused'
                        ? 'bg-[#FEF3C7] text-[#92400E]'
                        : 'bg-[#F3F4F6] text-[#4B5563]'
                    return (
                      <tr key={ws.workspace_id} className="border-b border-[#F3F4F6] last:border-0">
                        <td className="py-2.5 px-4 text-[13px] font-medium">{ws.workspace_name}</td>
                        <td className="py-2.5 px-4">
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${statusCls}`}>
                            {ws.client_status ?? '—'}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-[13px]">{(ws.sent_30d ?? 0).toLocaleString()}</td>
                        <td className="py-2.5 px-4 text-[13px] font-bold" style={{ color: rrColor }}>{rr}</td>
                        <td className="py-2.5 px-4 text-[13px]">{ws.leads_30d ?? 0}</td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">

            {/* Health panel */}
            <div className="bg-white rounded-xl border border-[#E2E6F0] p-5">
              <div className="font-bold text-[14px] mb-4">Client Health</div>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {[
                  { label: 'Healthy', count: greenCount, color: '#059669', bg: '#D1FAE5' },
                  { label: 'Warning', count: yellowCount, color: '#D97706', bg: '#FEF3C7' },
                  { label: 'At Risk', count: redCount, color: '#DC2626', bg: '#FEE2E2' },
                ].map(b => (
                  <div
                    key={b.label}
                    className="rounded-lg text-center py-3"
                    style={{ background: b.bg }}
                  >
                    <div className="text-2xl font-bold" style={{ color: b.color }}>
                      {loading ? '—' : b.count}
                    </div>
                    <div className="text-[10px] font-bold uppercase tracking-wide mt-0.5" style={{ color: b.color }}>
                      {b.label}
                    </div>
                  </div>
                ))}
              </div>
              <Link href="/health" className="text-[12px] text-[#1F6F78] font-semibold">
                View health report →
              </Link>
            </div>

            {/* Quick links */}
            <div className="bg-white rounded-xl border border-[#E2E6F0] p-5">
              <div className="font-bold text-[14px] mb-3">Quick Links</div>
              {[
                { href: '/campaigns', label: 'Campaign Intelligence' },
                { href: '/finance', label: 'Finance' },
                { href: '/clients', label: 'Clients' },
                { href: '/diagnostics', label: 'Diagnostics' },
                { href: '/mailboxes', label: 'Mailboxes' },
                { href: '/domains', label: 'Domains' },
              ].map(link => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="flex items-center justify-between py-2 border-b border-[#F3F4F6] last:border-0 text-[13px] text-[#050C29] hover:text-[#1F6F78] transition-colors"
                >
                  {link.label}
                  <span className="text-[#9CA3AF] text-[11px]">→</span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
