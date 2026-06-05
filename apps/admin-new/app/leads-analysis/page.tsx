'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface Lead { workspace_id: string; workspace_name: string; lead_email: string; first_name: string; last_name: string; campaign: string; lead_price: number; date: string; label: string }

const LABEL_COLORS: Record<string, string> = {
  INTERESTED: 'bg-green-100 text-green-800', LEAD: 'bg-blue-100 text-blue-700',
  MEETING_BOOKED: 'bg-purple-100 text-purple-700', NOT_INTERESTED: 'bg-gray-100 text-gray-600',
}

export default function LeadsAnalysisPage() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [filtered, setFiltered] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [workspace, setWorkspace] = useState('all')
  const [label, setLabel] = useState('all')

  useEffect(() => {
    fetch('/api/leads-analysis').then(r => r.json()).then(d => setLeads(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const workspaces = [...new Set(leads.map(l => l.workspace_name).filter(Boolean))].sort()
  const labels = [...new Set(leads.map(l => l.label).filter(Boolean))].sort()

  useEffect(() => {
    let r = [...leads]
    if (search) { const q = search.toLowerCase(); r = r.filter(l => l.lead_email?.toLowerCase().includes(q) || l.campaign?.toLowerCase().includes(q)) }
    if (workspace !== 'all') r = r.filter(l => l.workspace_name === workspace)
    if (label !== 'all') r = r.filter(l => l.label === label)
    setFiltered(r)
  }, [leads, search, workspace, label])

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Leads Analysis</h1>
        <p className="text-sm text-gray-500">{filtered.length.toLocaleString()} leads</p>
      </div>
      <div className="bg-white border-b px-6 py-3 flex gap-3 flex-wrap">
        <Input placeholder="Search email, campaign..." className="w-72" value={search} onChange={e => setSearch(e.target.value)} />
        <Select value={workspace} onValueChange={v => v && setWorkspace(v)}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Workspace" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All workspaces</SelectItem>{workspaces.map(w => <SelectItem key={w} value={w}>{w}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={label} onValueChange={v => v && setLabel(v)}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Label" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All labels</SelectItem>{labels.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Workspace</TableHead><TableHead>Email</TableHead><TableHead>Name</TableHead><TableHead>Campaign</TableHead><TableHead>Label</TableHead><TableHead>Price</TableHead></TableRow></TableHeader>
            <TableBody>
              {loading ? Array.from({length:8}).map((_,i) => <TableRow key={i}>{Array.from({length:7}).map((_,j) => <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse"/></TableCell>)}</TableRow>)
              : filtered.length === 0 ? <TableRow><TableCell colSpan={7} className="text-center py-12 text-gray-500">No leads found</TableCell></TableRow>
              : filtered.map((l, i) => (
                <TableRow key={i} className="hover:bg-gray-50">
                  <TableCell className="text-sm text-gray-500">{new Date(l.date).toLocaleDateString('en-GB')}</TableCell>
                  <TableCell className="text-sm">{l.workspace_name}</TableCell>
                  <TableCell className="font-mono text-xs">{l.lead_email}</TableCell>
                  <TableCell className="text-sm">{[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}</TableCell>
                  <TableCell className="text-sm text-gray-600 max-w-xs truncate">{l.campaign}</TableCell>
                  <TableCell><span className={`text-xs px-1.5 py-0.5 rounded font-medium ${LABEL_COLORS[l.label] ?? 'bg-gray-100 text-gray-600'}`}>{l.label}</span></TableCell>
                  <TableCell className="text-sm font-medium">£{parseFloat(String(l.lead_price ?? 0)).toFixed(0)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
