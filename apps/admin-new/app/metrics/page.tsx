'use client'

import { useEffect, useState } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface MetricRow { ws_id: string; date: string; data: Record<string, unknown> }

export default function MetricsPage() {
  const [rows, setRows] = useState<MetricRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/metrics').then(r => r.json()).then(d => setRows(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false))
  }, [])

  // Get all unique metric keys across all rows
  const allKeys = [...new Set(rows.flatMap(r => Object.keys(r.data ?? {})))].slice(0, 10)
  // Dedupe by ws_id keeping latest date
  const latest: Record<string, MetricRow> = {}
  for (const r of rows) { if (!latest[r.ws_id] || r.date > latest[r.ws_id].date) latest[r.ws_id] = r }
  const dedupedRows = Object.values(latest)

  function fmt(v: unknown) {
    if (v == null) return '—'
    if (typeof v === 'number') return v % 1 === 0 ? v.toLocaleString() : v.toFixed(2)
    return String(v)
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Metrics</h1>
        <p className="text-sm text-gray-500">{dedupedRows.length} workspaces · latest snapshot</p>
      </div>
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Date</TableHead>
                {allKeys.map(k => <TableHead key={k} className="whitespace-nowrap text-xs">{k.replace(/_/g, ' ')}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? Array.from({length:8}).map((_,i) => <TableRow key={i}>{Array.from({length: 2 + allKeys.length}).map((_,j) => <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse"/></TableCell>)}</TableRow>)
              : dedupedRows.map(r => (
                <TableRow key={r.ws_id} className="hover:bg-gray-50">
                  <TableCell className="font-medium text-sm">{r.ws_id}</TableCell>
                  <TableCell className="text-sm text-gray-500">{r.date}</TableCell>
                  {allKeys.map(k => <TableCell key={k} className="text-sm">{fmt((r.data ?? {})[k])}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
