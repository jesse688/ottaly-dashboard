'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface Signal { id: number; timestamp: string; signal_type: string; workspace_id: string; metric_key: string; metric_value: number; unit: string; status: string; notes: string }

const STATUS_COLORS: Record<string, string> = {
  normal: 'text-green-600', warning: 'text-yellow-600', critical: 'text-red-600',
}

export default function DiagnosticsPage() {
  const [signals, setSignals] = useState<Signal[]>([])
  const [filtered, setFiltered] = useState<Signal[]>([])
  const [loading, setLoading] = useState(true)
  const [hours, setHours] = useState('24')
  const [status, setStatus] = useState('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    setLoading(true)
    fetch(`/api/diagnostics?hours=${hours}`).then(r => r.json()).then(d => setSignals(d.signals ?? [])).catch(() => {}).finally(() => setLoading(false))
  }, [hours])

  useEffect(() => {
    let r = [...signals]
    if (status !== 'all') r = r.filter(s => s.status === status)
    if (search) { const q = search.toLowerCase(); r = r.filter(s => s.metric_key?.toLowerCase().includes(q) || s.signal_type?.toLowerCase().includes(q)) }
    setFiltered(r)
  }, [signals, status, search])

  const criticalCount = signals.filter(s => s.status === 'critical').length

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Diagnostics</h1>
        <p className="text-sm text-gray-500">
          {filtered.length.toLocaleString()} signals
          {criticalCount > 0 && <span className="ml-2 text-red-600 font-medium">· {criticalCount} critical</span>}
        </p>
      </div>
      <div className="bg-white border-b px-6 py-3 flex gap-3">
        <Input placeholder="Search metric, type..." className="w-64" value={search} onChange={e => setSearch(e.target.value)} />
        <Select value={status} onValueChange={v => v && setStatus(v)}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="normal">Normal</SelectItem>
            <SelectItem value="warning">Warning</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
          </SelectContent>
        </Select>
        <Select value={hours} onValueChange={v => v && setHours(v)}>
          <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1">1 hour</SelectItem>
            <SelectItem value="6">6 hours</SelectItem>
            <SelectItem value="24">24 hours</SelectItem>
            <SelectItem value="72">3 days</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Type</TableHead><TableHead>Metric</TableHead><TableHead>Value</TableHead><TableHead>Status</TableHead><TableHead>Notes</TableHead></TableRow></TableHeader>
            <TableBody>
              {loading ? Array.from({length:8}).map((_,i) => <TableRow key={i}>{Array.from({length:6}).map((_,j) => <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse"/></TableCell>)}</TableRow>)
              : filtered.length === 0 ? <TableRow><TableCell colSpan={6} className="text-center py-12 text-gray-500">No signals found</TableCell></TableRow>
              : filtered.slice(0, 200).map(s => (
                <TableRow key={s.id} className={`hover:bg-gray-50 ${s.status === 'critical' ? 'bg-red-50' : ''}`}>
                  <TableCell className="text-xs text-gray-500 whitespace-nowrap">{new Date(s.timestamp).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</TableCell>
                  <TableCell className="text-xs text-gray-600">{s.signal_type}</TableCell>
                  <TableCell className="text-sm font-mono">{s.metric_key}</TableCell>
                  <TableCell className="text-sm font-medium">{s.metric_value} <span className="text-gray-400 text-xs">{s.unit}</span></TableCell>
                  <TableCell><span className={`text-xs font-medium ${STATUS_COLORS[s.status] ?? ''}`}>{s.status}</span></TableCell>
                  <TableCell className="text-xs text-gray-500 max-w-xs truncate">{s.notes ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
