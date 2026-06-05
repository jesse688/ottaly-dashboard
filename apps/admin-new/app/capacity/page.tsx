'use client'

import { useEffect, useState } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface CapacityRow { workspace_id: string; workspace_name: string; mailbox_count: number; avg_daily_per_mailbox: number; monthly_capacity: number; sent_30d: number; avg_monthly_sends: number; contacts_total: number; client_status: string }

export default function CapacityPage() {
  const [rows, setRows] = useState<CapacityRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/capacity').then(r => r.json()).then(d => setRows(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const totalMailboxes = rows.reduce((s, r) => s + (r.mailbox_count ?? 0), 0)
  const totalCapacity = rows.reduce((s, r) => s + (r.monthly_capacity ?? 0), 0)

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Capacity</h1>
        <p className="text-sm text-gray-500">{totalMailboxes.toLocaleString()} mailboxes · {totalCapacity.toLocaleString()} monthly capacity</p>
      </div>
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Mailboxes</TableHead>
                <TableHead>Avg Daily/Box</TableHead>
                <TableHead>Monthly Capacity</TableHead>
                <TableHead>Sent 30d</TableHead>
                <TableHead>Utilisation</TableHead>
                <TableHead>Contacts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? Array.from({length:8}).map((_,i) => <TableRow key={i}>{Array.from({length:8}).map((_,j) => <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse"/></TableCell>)}</TableRow>)
              : rows.map(r => {
                const util = r.monthly_capacity > 0 ? (r.sent_30d ?? 0) / r.monthly_capacity : 0
                return (
                  <TableRow key={r.workspace_id} className="hover:bg-gray-50">
                    <TableCell className="font-medium">{r.workspace_name}</TableCell>
                    <TableCell><span className={`text-xs px-1.5 py-0.5 rounded ${r.client_status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>{r.client_status ?? '—'}</span></TableCell>
                    <TableCell>{r.mailbox_count ?? '—'}</TableCell>
                    <TableCell className="text-sm">{r.avg_daily_per_mailbox != null ? Number(r.avg_daily_per_mailbox).toFixed(0) : '—'}</TableCell>
                    <TableCell>{r.monthly_capacity?.toLocaleString() ?? '—'}</TableCell>
                    <TableCell>{r.sent_30d?.toLocaleString() ?? '—'}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="w-16 bg-gray-100 rounded-full h-1.5">
                          <div className={`h-1.5 rounded-full ${util > 0.8 ? 'bg-green-500' : util > 0.4 ? 'bg-yellow-400' : 'bg-gray-300'}`} style={{width: `${Math.min(100, util*100)}%`}} />
                        </div>
                        <span className="text-xs text-gray-500">{(util*100).toFixed(0)}%</span>
                      </div>
                    </TableCell>
                    <TableCell>{r.contacts_total?.toLocaleString() ?? '—'}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
