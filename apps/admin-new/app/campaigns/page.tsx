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
import type { Campaign } from '@/types/campaign'

const STATUS_COLORS: Record<string, string> = {
  active:    'bg-green-100 text-green-800',
  ACTIVE:    'bg-green-100 text-green-800',
  paused:    'bg-yellow-100 text-yellow-800',
  PAUSED:    'bg-yellow-100 text-yellow-800',
  draft:     'bg-gray-100 text-gray-600',
  DRAFT:     'bg-gray-100 text-gray-600',
  completed: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-blue-100 text-blue-800',
}

/** Colour-code a reply rate the same way the legacy tier system does */
function replyRateClass(rate: number): string {
  if (rate >= 0.05) return 'text-green-700 font-semibold'
  if (rate >= 0.025) return 'text-emerald-600 font-semibold'
  if (rate >= 0.01) return 'text-amber-600 font-semibold'
  return 'text-red-600 font-semibold'
}

function Pct({ value, className }: { value: number; className?: string }) {
  return <span className={className}>{(value * 100).toFixed(2)}%</span>
}

/** Thin coloured bar showing lead exhaustion (lead_count / sent_count) */
function ExhaustBar({ rate }: { rate: number }) {
  const pct = Math.min(Math.round(rate * 100), 100)
  const fill =
    rate >= 0.9 ? 'bg-red-500' : rate >= 0.75 ? 'bg-amber-500' : 'bg-green-500'
  return (
    <div className="flex items-center gap-2">
      <div className="w-12 h-1.5 rounded-full bg-gray-200 overflow-hidden">
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500">{pct}%</span>
    </div>
  )
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [filtered, setFiltered] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [sortBy, setSortBy] = useState<keyof Campaign>('reply_rate_calc')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  useEffect(() => {
    fetch('/api/campaigns')
      .then(r => r.json())
      .then(d => setCampaigns(Array.isArray(d) ? d : d.campaigns ?? []))
      .catch(() => setCampaigns([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    let result = [...campaigns]
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.workspace_name ?? '').toLowerCase().includes(q)
      )
    }
    if (status !== 'all') result = result.filter(c => c.status === status)
    result.sort((a, b) => {
      const av = a[sortBy] as number | string
      const bv = b[sortBy] as number | string
      const dir = sortDir === 'asc' ? 1 : -1
      return av > bv ? dir : av < bv ? -dir : 0
    })
    setFiltered(result)
  }, [campaigns, search, status, sortBy, sortDir])

  function setSort(col: keyof Campaign) {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortBy(col); setSortDir('desc') }
  }

  function SortHead({ col, label }: { col: keyof Campaign; label: string }) {
    return (
      <TableHead
        className="cursor-pointer hover:bg-gray-50 select-none whitespace-nowrap"
        onClick={() => setSort(col)}
      >
        {label}{sortBy === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
      </TableHead>
    )
  }

  const totals = filtered.reduce(
    (acc, c) => ({
      sent:    acc.sent    + (c.sent_count ?? 0),
      replies: acc.replies + (c.replied_count ?? 0),
    }),
    { sent: 0, replies: 0 }
  )

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Campaigns</h1>
        <p className="text-sm text-gray-500">
          {filtered.length} campaigns · {totals.sent.toLocaleString()} sent · {totals.replies.toLocaleString()} replies
        </p>
      </div>

      {/* Filters */}
      <div className="bg-white border-b px-6 py-3 flex items-center gap-3">
        <Input
          placeholder="Search campaigns..."
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
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="PAUSED">Paused</SelectItem>
            <SelectItem value="DRAFT">Draft</SelectItem>
            <SelectItem value="COMPLETED">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortHead col="name"            label="Campaign"    />
                <TableHead>Workspace</TableHead>
                <TableHead>Status</TableHead>
                <SortHead col="sent_count"      label="Sent"        />
                <SortHead col="lead_rate"       label="Data Used"   />
                <SortHead col="reply_rate_calc" label="Reply Rate"  />
                <SortHead col="bounce_rate"     label="Bounce Rate" />
                <SortHead col="positive_rate"   label="Positive %"  />
                <SortHead col="lead_count"      label="Leads"       />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <TableCell key={j}>
                        <div className="h-4 bg-gray-100 rounded animate-pulse" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-gray-500">
                    No campaigns found
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map(c => (
                  <TableRow key={c.id} className="hover:bg-gray-50">
                    {/* Campaign name */}
                    <TableCell className="max-w-xs">
                      <div className="font-semibold text-sm truncate" title={c.name}>
                        {c.name}
                      </div>
                    </TableCell>

                    {/* Workspace */}
                    <TableCell className="text-sm text-gray-600 whitespace-nowrap">
                      {c.workspace_name ?? '—'}
                    </TableCell>

                    {/* Status badge */}
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLORS[c.status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {(c.status ?? '—').toLowerCase()}
                      </span>
                    </TableCell>

                    {/* Sent */}
                    <TableCell className="font-semibold tabular-nums">
                      {c.sent_count.toLocaleString()}
                    </TableCell>

                    {/* Data Used — lead exhaustion bar */}
                    <TableCell>
                      {c.sent_count > 0
                        ? <ExhaustBar rate={c.lead_rate} />
                        : <span className="text-gray-400">—</span>}
                    </TableCell>

                    {/* Reply Rate */}
                    <TableCell>
                      {c.sent_count >= 50
                        ? <Pct value={c.reply_rate_calc} className={replyRateClass(c.reply_rate_calc)} />
                        : <span className="text-gray-400">—</span>}
                    </TableCell>

                    {/* Bounce Rate */}
                    <TableCell>
                      {c.sent_count >= 50
                        ? <Pct
                            value={c.bounce_rate}
                            className={c.bounce_rate >= 0.05 ? 'text-red-600 font-semibold' : c.bounce_rate >= 0.02 ? 'text-amber-600' : ''}
                          />
                        : <span className="text-gray-400">—</span>}
                    </TableCell>

                    {/* Positive % */}
                    <TableCell>
                      {c.replied_count > 0
                        ? <Pct value={c.positive_rate} className={c.positive_rate >= 0.5 ? 'text-green-700 font-semibold' : ''} />
                        : <span className="text-gray-400">—</span>}
                    </TableCell>

                    {/* Leads */}
                    <TableCell className="tabular-nums">
                      {c.lead_count > 0
                        ? c.lead_count.toLocaleString()
                        : <span className="text-gray-400">—</span>}
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
