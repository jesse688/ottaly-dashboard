'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

interface StatRow {
  workspace_id: string
  workspace_name: string
  sent: number
  opens: number
  replies: number
  bounces: number
  open_rate: number
  reply_rate: number
  bounce_rate: number
}

interface StatsData {
  rows: StatRow[]
  totals: {
    sent: number
    opens: number
    replies: number
    bounces: number
  }
  period: string
  partial?: boolean
}

const PERIODS = [
  { label: '7d', days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
]

function pct(n: number, d: number) {
  if (!d) return '—'
  return (n / d * 100).toFixed(1) + '%'
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
  const [days, setDays] = useState(30)

  useEffect(() => {
    setLoading(true)
    const end = new Date().toISOString().split('T')[0]
    const start = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]
    fetch(`/api/stats?start=${start}&end=${end}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [days])

  const t = data?.totals

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Stats</h1>
          {data?.partial && <p className="text-xs text-yellow-600">Partial data — still loading</p>}
        </div>
        <div className="flex gap-1">
          {PERIODS.map(p => (
            <Button
              key={p.days}
              variant={days === p.days ? 'default' : 'outline'}
              size="sm"
              onClick={() => setDays(p.days)}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-6">
        {loading ? (
          <div className="grid grid-cols-4 gap-4 mb-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-white rounded-lg border p-5">
                <div className="h-4 bg-gray-100 rounded animate-pulse mb-2 w-16" />
                <div className="h-8 bg-gray-100 rounded animate-pulse w-24" />
              </div>
            ))}
          </div>
        ) : t ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <StatCard label="Sent" value={t.sent.toLocaleString()} />
            <StatCard label="Opens" value={t.opens.toLocaleString()} sub={pct(t.opens, t.sent)} />
            <StatCard label="Replies" value={t.replies.toLocaleString()} sub={pct(t.replies, t.sent)} />
            <StatCard label="Bounces" value={t.bounces.toLocaleString()} sub={pct(t.bounces, t.sent)} />
          </div>
        ) : null}

        {data?.rows && data.rows.length > 0 && (
          <div className="bg-white rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Workspace</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Sent</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Open %</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Reply %</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Bounce %</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(row => (
                  <tr key={row.workspace_id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{row.workspace_name}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{row.sent.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{pct(row.opens, row.sent)}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={row.reply_rate >= 0.05 ? 'text-green-700 font-medium' : 'text-gray-600'}>
                        {pct(row.replies, row.sent)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={row.bounce_rate >= 0.03 ? 'text-red-600' : 'text-gray-600'}>
                        {pct(row.bounces, row.sent)}
                      </span>
                    </td>
                  </tr>
                ))}
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
