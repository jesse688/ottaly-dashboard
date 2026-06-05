'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

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
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Health</h1>
          <p className="text-sm text-gray-500">
            {filtered.length} workspaces · avg score {avgScore}
            {redCount > 0 && <span className="ml-2 text-red-600 font-medium">· {redCount} critical</span>}
          </p>
        </div>
      </div>

      <div className="bg-white border-b px-6 py-3">
        <Input
          placeholder="Search workspace..."
          className="w-72"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead className="text-center">Score</TableHead>
                <TableHead>Sent 30d</TableHead>
                <TableHead>Replies 30d</TableHead>
                <TableHead>Reply % 30d</TableHead>
                <TableHead>Leads 30d</TableHead>
                <TableHead>Bounce % 7d</TableHead>
                <TableHead>Mailboxes</TableHead>
                <TableHead>Unhealthy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-gray-500">No data found</TableCell>
                </TableRow>
              ) : (
                filtered.map(r => (
                  <TableRow key={r.workspace_id} className={`hover:bg-gray-50 ${r.health_band === 'red' ? 'bg-red-50' : ''}`}>
                    <TableCell className="font-medium">{r.workspace_name ?? r.workspace_id}</TableCell>
                    <TableCell className="text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${BAND_COLORS[r.health_band] ?? 'bg-gray-100'}`}>
                        {r.health_score}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{r.sent_30d?.toLocaleString() ?? '—'}</TableCell>
                    <TableCell className="text-sm">{r.replies_30d?.toLocaleString() ?? '—'}</TableCell>
                    <TableCell className="text-sm">
                      <span className={r.reply_rate_30d != null && Number(r.reply_rate_30d) >= 0.05 ? 'text-green-700 font-medium' : ''}>
                        {pct(r.reply_rate_30d)}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-blue-700 font-medium">{r.leads_30d ?? '—'}</TableCell>
                    <TableCell className="text-sm">
                      <span className={r.bounce_rate_7d != null && Number(r.bounce_rate_7d) >= 0.03 ? 'text-red-600' : ''}>
                        {pct(r.bounce_rate_7d)}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{r.mailbox_total ?? '—'}</TableCell>
                    <TableCell className="text-sm">
                      <span className={r.mailbox_unhealthy > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}>
                        {r.mailbox_unhealthy}
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
