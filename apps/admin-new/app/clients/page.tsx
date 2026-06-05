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
import type { Client } from '@/types/client'

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  paused: 'bg-yellow-100 text-yellow-800',
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
      .then(d => setClients(Array.isArray(d) ? d : d.clients ?? []))
      .catch(() => setClients([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    let result = [...clients]
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.vertical ?? '').toLowerCase().includes(q)
      )
    }
    if (status !== 'all') result = result.filter(c => c.status === status)
    setFiltered(result)
  }, [clients, search, status])

  const mrr = filtered
    .filter(c => c.status === 'active')
    .reduce((sum, c) => sum + (c.monthly_value ?? 0), 0)

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Clients</h1>
          <p className="text-sm text-gray-500">
            {filtered.length} clients
            {mrr > 0 && <span className="ml-2 text-green-700 font-medium">· £{mrr.toLocaleString()} MRR</span>}
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
            <SelectItem value="trial">Trial</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="churned">Churned</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Vertical</TableHead>
                <TableHead>Monthly Value</TableHead>
                <TableHead>Start Date</TableHead>
                <TableHead>Contact</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-12 text-gray-500">No clients found</TableCell>
                </TableRow>
              ) : (
                filtered.map(c => (
                  <TableRow key={c.id} className="hover:bg-gray-50">
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[c.status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {c.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-gray-600">{c.vertical ?? '—'}</TableCell>
                    <TableCell className="text-sm">
                      {c.monthly_value != null ? `£${c.monthly_value.toLocaleString()}` : '—'}
                    </TableCell>
                    <TableCell className="text-sm text-gray-600">
                      {c.start_date ? new Date(c.start_date).toLocaleDateString('en-GB') : '—'}
                    </TableCell>
                    <TableCell className="text-sm text-gray-600">{c.contact_email ?? '—'}</TableCell>
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
