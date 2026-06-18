'use client'

import { useEffect, useState } from 'react'
import { fmt, pct } from '@/lib/utils'

interface Stats {
  sent: number
  replied: number
  replyRate: number
  leads: number
  meetings: number
  bounced: number
  bounceRate: number
  totalCampaigns: number
  activeCampaigns: number
}

export function DashboardClient() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/portal/stats')
      .then(r => r.json())
      .then((d: Stats | { error: string }) => {
        if ('error' in d) setError(d.error)
        else setStats(d)
      })
      .catch(() => setError('Failed to load stats'))
  }, [])

  if (error) return <div className="p-6 text-red-600 text-sm">{error}</div>

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Overview</h1>
        <p className="text-sm text-gray-500 mt-0.5">Last 30 days</p>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 mb-8">
        <StatCard label="Emails Sent"     value={stats ? fmt(stats.sent)      : null} />
        <StatCard label="Replies"         value={stats ? fmt(stats.replied)   : null} />
        <StatCard label="Reply Rate"      value={stats ? pct(stats.replyRate) : null}
                  highlight={stats ? (stats.replyRate >= 0.03 ? 'good' : stats.replyRate < 0.02 ? 'bad' : 'neutral') : undefined} />
        <StatCard label="Leads"           value={stats ? fmt(stats.leads)     : null} accent />
        <StatCard label="Meetings Booked" value={stats ? fmt(stats.meetings)  : null} accent />
        <StatCard label="Bounce Rate"     value={stats ? pct(stats.bounceRate): null}
                  highlight={stats ? (stats.bounceRate <= 0.03 ? 'good' : stats.bounceRate > 0.05 ? 'bad' : 'neutral') : undefined} />
        <StatCard label="Active Campaigns" value={stats ? `${stats.activeCampaigns} / ${stats.totalCampaigns}` : null} />
      </div>

      {/* Context note */}
      {stats && (
        <div className="bg-white rounded-xl border border-gray-100 p-4 text-sm text-gray-600">
          <p className="font-medium text-gray-800 mb-1">How to read this</p>
          <ul className="space-y-1 list-disc list-inside text-gray-500">
            <li>Reply rate above <strong className="text-green-600">3%</strong> is healthy — below <strong className="text-red-500">2%</strong> needs attention</li>
            <li>Bounce rate below <strong className="text-green-600">3%</strong> is good — above <strong className="text-red-500">5%</strong> puts your domains at risk</li>
            <li>Leads = interested replies + meetings booked (all time)</li>
          </ul>
        </div>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  accent = false,
  highlight,
}: {
  label: string
  value: string | null
  accent?: boolean
  highlight?: 'good' | 'bad' | 'neutral'
}) {
  const valueColor = highlight === 'good'
    ? 'text-green-600'
    : highlight === 'bad'
    ? 'text-red-600'
    : accent
    ? 'text-indigo-600'
    : 'text-gray-900'

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      {value === null ? (
        <div className="h-7 w-16 bg-gray-100 rounded animate-pulse" />
      ) : (
        <p className={`text-2xl font-semibold ${valueColor}`}>{value}</p>
      )}
    </div>
  )
}
