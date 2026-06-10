'use client'

import { useEffect, useState, useCallback, CSSProperties } from 'react'
import type { Contact } from '@/types/contact'

const PAGE_SIZE = 50

const STATUS_CLASSES: Record<string, string> = {
  new: 'status-new',
  interested: 'status-interested',
  replied: 'status-replied',
  bounced: 'status-bounced',
  active: 'status-active',
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [currentPage, setCurrentPage] = useState(1)
  const [sortBy, setSortBy] = useState('email')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [searchQuery, setSearchQuery] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')

  const fetchContacts = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(currentPage))
      params.set('pageSize', String(PAGE_SIZE))
      params.set('sortBy', sortBy)
      params.set('sortDir', sortDir)
      if (searchQuery) params.set('search', searchQuery)
      if (workspaceFilter) params.set('workspace', workspaceFilter)
      if (sourceFilter) params.set('source', sourceFilter)

      const res = await fetch(`/api/contacts/search?${params}`)
      if (!res.ok) throw new Error('Failed to fetch')
      const data = await res.json()
      setContacts(data.contacts ?? [])
      setTotal(data.total ?? 0)
    } catch (err) {
      console.error('Fetch error:', err)
      setContacts([])
    } finally {
      setLoading(false)
    }
  }, [currentPage, sortBy, sortDir, searchQuery, workspaceFilter, sourceFilter])

  useEffect(() => { fetchContacts() }, [fetchContacts])

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selected.size === contacts.length && contacts.length > 0) {
      setSelected(new Set())
    } else {
      setSelected(new Set(contacts.map(c => c.id)))
    }
  }

  function handleSort(col: string) {
    if (sortBy === col) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(col)
      setSortDir('asc')
    }
    setCurrentPage(1)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const isAllSelected = selected.size > 0 && selected.size === contacts.length

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.headerTitle}>Contacts</div>
          <div style={styles.totalBadge}><span id="totalCount">{total.toLocaleString()}</span> total</div>
          <div style={styles.searchBox}>
            <div style={styles.searchIcon}>&#9906;</div>
            <input
              type="text"
              placeholder="Search email, name, company..."
              value={searchQuery}
              onChange={e => {
                setSearchQuery(e.target.value)
                setCurrentPage(1)
              }}
              style={styles.searchInput}
            />
          </div>
        </div>
        <div style={styles.headerRight}>
          <button style={{ ...styles.btn, ...styles.btnSecondary }}>⚙ Columns</button>
          <button style={{ ...styles.btn, ...styles.btnPrimary }}>Import CSV</button>
          <button style={{ ...styles.btn, ...styles.btnDanger }}>Delete from CSV</button>
          <button style={{ ...styles.btn, ...styles.btnSecondary }}>⬇ Apollo Export</button>
          <button style={{ ...styles.btn, ...styles.btnSecondary }}>↺ Reset Exports</button>
          <button style={{ ...styles.btn, ...styles.btnSecondary }}>+ Add</button>
        </div>
      </div>

      {/* Selection Bar */}
      {selected.size > 0 && (
        <div style={styles.selectionBar}>
          <span style={styles.selectionCount}><span id="pushCount">{selected.size}</span> selected</span>
          <div style={styles.selectionDivider}></div>
          <button style={{ ...styles.btn, ...styles.btnSecondary, padding: '5px 12px' }}>
            Select… (of {contacts.length})
          </button>
          <button style={{ ...styles.btn, ...styles.btnSecondary, padding: '5px 12px' }} onClick={() => setSelected(new Set())}>
            Deselect All
          </button>
          <div style={{ flex: 1 }}></div>
          <button style={{ ...styles.btn, ...styles.btnPlusVibe }}>🚀 Push to PlusVibe</button>
        </div>
      )}

      {/* Filters */}
      <div style={styles.filterBar}>
        <select
          value={workspaceFilter}
          onChange={e => {
            setWorkspaceFilter(e.target.value)
            setCurrentPage(1)
          }}
          style={styles.select}
        >
          <option value="">All workspaces</option>
          <option value="ottaly-global">Ottaly Global</option>
          <option value="uk">UK</option>
        </select>
        <select
          value={sourceFilter}
          onChange={e => {
            setSourceFilter(e.target.value)
            setCurrentPage(1)
          }}
          style={styles.select}
        >
          <option value="">All sources</option>
          <option value="apollo">Apollo</option>
          <option value="manual">Manual</option>
        </select>
      </div>

      {/* Table */}
      <div style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead style={styles.thead}>
            <tr>
              <th style={{ ...styles.th, width: 40 }}>
                <input
                  type="checkbox"
                  checked={isAllSelected}
                  onChange={toggleSelectAll}
                  style={styles.checkbox}
                />
              </th>
              <th style={{ ...styles.th, cursor: 'pointer' }} onClick={() => handleSort('email')}>
                EMAIL {sortBy === 'email' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th style={{ ...styles.th, cursor: 'pointer' }} onClick={() => handleSort('first_name')}>
                FIRST NAME {sortBy === 'first_name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th style={{ ...styles.th, cursor: 'pointer' }} onClick={() => handleSort('last_name')}>
                LAST NAME {sortBy === 'last_name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th style={{ ...styles.th, cursor: 'pointer' }} onClick={() => handleSort('company_name')}>
                COMPANY {sortBy === 'company_name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th style={{ ...styles.th, cursor: 'pointer' }} onClick={() => handleSort('job_title')}>
                JOB TITLE {sortBy === 'job_title' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th style={{ ...styles.th, cursor: 'pointer' }} onClick={() => handleSort('status')}>
                STATUS {sortBy === 'status' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
            </tr>
          </thead>
          <tbody style={styles.tbody}>
            {loading ? (
              <tr>
                <td colSpan={7} style={styles.loadingCell}>Loading contacts...</td>
              </tr>
            ) : contacts.length === 0 ? (
              <tr>
                <td colSpan={7} style={styles.emptyCell}>
                  <div style={styles.emptyState}>No contacts found</div>
                </td>
              </tr>
            ) : (
              contacts.map(contact => (
                <tr key={contact.id} style={{
                  ...styles.tr,
                  ...(selected.has(contact.id) ? styles.trSelected : {})
                }}>
                  <td style={styles.td}>
                    <input
                      type="checkbox"
                      checked={selected.has(contact.id)}
                      onChange={() => toggleSelect(contact.id)}
                      style={styles.checkbox}
                    />
                  </td>
                  <td style={{ ...styles.td, ...styles.emailCell }}>
                    {contact.email || '—'}
                  </td>
                  <td style={styles.td}>
                    {contact.first_name || '—'}
                  </td>
                  <td style={styles.td}>
                    {contact.last_name || '—'}
                  </td>
                  <td style={styles.td}>
                    {contact.company_name || '—'}
                  </td>
                  <td style={styles.td}>
                    <div>{contact.job_title || '—'}</div>
                  </td>
                  <td style={styles.td}>
                    {contact.status ? (
                      <span style={styles.statusBadge(contact.status)}>
                        {contact.status.toUpperCase()}
                      </span>
                    ) : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div style={styles.paginationBar}>
        <span style={styles.infoText}>
          Showing {contacts.length > 0 ? (currentPage - 1) * PAGE_SIZE + 1 : 0} - {Math.min(currentPage * PAGE_SIZE, total)} of {total.toLocaleString()}
        </span>
        <div style={styles.paginationButtons}>
          <button
            style={{ ...styles.paginationBtn }}
            disabled={currentPage === 1}
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
          >
            Previous
          </button>
          {totalPages > 1 && Array.from({ length: Math.min(5, totalPages) }).map((_, i) => {
            const page = i + 1
            return (
              <button
                key={page}
                style={{
                  ...styles.paginationBtn,
                  ...(currentPage === page ? styles.paginationBtnActive : {})
                }}
                onClick={() => setCurrentPage(page)}
              >
                {page}
              </button>
            )
          })}
          <button
            style={{ ...styles.paginationBtn }}
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, CSSProperties | ((s: string) => CSSProperties)> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#f8f9fa',
  } as CSSProperties,
  header: {
    padding: '16px 20px',
    background: 'white',
    borderBottom: '1px solid #e5e7eb',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
  } as CSSProperties,
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flex: 1,
  } as CSSProperties,
  headerTitle: {
    fontSize: '17px',
    fontWeight: 700,
    color: '#1a1a1a',
    whiteSpace: 'nowrap',
  } as CSSProperties,
  totalBadge: {
    background: '#f3f4f6',
    color: '#374151',
    fontSize: '12px',
    fontWeight: 600,
    padding: '3px 8px',
    borderRadius: '10px',
    whiteSpace: 'nowrap',
  } as CSSProperties,
  searchBox: {
    position: 'relative',
    flex: 1,
    maxWidth: '360px',
  } as CSSProperties,
  searchIcon: {
    position: 'absolute',
    left: '10px',
    top: '50%',
    transform: 'translateY(-50%)',
    color: '#9ca3af',
    fontSize: '14px',
  } as CSSProperties,
  searchInput: {
    width: '100%',
    padding: '8px 14px 8px 34px',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '13px',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  } as CSSProperties,
  headerRight: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    flexShrink: 0,
  } as CSSProperties,
  selectionBar: {
    display: 'flex',
    padding: '10px 20px',
    background: '#eff6ff',
    borderBottom: '1px solid #bfdbfe',
    alignItems: 'center',
    gap: '12px',
    fontSize: '13px',
  } as CSSProperties,
  selectionCount: {
    fontWeight: 600,
    color: '#1e40af',
  } as CSSProperties,
  selectionDivider: {
    width: '1px',
    height: '16px',
    background: '#93c5fd',
  } as CSSProperties,
  filterBar: {
    display: 'flex',
    gap: '8px',
    padding: '12px 20px',
    background: 'white',
    borderBottom: '1px solid #e5e7eb',
  } as CSSProperties,
  select: {
    padding: '5px 8px',
    border: '1px solid #e5e7eb',
    borderRadius: '5px',
    fontSize: '12px',
    fontFamily: 'inherit',
  } as CSSProperties,
  btn: {
    padding: '7px 10px',
    border: 'none',
    borderRadius: '5px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.2s',
    fontFamily: 'inherit',
  } as CSSProperties,
  btnPrimary: {
    background: '#3b82f6',
    color: 'white',
  } as CSSProperties,
  btnSecondary: {
    background: '#e5e7eb',
    color: '#1a1a1a',
  } as CSSProperties,
  btnDanger: {
    background: '#dc2626',
    color: 'white',
  } as CSSProperties,
  btnPlusVibe: {
    background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
    color: 'white',
  } as CSSProperties,
  tableWrapper: {
    background: 'white',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    margin: '20px',
  } as CSSProperties,
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '13px',
  } as CSSProperties,
  thead: {
    background: '#f9fafb',
    borderBottom: '1px solid #e5e7eb',
    position: 'sticky',
    top: 0,
    zIndex: 10,
  } as CSSProperties,
  th: {
    padding: '12px 16px',
    textAlign: 'left',
    fontWeight: 600,
    color: '#6b7280',
    fontSize: '12px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    userSelect: 'none',
  } as CSSProperties,
  tbody: {
    flex: 1,
    overflowY: 'auto',
  } as CSSProperties,
  td: {
    padding: '12px 16px',
    borderBottom: '1px solid #f3f4f6',
    verticalAlign: 'middle',
  } as CSSProperties,
  tr: {
    transition: 'background-color 0.15s',
  } as CSSProperties,
  trSelected: {
    background: '#eff6ff',
  } as CSSProperties,
  emailCell: {
    color: '#3b82f6',
    fontWeight: 500,
  } as CSSProperties,
  checkbox: {
    width: '18px',
    height: '18px',
    cursor: 'pointer',
    accentColor: '#3b82f6',
  } as CSSProperties,
  loadingCell: {
    padding: '60px 20px',
    color: '#6b7280',
    fontSize: '14px',
    textAlign: 'center',
  } as CSSProperties,
  emptyCell: {
    padding: '80px 20px',
  } as CSSProperties,
  emptyState: {
    textAlign: 'center',
    color: '#6b7280',
  } as CSSProperties,
  statusBadge: (status: string): CSSProperties => {
    const base: CSSProperties = {
      display: 'inline-block',
      padding: '4px 10px',
      borderRadius: '6px',
      fontSize: '11px',
      fontWeight: 600,
      textTransform: 'uppercase',
    }
    const variants: Record<string, CSSProperties> = {
      new: { ...base, background: '#dbeafe', color: '#1e40af' },
      interested: { ...base, background: '#fef3c7', color: '#92400e' },
      replied: { ...base, background: '#dcfce7', color: '#15803d' },
      bounced: { ...base, background: '#fee2e2', color: '#7f1d1d' },
      active: { ...base, background: '#d1fae5', color: '#065f46' },
    }
    return variants[status] || base
  },
  paginationBar: {
    padding: '16px 20px',
    background: '#f9fafb',
    borderTop: '1px solid #e5e7eb',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '8px',
  } as CSSProperties,
  infoText: {
    fontSize: '12px',
    color: '#6b7280',
    margin: '0 12px',
  } as CSSProperties,
  paginationButtons: {
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
  } as CSSProperties,
  paginationBtn: {
    padding: '6px 10px',
    border: '1px solid #d1d5db',
    background: 'white',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 500,
    transition: 'all 0.2s',
  } as CSSProperties,
  paginationBtnActive: {
    background: '#3b82f6',
    color: 'white',
    borderColor: '#3b82f6',
  } as CSSProperties,
}
