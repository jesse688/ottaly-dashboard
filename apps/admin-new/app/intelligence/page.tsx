'use client'

import { useEffect, useState } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface LogEntry { id: number; workspace_id: string; date: string; tier: string; reply_rate: number; send_volume: number; narrative: string; recommendations: string }
interface Pattern { id: number; pattern_type: string; pattern_value: string; workspace_id: string; avg_reply_rate: number; avg_bounce_rate: number; sample_size: number; correlation_strength: number }

const TIER_COLORS: Record<string, string> = {
  excellent: 'bg-green-100 text-green-800', good: 'bg-blue-100 text-blue-700',
  average: 'bg-yellow-100 text-yellow-700', poor: 'bg-red-100 text-red-700',
}

export default function IntelligencePage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [patterns, setPatterns] = useState<Pattern[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'logs' | 'patterns'>('logs')

  useEffect(() => {
    fetch('/api/intelligence').then(r => r.json()).then(d => { setLogs(d.logs ?? []); setPatterns(d.patterns ?? []) }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Intelligence</h1>
        <p className="text-sm text-gray-500">{logs.length} log entries · {patterns.length} patterns</p>
      </div>
      <div className="bg-white border-b px-6 flex gap-4">
        {(['logs', 'patterns'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`py-3 text-sm font-medium border-b-2 capitalize ${tab === t ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>{t}</button>
        ))}
      </div>
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          {tab === 'logs' ? (
            <Table>
              <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Workspace</TableHead><TableHead>Tier</TableHead><TableHead>Reply %</TableHead><TableHead>Sends</TableHead><TableHead>Narrative</TableHead></TableRow></TableHeader>
              <TableBody>
                {loading ? Array.from({length:5}).map((_,i) => <TableRow key={i}>{Array.from({length:6}).map((_,j) => <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse"/></TableCell>)}</TableRow>)
                : logs.map(l => (
                  <TableRow key={l.id} className="hover:bg-gray-50">
                    <TableCell className="text-sm text-gray-500">{l.date}</TableCell>
                    <TableCell className="text-sm">{l.workspace_id}</TableCell>
                    <TableCell><span className={`text-xs px-1.5 py-0.5 rounded font-medium ${TIER_COLORS[l.tier] ?? 'bg-gray-100'}`}>{l.tier}</span></TableCell>
                    <TableCell className="text-sm">{l.reply_rate != null ? `${(Number(l.reply_rate)*100).toFixed(1)}%` : '—'}</TableCell>
                    <TableCell className="text-sm">{l.send_volume?.toLocaleString() ?? '—'}</TableCell>
                    <TableCell className="text-xs text-gray-600 max-w-sm truncate">{l.narrative ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Pattern</TableHead><TableHead>Value</TableHead><TableHead>Avg Reply %</TableHead><TableHead>Avg Bounce %</TableHead><TableHead>Samples</TableHead><TableHead>Correlation</TableHead></TableRow></TableHeader>
              <TableBody>
                {patterns.map(p => (
                  <TableRow key={p.id} className="hover:bg-gray-50">
                    <TableCell className="text-sm font-medium">{p.pattern_type}</TableCell>
                    <TableCell className="text-sm">{p.pattern_value}</TableCell>
                    <TableCell className="text-sm">{p.avg_reply_rate != null ? `${(Number(p.avg_reply_rate)*100).toFixed(1)}%` : '—'}</TableCell>
                    <TableCell className="text-sm">{p.avg_bounce_rate != null ? `${(Number(p.avg_bounce_rate)*100).toFixed(1)}%` : '—'}</TableCell>
                    <TableCell className="text-sm">{p.sample_size}</TableCell>
                    <TableCell className="text-sm font-medium">{p.correlation_strength?.toFixed(2) ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  )
}
