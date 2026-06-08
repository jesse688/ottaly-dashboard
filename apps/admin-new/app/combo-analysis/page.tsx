'use client'

import { useEffect, useMemo, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

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
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Combo Analysis</h1>
        <p className="text-sm text-gray-500">Sender × recipient provider performance</p>
      </div>
      <div className="bg-white border-b px-6 py-3">
        <Select value={workspace} onValueChange={v => v && setWorkspace(v)}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Workspace" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All workspaces</SelectItem>{workspaces.map(w => <SelectItem key={w} value={w}>{w}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>From → To</TableHead><TableHead>Sent</TableHead><TableHead>Replies</TableHead><TableHead>Reply %</TableHead><TableHead>Bounce %</TableHead><TableHead>Leads</TableHead></TableRow></TableHeader>
            <TableBody>
              {loading ? Array.from({length:6}).map((_,i) => <TableRow key={i}>{Array.from({length:6}).map((_,j) => <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse"/></TableCell>)}</TableRow>)
              : aggregated.map(r => (
                <TableRow key={r.key} className="hover:bg-gray-50">
                  <TableCell className="font-medium font-mono text-sm">{r.key}</TableCell>
                  <TableCell>{r.sent.toLocaleString()}</TableCell>
                  <TableCell>{r.replies.toLocaleString()}</TableCell>
                  <TableCell><span className={r.reply_rate >= 0.05 ? 'text-green-700 font-medium' : ''}>{pct(r.reply_rate)}</span></TableCell>
                  <TableCell><span className={r.bounce_rate >= 0.03 ? 'text-red-600' : ''}>{pct(r.bounce_rate)}</span></TableCell>
                  <TableCell className="text-blue-700 font-medium">{r.leads}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
