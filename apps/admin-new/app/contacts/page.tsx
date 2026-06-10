'use client'

import { useEffect, useState, useCallback } from 'react'
import type { Contact, ContactFilters } from '@/types/contact'

const PAGE_SIZE = 50

const STATUS_CLASS: Record<string, string> = {
  verified: 'o-status o-status-good',
  bounced: 'o-status o-status-critical',
  unverified: 'o-status o-status-unknown',
  lead: 'o-status o-status-active',
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
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

  function toggleSelect(id: string) {
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
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Contacts</div>
          <div className="o-page-sub">{total.toLocaleString()} total</div>
        </div>
        {selected.size > 0 && (
          <div className="o-page-actions">
            <span style={{ fontSize: 13, color: '#6B7280' }}>{selected.size} selected</span>
            <button className="o-btn o-btn-ghost o-btn-sm">Export to Apollo</button>
            <button className="o-btn o-btn-ghost o-btn-sm">Add to Campaign</button>
          </div>
        )}
      </div>

      <div className="o-toolbar">
        <div className="o-search-wrap">
          <span className="o-search-icon">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10.293 10.293a1 1 0 011.414 0l2 2a1 1 0 01-1.414 1.414l-2-2a1 1 0 010-1.414z" fill="currentColor"/>
              <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            </svg>
          </span>
          <input
            type="text"
            placeholder="Search email, name, company..."
            value={filters.search ?? ''}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value, page: 1 }))}
          />
        </div>
        <select
          className="o-select"
          value={filters.status ?? 'all'}
          onChange={e => setFilters(f => ({ ...f, status: e.target.value === 'all' ? undefined : e.target.value, page: 1 } as ContactFilters))}
        >
          <option value="all">All statuses</option>
          <option value="verified">Verified</option>
          <option value="unverified">Unverified</option>
          <option value="bounced">Bounced</option>
          <option value="lead">Lead</option>
        </select>
        <select
          className="o-select"
          value={filters.country ?? 'all'}
          onChange={e => setFilters(f => ({ ...f, country: e.target.value === 'all' ? undefined : e.target.value, page: 1 } as ContactFilters))}
        >
          <option value="all">All countries</option>
          <option value="United Kingdom">United Kingdom</option>
          <option value="United States">United States</option>
          <option value="Australia">Australia</option>
          <option value="Canada">Canada</option>
        </select>
        {(filters.search || filters.status || filters.country) && (
          <button
            className="o-btn o-btn-ghost o-btn-sm"
            onClick={() => setFilters(f => ({ ...f, search: undefined, status: undefined, country: undefined, page: 1 }))}
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="o-table-wrap">
        <table className="o-table">
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <input
                  type="checkbox"
                  checked={selected.size === contacts.length && contacts.length > 0}
                  onChange={toggleAll}
                />
              </th>
              <th style={{ cursor: 'pointer' }} onClick={() => setSort('email')}>
                Email {filters.sortBy === 'email' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th style={{ cursor: 'pointer' }} onClick={() => setSort('first_name')}>
                Name {filters.sortBy === 'first_name' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th style={{ cursor: 'pointer' }} onClick={() => setSort('company_name')}>
                Company {filters.sortBy === 'company_name' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th style={{ cursor: 'pointer' }} onClick={() => setSort('job_title')}>
                Title {filters.sortBy === 'job_title' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th>Location</th>
              <th style={{ cursor: 'pointer' }} onClick={() => setSort('status')}>
                Status {filters.sortBy === 'status' ? (filters.sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 10 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j}>
                      <span className="o-spin" />
                    </td>
                  ))}
                </tr>
              ))
            ) : contacts.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <div className="o-empty">No contacts found</div>
                </td>
              </tr>
            ) : (
              contacts.map(contact => (
                <tr key={contact.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(contact.id)}
                      onChange={() => toggleSelect(contact.id)}
                    />
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{contact.email}</td>
                  <td>
                    {[contact.first_name, contact.last_name].filter(Boolean).join(' ') || '—'}
                  </td>
                  <td>{contact.company_name ?? '—'}</td>
                  <td>
                    <div>{contact.job_title ?? '—'}</div>
                    {contact.seniority && (
                      <div style={{ fontSize: 12, color: '#6B7280' }}>{contact.seniority}</div>
                    )}
                  </td>
                  <td style={{ fontSize: 13, color: '#6B7280' }}>
                    {[contact.city, contact.country].filter(Boolean).join(', ') || '—'}
                  </td>
                  <td>
                    {contact.status ? (
                      <span className={STATUS_CLASS[contact.status] ?? 'o-status o-status-unknown'}>
                        {contact.status}
                      </span>
                    ) : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
          <span style={{ fontSize: 13, color: '#6B7280' }}>
            Page {filters.page} of {totalPages} — {total.toLocaleString()} contacts
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="o-btn o-btn-ghost o-btn-sm"
              disabled={filters.page === 1}
              onClick={() => setFilters(f => ({ ...f, page: (f.page ?? 1) - 1 }))}
            >
              Previous
            </button>
            <button
              className="o-btn o-btn-ghost o-btn-sm"
              disabled={filters.page === totalPages}
              onClick={() => setFilters(f => ({ ...f, page: (f.page ?? 1) + 1 }))}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
