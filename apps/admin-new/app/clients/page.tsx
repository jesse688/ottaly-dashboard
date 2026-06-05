'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
interface Client {
  workspace_id: string
  workspace_name: string
  status: string | null
  mailbox_count: number | null
  contacts_total: number | null
  sent_30d: number | null
  replied_30d: number | null
  reply_rate_30d: number | null
  leads_30d: number | null
  leads_90d: number | null
  last_sent_at: string | null
  last_lead_at: string | null
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  inactive: 'bg-yellow-100 text-yellow-800',
  churned: 'bg-red-100 text-red-800',
  trial: 'bg-purple-100 text-purple-800',
}

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [filtered, setFiltered] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')

  useEffect(() => {
    fetch('/api/clients')
      .then(r => r.json())
      .then(d => setClients(Array.isArray(d) ? d : []))
      .catch(() => setClients([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    let result = [...clients]
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(c => c.workspace_name.toLowerCase().includes(q))
    }
    if (status !== 'all') result = result.filter(c => c.status === status)
    setFiltered(result)
  }, [clients, search, status])

  const totalLeads = filtered.reduce((sum, c) => sum + (c.leads_30d ?? 0), 0)

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Clients</h1>
          <p className="text-sm text-gray-500">
            {filtered.length} workspaces · {totalLeads} leads in 30d
          </p>
        </div>
      </div>

      <div className="bg-white border-b px-6 py-3 flex items-center gap-3">
        <Input
          placeholder="Search clients..."
          className="w-72"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <Select value={status} onValueChange={v => v && setStatus(v)}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="churned">Churned</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Mailboxes</TableHead>
                <TableHead>Sent 30d</TableHead>
                <TableHead>Reply % 30d</TableHead>
                <TableHead>Leads 30d</TableHead>
                <TableHead>Last Sent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12 text-gray-500">No clients found</TableCell>
                </TableRow>
              ) : (
                filtered.map(c => (
                  <TableRow key={c.workspace_id} className="hover:bg-gray-50">
                    <TableCell className="font-medium">{c.workspace_name}</TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[c.status ?? ''] ?? 'bg-gray-100 text-gray-600'}`}>
                        {c.status ?? '—'}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{c.mailbox_count ?? '—'}</TableCell>
                    <TableCell className="text-sm">{c.sent_30d?.toLocaleString() ?? '—'}</TableCell>
                    <TableCell className="text-sm">
                      {c.reply_rate_30d != null ? `${c.reply_rate_30d.toFixed(1)}%` : '—'}
                    </TableCell>
                    <TableCell className="text-sm font-medium text-blue-700">{c.leads_30d ?? '—'}</TableCell>
                    <TableCell className="text-sm text-gray-500">
                      {c.last_sent_at ? new Date(c.last_sent_at).toLocaleDateString('en-GB') : '—'}
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
