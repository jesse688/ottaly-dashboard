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
    <div className="bg-white rounded-lg border p-5">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-semibold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-sm text-gray-400 mt-0.5">{sub}</p>}
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
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Stats</h1>
          <p className="text-sm text-gray-500">{rows.length} workspaces</p>
        </div>
        <div className="flex gap-1">
          {(['30d', '90d'] as const).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 text-sm rounded border transition-colors ${period === p ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-6">
        {loading ? (
          <div className="grid grid-cols-3 gap-4 mb-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="bg-white rounded-lg border p-5">
                <div className="h-4 bg-gray-100 rounded animate-pulse mb-2 w-16" />
                <div className="h-8 bg-gray-100 rounded animate-pulse w-24" />
              </div>
            ))}
          </div>
        ) : t ? (
          <div className="grid grid-cols-3 gap-4 mb-6">
            <StatCard label="Sent (30d)" value={t.sent.toLocaleString()} />
            <StatCard label="Replies (30d)" value={t.replies.toLocaleString()} sub={replyRate} />
            <StatCard label="Leads (30d)" value={t.leads.toLocaleString()} />
          </div>
        ) : null}

        {rows.length > 0 && (
          <div className="bg-white rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Workspace</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Sent</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Replies</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Reply %</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Leads</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Mailboxes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const sent = period === '30d' ? row.sent_30d : row.sent_90d
                  const replies = period === '30d' ? row.replied_30d : row.replied_90d
                  const rr = period === '30d' ? row.reply_rate_30d : row.reply_rate_90d
                  const leads = period === '30d' ? row.leads_30d : row.leads_90d
                  return (
                    <tr key={row.workspace_id} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium">{row.workspace_name}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{sent?.toLocaleString() ?? '—'}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{replies?.toLocaleString() ?? '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={rr != null && rr >= 5 ? 'text-green-700 font-medium' : 'text-gray-600'}>
                          {rr != null ? `${rr.toFixed(1)}%` : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-blue-700 font-medium">{leads ?? '—'}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{row.mailbox_count ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !data && (
          <div className="text-center py-16 text-gray-500">Failed to load stats</div>
        )}
      </div>
    </div>
  )
}
