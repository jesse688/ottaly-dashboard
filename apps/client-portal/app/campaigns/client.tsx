'use client'

import { useEffect, useState } from 'react'
import { fmt, pct } from '@/lib/utils'

interface Campaign {
  id: string
  name: string
  status: string
  lead_count: number
  sent_count: number
  replied_count: number
  bounced_count: number
  positive_reply_count: number
  daily_limit: number
  reply_rate: number
  bounce_rate: number
  last_lead_sent: string | null
}

const STATUS_COLORS: Record<string, string> = {
  active:   'bg-green-100 text-green-700',
  paused:   'bg-yellow-100 text-yellow-700',
  completed:'bg-blue-100 text-blue-700',
  draft:    'bg-gray-100 text-gray-600',
}

export function CampaignsClient() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/portal/campaigns')
      .then(r => r.json())
      .then((d: Campaign[] | { error: string }) => {
        if (!Array.isArray(d)) setError((d as { error: string }).error)
        else setCampaigns(d)
      })
      .catch(() => setError('Failed to load campaigns'))
  }, [])

  if (error) return <div className="p-6 text-red-600 text-sm">{error}</div>

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-gray-900 mb-6">Campaigns</h1>

      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left">
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Campaign</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Sent</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Replies</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Reply Rate</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Leads</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Bounce</th>
            </tr>
          </thead>
          <tbody>
            {campaigns === null ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-gray-50">
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 bg-gray-100 rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))
            ) : campaigns.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400 text-sm">
                  No campaigns found
                </td>
              </tr>
            ) : (
              campaigns.map(c => {
                const rr = parseFloat(String(c.reply_rate))
                const br = parseFloat(String(c.bounce_rate))
                return (
                  <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900 max-w-xs">
                      <span className="truncate block">{c.name}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[c.status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">{fmt(c.sent_count)}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{fmt(c.replied_count)}</td>
                    <td className={`px-4 py-3 text-right font-medium ${rr >= 0.03 ? 'text-green-600' : rr < 0.02 && rr > 0 ? 'text-red-500' : 'text-gray-700'}`}>
                      {pct(rr)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-indigo-600">{fmt(c.positive_reply_count)}</td>
                    <td className={`px-4 py-3 text-right ${br > 0.05 ? 'text-red-500' : 'text-gray-700'}`}>
                      {pct(br)}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
