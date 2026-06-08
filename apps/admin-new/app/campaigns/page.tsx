'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
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
  active: 'bg-green-100 text-green-800',
  ACTIVE: 'bg-green-100 text-green-800',
  paused: 'bg-yellow-100 text-yellow-800',
  PAUSED: 'bg-yellow-100 text-yellow-800',
  draft: 'bg-gray-100 text-gray-600',
  DRAFT: 'bg-gray-100 text-gray-600',
  completed: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-blue-100 text-blue-800',
}

function Pct({ value }: { value: number }) {
  return <span>{(value * 100).toFixed(1)}%</span>
}

function getPerformanceTier(replyRate: number) {
  if (replyRate >= 0.05) return { label: 'top', color: 'text-green-700' }
  if (replyRate >= 0.03) return { label: 'good', color: 'text-green-600' }
  if (replyRate >= 0.01) return { label: 'warning', color: 'text-amber-600' }
  return { label: 'critical', color: 'text-red-600' }
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [filtered, setFiltered] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [sortBy, setSortBy] = useState<keyof Campaign>('reply_rate')
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
    const isActive = sortBy === col
    return (
      <TableHead 
        className="cursor-pointer hover:text-gray-900 select-none" 
        onClick={() => setSort(col)}
      >
        <div className="flex items-center gap-1">
          <span>{label}</span>
          {isActive && <span className="text-xs">{sortDir === 'asc' ? '↑' : '↓'}</span>}
        </div>
      </TableHead>
    )
  }

  const totals = filtered.reduce(
    (acc, c) => ({ sent: acc.sent + (c.sent_count ?? 0), replies: acc.replies + (c.replied_count ?? 0) }),
    { sent: 0, replies: 0 }
  )

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Campaigns</h1>
        <p className="text-sm text-gray-500">
          {filtered.length} campaigns · {totals.sent.toLocaleString()} sent · {totals.replies.toLocaleString()} replies
        </p>
      </div>

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
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortHead col="name" label="Campaign" />
                <TableHead>Workspace</TableHead>
                <TableHead>Status</TableHead>
                <SortHead col="sent_count" label="Sent" />
                <SortHead col="replied_count" label="Replies" />
                <SortHead col="positive_reply_count" label="Positive" />
                <SortHead col="reply_rate_calc" label="Reply %" />
                <SortHead col="bounce_rate" label="Bounce %" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 8 }).map((_, j) => (
                      <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12 text-gray-500">
                    No campaigns found
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map(c => {
                  const tier = getPerformanceTier(c.reply_rate_calc)
                  return (
                    <TableRow key={c.id} className="hover:bg-gray-50">
                      <TableCell className="font-medium max-w-xs truncate">{c.name}</TableCell>
                      <TableCell className="text-sm text-gray-600">{c.workspace_name ?? '—'}</TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[c.status] ?? 'bg-gray-100 text-gray-600'}`}>
                          {c.status}
                        </span>
                      </TableCell>
                      <TableCell>{c.sent_count.toLocaleString()}</TableCell>
                      <TableCell>{c.replied_count.toLocaleString()}</TableCell>
                      <TableCell>{c.positive_reply_count.toLocaleString()}</TableCell>
                      <TableCell>
                        <span className={`font-medium ${tier.color}`}>
                          <Pct value={c.reply_rate_calc} />
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className={c.bounce_rate >= 0.03 ? 'text-red-600 font-medium' : ''}>
                          <Pct value={c.bounce_rate} />
                        </span>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
