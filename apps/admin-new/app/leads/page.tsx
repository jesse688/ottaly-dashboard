'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ArrowUp } from 'lucide-react'

interface Lead {
  id: string
  workspace_id: string
  campaign_id: string | null
  email: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  status: string | null
  label: string | null
  first_replied_at: string | null
  created_at: string | null
}

interface LeadsResponse {
  leads: Lead[]
  total: number
  page: number
  pageSize: number
}

const LABEL_COLORS: Record<string, string> = {
  INTERESTED: 'bg-green-100 text-green-800',
  MEETING_BOOKED: 'bg-purple-100 text-purple-700',
  NOT_INTERESTED: 'bg-gray-100 text-gray-600',
  OUT_OF_OFFICE: 'bg-yellow-100 text-yellow-700',
}

export default function LeadsPage() {
  const [data, setData] = useState<LeadsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [workspaceId, setWorkspaceId] = useState('all')
  const [label, setLabel] = useState('all')
  const [page, setPage] = useState(1)
  const [showBackToTop, setShowBackToTop] = useState(false)

  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const fetchLeads = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page) })
    if (workspaceId !== 'all') params.set('workspace_id', workspaceId)
    if (label !== 'all') params.set('status', label)
    try {
      const res = await fetch(`/api/leads?${params}`)
      const d = await res.json()
      setData(d)
    } catch { setData(null) }
    finally { setLoading(false) }
  }, [page, workspaceId, label])

  useEffect(() => { fetchLeads() }, [fetchLeads])

  // Show button after scrolling down 300px inside the scroll container
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const handleScroll = () => setShowBackToTop(el.scrollTop > 300)

    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  const scrollToTop = () => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const leads = data?.leads ?? []
  const filtered = search
    ? leads.filter(l =>
        l.email?.toLowerCase().includes(search.toLowerCase()) ||
        l.company_name?.toLowerCase().includes(search.toLowerCase()) ||
        [l.first_name, l.last_name].filter(Boolean).join(' ').toLowerCase().includes(search.toLowerCase())
      )
    : leads

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 1

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Leads</h1>
        <p className="text-sm text-gray-500">{data?.total.toLocaleString() ?? '—'} leads from PlusVibe</p>
      </div>

      <div className="bg-white border-b px-6 py-3 flex gap-3 flex-wrap">
        <Input placeholder="Search email, name, company..." className="w-72" value={search} onChange={e => setSearch(e.target.value)} />
        <Select value={label} onValueChange={v => { v && setLabel(v); setPage(1) }}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Label" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All labels</SelectItem>
            <SelectItem value="INTERESTED">Interested</SelectItem>
            <SelectItem value="MEETING_BOOKED">Meeting Booked</SelectItem>
            <SelectItem value="NOT_INTERESTED">Not Interested</SelectItem>
            <SelectItem value="OUT_OF_OFFICE">Out of Office</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Scrollable content area */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto px-6 py-4 relative">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>First Replied</TableHead>
                <TableHead>Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>{Array.from({ length: 6 }).map((_, j) => <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse" /></TableCell>)}</TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-12 text-gray-500">No leads found</TableCell></TableRow>
              ) : filtered.map(l => (
                <TableRow key={l.id} className="hover:bg-gray-50">
                  <TableCell className="font-mono text-xs">{l.email}</TableCell>
                  <TableCell className="text-sm">{[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}</TableCell>
                  <TableCell className="text-sm text-gray-600">{l.company_name ?? '—'}</TableCell>
                  <TableCell>
                    {l.label ? (
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${LABEL_COLORS[l.label] ?? 'bg-gray-100 text-gray-600'}`}>{l.label}</span>
                    ) : '—'}
                  </TableCell>
                  <TableCell className="text-xs text-gray-500">
                    {l.first_replied_at ? new Date(l.first_replied_at).toLocaleDateString('en-GB') : '—'}
                  </TableCell>
                  <TableCell className="text-xs text-gray-500">
                    {l.created_at ? new Date(l.created_at).toLocaleDateString('en-GB') : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-gray-600">Page {page} of {totalPages} · {data?.total.toLocaleString()} total</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
              <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
            </div>
          </div>
        )}

        {/* Back to top button */}
        <button
          onClick={scrollToTop}
          aria-label="Back to top"
          className={`
            fixed bottom-6 right-6 z-50
            flex items-center gap-1.5 px-3 py-2
            bg-white border border-gray-200 rounded-full shadow-md
            text-sm font-medium text-gray-600
            hover:bg-gray-50 hover:text-gray-900 hover:shadow-lg
            transition-all duration-200
            ${showBackToTop ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 translate-y-4 pointer-events-none'}
          `}
        >
          <ArrowUp className="h-3.5 w-3.5" />
          Back to top
        </button>
      </div>
    </div>
  )
}
