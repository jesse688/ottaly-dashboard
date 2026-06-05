'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface Lead { workspace_name: string; lead_email: string; first_name: string; last_name: string; campaign: string; lead_price: number; date: string; label: string }
interface Summary { workspace_id: string; name: string; leads: number; revenue: number }

export default function RevenuePage() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [summary, setSummary] = useState<Summary[]>([])
  const [filtered, setFiltered] = useState<Lead[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'leads' | 'summary'>('summary')

  useEffect(() => {
    fetch('/api/revenue').then(r => r.json()).then(d => { setLeads(d.leads ?? []); setSummary(d.summary ?? []) }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!search) { setFiltered(leads); return }
    const q = search.toLowerCase()
    setFiltered(leads.filter(l => l.lead_email?.toLowerCase().includes(q) || l.workspace_name?.toLowerCase().includes(q) || l.campaign?.toLowerCase().includes(q)))
  }, [leads, search])

  const totalRevenue = summary.reduce((s, r) => s + r.revenue, 0)
  const totalLeads = summary.reduce((s, r) => s + r.leads, 0)

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Revenue</h1>
        <p className="text-sm text-gray-500">{totalLeads} leads · £{totalRevenue.toLocaleString('en-GB', { maximumFractionDigits: 0 })} total</p>
      </div>
      <div className="bg-white border-b px-6 flex gap-4">
        {(['summary', 'leads'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`py-3 text-sm font-medium border-b-2 transition-colors capitalize ${tab === t ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>{t}</button>
        ))}
      </div>
      <div className="flex-1 overflow-auto px-6 py-4">
        {tab === 'leads' && (
          <div className="mb-4"><Input placeholder="Search email, workspace, campaign..." className="w-80" value={search} onChange={e => setSearch(e.target.value)} /></div>
        )}
        <div className="bg-white rounded-lg border">
          {tab === 'summary' ? (
            <Table>
              <TableHeader><TableRow><TableHead>Workspace</TableHead><TableHead>Leads</TableHead><TableHead>Revenue</TableHead><TableHead>Avg / Lead</TableHead></TableRow></TableHeader>
              <TableBody>
                {loading ? Array.from({length: 5}).map((_,i) => <TableRow key={i}>{Array.from({length:4}).map((_,j) => <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse"/></TableCell>)}</TableRow>)
                : summary.sort((a,b) => b.revenue - a.revenue).map(s => (
                  <TableRow key={s.workspace_id} className="hover:bg-gray-50">
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell>{s.leads}</TableCell>
                    <TableCell className="font-semibold text-green-700">£{s.revenue.toLocaleString('en-GB', {maximumFractionDigits: 0})}</TableCell>
                    <TableCell className="text-gray-500">£{s.leads > 0 ? (s.revenue/s.leads).toFixed(0) : 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Workspace</TableHead><TableHead>Email</TableHead><TableHead>Campaign</TableHead><TableHead>Label</TableHead><TableHead>Price</TableHead></TableRow></TableHeader>
              <TableBody>
                {loading ? Array.from({length: 8}).map((_,i) => <TableRow key={i}>{Array.from({length:6}).map((_,j) => <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse"/></TableCell>)}</TableRow>)
                : filtered.map((l, i) => (
                  <TableRow key={i} className="hover:bg-gray-50">
                    <TableCell className="text-sm text-gray-500">{new Date(l.date).toLocaleDateString('en-GB')}</TableCell>
                    <TableCell className="text-sm">{l.workspace_name}</TableCell>
                    <TableCell className="font-mono text-xs">{l.lead_email}</TableCell>
                    <TableCell className="text-sm text-gray-600 max-w-xs truncate">{l.campaign}</TableCell>
                    <TableCell><span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">{l.label}</span></TableCell>
                    <TableCell className="font-medium">£{parseFloat(String(l.lead_price)).toFixed(0)}</TableCell>
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
