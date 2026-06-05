'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface DnsCheck {
  status?: string
  valid?: boolean
  pass?: boolean
}

interface Domain {
  domain: string
  workspace_id: string
  workspace_name: string
  score: number | null
  status: string | null
  spf: DnsCheck | null
  dkim: DnsCheck | null
  dmarc: DnsCheck | null
  mx: DnsCheck | null
  blacklists: { listed?: boolean; count?: number } | null
  last_checked: string | null
  notes: string | null
  pm_verified_at: string | null
}

function Check({ ok }: { ok: boolean | null | undefined }) {
  if (ok == null) return <span className="text-gray-300">—</span>
  return ok
    ? <span className="text-green-600 font-medium">✓</span>
    : <span className="text-red-500 font-medium">✗</span>
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return <span className="text-gray-400">—</span>
  const color = score >= 90 ? 'text-green-700' : score >= 70 ? 'text-yellow-600' : 'text-red-600'
  return <span className={`font-semibold ${color}`}>{score}</span>
}

function dnsOk(check: DnsCheck | null) {
  if (!check) return null
  return check.valid ?? check.pass ?? (check.status === 'pass')
}

export default function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([])
  const [filtered, setFiltered] = useState<Domain[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [workspace, setWorkspace] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  useEffect(() => {
    fetch('/api/domains')
      .then(r => r.json())
      .then(d => setDomains(Array.isArray(d) ? d : []))
      .catch(() => setDomains([]))
      .finally(() => setLoading(false))
  }, [])

  const workspaces = [...new Set(domains.map(d => d.workspace_name).filter((w): w is string => !!w))].sort()

  useEffect(() => {
    let result = [...domains]
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(d => d.domain.toLowerCase().includes(q) || d.workspace_name?.toLowerCase().includes(q))
    }
    if (workspace !== 'all') result = result.filter(d => d.workspace_name === workspace)
    if (statusFilter !== 'all') result = result.filter(d => d.status === statusFilter)
    setFiltered(result)
  }, [domains, search, workspace, statusFilter])

  const issues = filtered.filter(d => d.score != null && d.score < 80).length
  const blacklisted = filtered.filter(d => d.blacklists?.listed).length

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Domains</h1>
          <p className="text-sm text-gray-500">
            {filtered.length} domains
            {issues > 0 && <span className="ml-2 text-yellow-600 font-medium">· {issues} need attention</span>}
            {blacklisted > 0 && <span className="ml-2 text-red-600 font-medium">· {blacklisted} blacklisted</span>}
          </p>
        </div>
      </div>

      <div className="bg-white border-b px-6 py-3 flex items-center gap-3 flex-wrap">
        <Input
          placeholder="Search domain, workspace..."
          className="w-72"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <Select value={workspace} onValueChange={v => v && setWorkspace(v)}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Workspace" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All workspaces</SelectItem>
            {workspaces.map(w => <SelectItem key={w} value={w}>{w}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={v => v && setStatusFilter(v)}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="good">Good</SelectItem>
            <SelectItem value="warning">Warning</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead className="text-center">Score</TableHead>
                <TableHead className="text-center">SPF</TableHead>
                <TableHead className="text-center">DKIM</TableHead>
                <TableHead className="text-center">DMARC</TableHead>
                <TableHead className="text-center">MX</TableHead>
                <TableHead className="text-center">Blacklist</TableHead>
                <TableHead>Last Checked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <TableCell key={j}><div className="h-4 bg-gray-100 rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-gray-500">No domains found</TableCell>
                </TableRow>
              ) : (
                filtered.map(d => (
                  <TableRow key={d.domain} className={`hover:bg-gray-50 ${d.score != null && d.score < 70 ? 'bg-red-50' : ''}`}>
                    <TableCell className="font-mono text-sm">{d.domain}</TableCell>
                    <TableCell className="text-sm text-gray-600">{d.workspace_name}</TableCell>
                    <TableCell className="text-center"><ScoreBadge score={d.score} /></TableCell>
                    <TableCell className="text-center"><Check ok={dnsOk(d.spf)} /></TableCell>
                    <TableCell className="text-center"><Check ok={dnsOk(d.dkim)} /></TableCell>
                    <TableCell className="text-center"><Check ok={dnsOk(d.dmarc)} /></TableCell>
                    <TableCell className="text-center"><Check ok={dnsOk(d.mx)} /></TableCell>
                    <TableCell className="text-center">
                      {d.blacklists?.listed
                        ? <span className="text-red-600 font-medium">Listed</span>
                        : <span className="text-green-600">Clean</span>}
                    </TableCell>
                    <TableCell className="text-xs text-gray-500">
                      {d.last_checked ? new Date(d.last_checked).toLocaleDateString('en-GB') : '—'}
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
