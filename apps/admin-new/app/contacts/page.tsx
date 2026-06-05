'use client'

import { useEffect, useState, useCallback } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
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
import type { Contact, ContactFilters } from '@/types/contact'

const PAGE_SIZE = 50

const STATUS_COLORS: Record<string, string> = {
  verified: 'bg-green-100 text-green-800',
  bounced: 'bg-red-100 text-red-800',
  unverified: 'bg-gray-100 text-gray-600',
  lead: 'bg-blue-100 text-blue-800',
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [filters, setFilters] = useState<ContactFilters>({
    page: 1,
    pageSize: PAGE_SIZE,
    sortBy: 'email',
    sortDir: 'asc',
  })

  const fetchContacts = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      Object.entries(filters).forEach(([k, v]) => {
        if (v !== undefined && v !== '') params.set(k, String(v))
      })
      const res = await fetch(`/api/contacts?${params}`)
      if (!res.ok) throw new Error('Failed to fetch')
      const data = await res.json()
      setContacts(data.contacts ?? [])
      setTotal(data.total ?? 0)
    } catch {
      setContacts([])
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => { fetchContacts() }, [fetchContacts])

  function toggleSelect(id: number) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (selected.size === contacts.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(contacts.map(c => c.id)))
    }
  }

  function setSort(col: string) {
    setFilters(f => ({
      ...f,
      sortBy: col,
      sortDir: f.sortBy === col && f.sortDir === 'asc' ? 'desc' : 'asc',
      page: 1,
    }))
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Contacts</h1>
          <p className="text-sm text-gray-500">{total.toLocaleString()} total</p>
        </div>
        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">{selected.size} selected</span>
            <Button variant="outline" size="sm">Export to Apollo</Button>
            <Button variant="outline" size="sm">Add to Campaign</Button>
          </div>
        )}
      </div>

      {/* Filters bar */}
      <div className="bg-white border-b px-6 py-3 flex items-center gap-3 flex-wrap">
        <Input
          placeholder="Search email, name, company..."
          className="w-72"
          value={filters.search ?? ''}
          onChange={e => setFilters(f => ({ ...f, search: e.target.value, page: 1 }))}
        />
        <Select
          value={filters.status ?? 'all'}
          onValueChange={v => setFilters(f => ({ ...f, status: v === 'all' ? undefined : v, page: 1 } as ContactFilters))}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="verified">Verified</SelectItem>
            <SelectItem value="unverified">Unverified</SelectItem>
            <SelectItem value="bounced">Bounced</SelectItem>
            <SelectItem value="lead">Lead</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.country ?? 'all'}
          onValueChange={v => setFilters(f => ({ ...f, country: v === 'all' ? undefined : v, page: 1 } as ContactFilters))}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Country" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All countries</SelectItem>
            <SelectItem value="United Kingdom">United Kingdom</SelectItem>
            <SelectItem value="United States">United States</SelectItem>
            <SelectItem value="Australia">Australia</SelectItem>
            <SelectItem value="Canada">Canada</SelectItem>
          </SelectContent>
        </Select>
        {(filters.search || filters.status || filters.country) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilters(f => ({ ...f, search: undefined, status: undefined, country: undefined, page: 1 }))}
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={selected.size === contacts.length && contacts.length > 0}
                    onCheckedChange={toggleAll}
                  />
                </TableHead>
                <TableHead className="cursor-pointer hover:bg-gray-50" onClick={() => setSort('email')}>
                  Email {filters.sortBy === 'email' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
                </TableHead>
                <TableHead className="cursor-pointer hover:bg-gray-50" onClick={() => setSort('first_name')}>
                  Name {filters.sortBy === 'first_name' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
                </TableHead>
                <TableHead className="cursor-pointer hover:bg-gray-50" onClick={() => setSort('company_name')}>
                  Company {filters.sortBy === 'company_name' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
                </TableHead>
                <TableHead className="cursor-pointer hover:bg-gray-50" onClick={() => setSort('job_title')}>
                  Title {filters.sortBy === 'job_title' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
                </TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="cursor-pointer hover:bg-gray-50" onClick={() => setSort('status')}>
                  Status {filters.sortBy === 'status' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <TableCell key={j}>
                        <div className="h-4 bg-gray-100 rounded animate-pulse w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : contacts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12 text-gray-500">
                    No contacts found
                  </TableCell>
                </TableRow>
              ) : (
                contacts.map(contact => (
                  <TableRow key={contact.id} className="hover:bg-gray-50">
                    <TableCell>
                      <Checkbox
                        checked={selected.has(contact.id)}
                        onCheckedChange={() => toggleSelect(contact.id)}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-sm">{contact.email}</TableCell>
                    <TableCell>
                      {[contact.first_name, contact.last_name].filter(Boolean).join(' ') || '—'}
                    </TableCell>
                    <TableCell>{contact.company_name ?? '—'}</TableCell>
                    <TableCell>
                      <div>{contact.job_title ?? '—'}</div>
                      {contact.seniority && (
                        <div className="text-xs text-gray-400">{contact.seniority}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-gray-600">
                      {[contact.city, contact.country].filter(Boolean).join(', ') || '—'}
                    </TableCell>
                    <TableCell>
                      {contact.status ? (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[contact.status] ?? 'bg-gray-100 text-gray-600'}`}>
                          {contact.status}
                        </span>
                      ) : '—'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-gray-600">
              Page {filters.page} of {totalPages} — {total.toLocaleString()} contacts
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={filters.page === 1}
                onClick={() => setFilters(f => ({ ...f, page: (f.page ?? 1) - 1 }))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={filters.page === totalPages}
                onClick={() => setFilters(f => ({ ...f, page: (f.page ?? 1) + 1 }))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
