'use client'

import { useEffect, useState } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface WorkloadRow { workspace_id: string; workspace_name: string; status: string; leads_30d: number; leads_90d: number; reply_rate_30d: number; mailbox_count: number; sent_30d: number; lpt_30d: number; lead_target: number }

function pct(v: number | null) { return v != null ? `${Number(v).toFixed(1)}%` : '—' }

export default function WorkloadPage() {
  const [rows, setRows] = useState<WorkloadRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/workload').then(r => r.json()).then(d => setRows(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const totalLeads = rows.reduce((s, r) => s + (r.leads_30d ?? 0), 0)

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Workload</h1>
        <p className="text-sm text-gray-500">{rows.length} workspaces · {totalLeads} leads this month</p>
      </div>
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Leads 30d</TableHead>
                <TableHead>Leads 90d</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Reply % 30d</TableHead>
                <TableHead>LPT 30d</TableHead>
                <TableHead>Mailboxes</TableHead>
                <TableHead>Sent 30d</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? Array.from({length:8}).map((_,i) => <TableRow key={i}>{Array.from({length:9}).map((_,j) => <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse"/></TableCell>)}</TableRow>)
              : rows.map(r => (
                <TableRow key={r.workspace_id} className="hover:bg-gray-50">
                  <TableCell className="font-medium">{r.workspace_name}</TableCell>
                  <TableCell><span className={`text-xs px-1.5 py-0.5 rounded ${r.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>{r.status ?? '—'}</span></TableCell>
                  <TableCell className="font-semibold text-blue-700">{r.leads_30d ?? '—'}</TableCell>
                  <TableCell>{r.leads_90d ?? '—'}</TableCell>
                  <TableCell className="text-gray-500">{r.lead_target ?? '—'}</TableCell>
                  <TableCell>{pct(r.reply_rate_30d)}</TableCell>
                  <TableCell>{r.lpt_30d != null ? Number(r.lpt_30d).toFixed(1) : '—'}</TableCell>
                  <TableCell>{r.mailbox_count ?? '—'}</TableCell>
                  <TableCell>{r.sent_30d?.toLocaleString() ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
