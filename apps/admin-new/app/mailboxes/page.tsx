'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
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
import type { Mailbox } from '@/types/mailbox'

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  disconnected: 'bg-red-100 text-red-800',
  warming: 'bg-orange-100 text-orange-800',
  paused: 'bg-yellow-100 text-yellow-800',
  error: 'bg-red-100 text-red-800',
}

export default function MailboxesPage() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [filtered, setFiltered] = useState<Mailbox[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [supplier, setSupplier] = useState('all')

  useEffect(() => {
    fetch('/api/mailboxes')
      .then(r => r.json())
      .then(d => setMailboxes(Array.isArray(d) ? d : d.mailboxes ?? []))
      .catch(() => setMailboxes([]))
      .finally(() => setLoading(false))
  }, [])

  const suppliers = [...new Set(mailboxes.map(m => m.supplier).filter(Boolean))] as string[]

  useEffect(() => {
    let result = [...mailboxes]
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(m =>
        m.email.toLowerCase().includes(q) ||
        (m.workspace_name ?? '').toLowerCase().includes(q)
      )
    }
    if (status !== 'all') result = result.filter(m => m.status === status)
    if (supplier !== 'all') result = result.filter(m => m.supplier === supplier)
    setFiltered(result)
  }, [mailboxes, search, status, supplier])

  const needsAttention = filtered.filter(m => m.status === 'disconnected' || m.status === 'error').length

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Mailboxes</h1>
          <p className="text-sm text-gray-500">
            {filtered.length} mailboxes
            {needsAttention > 0 && (
              <span className="ml-2 text-red-600 font-medium">· {needsAttention} need attention</span>
            )}
          </p>
        </div>
      </div>

      <div className="bg-white border-b px-6 py-3 flex items-center gap-3 flex-wrap">
        <Input
          placeholder="Search email, workspace..."
          className="w-72"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <Select value={status} onValueChange={v => v && setStatus(v)}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="warming">Warming</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="disconnected">Disconnected</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
        {suppliers.length > 0 && (
          <Select value={supplier} onValueChange={v => v && setSupplier(v)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Supplier" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All suppliers</SelectItem>
              {suppliers.map(s => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {needsAttention > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="text-red-600 border-red-200"
            onClick={() => setStatus('disconnected')}
          >
            Show attention only
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Warmup</TableHead>
                <TableHead>Sent Today</TableHead>
                <TableHead>Daily Limit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12 text-gray-500">No mailboxes found</TableCell>
                </TableRow>
              ) : (
                filtered.map(m => (
                  <TableRow key={m.id} className="hover:bg-gray-50">
                    <TableCell className="font-mono text-sm">{m.email}</TableCell>
                    <TableCell className="text-sm text-gray-600">{m.workspace_name ?? '—'}</TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[m.status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {m.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{m.supplier ?? '—'}</TableCell>
                    <TableCell>
                      {m.warmup_enabled ? (
                        <span className="text-green-700 text-sm">
                          On {m.warmup_score != null ? `(${m.warmup_score})` : ''}
                        </span>
                      ) : (
                        <span className="text-gray-400 text-sm">Off</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{m.sent_today ?? '—'}</TableCell>
                    <TableCell className="text-sm">{m.daily_limit ?? '—'}</TableCell>
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
