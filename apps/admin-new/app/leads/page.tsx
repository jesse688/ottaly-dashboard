'use client'

import { useEffect, useState, useCallback } from 'react'

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

const LABEL_STYLES: Record<string, React.CSSProperties> = {
  INTERESTED: { background: '#dcfce7', color: '#166534' },
  MEETING_BOOKED: { background: '#ede9fe', color: '#6d28d9' },
  NOT_INTERESTED: { background: '#f3f4f6', color: '#6B7280' },
  OUT_OF_OFFICE: { background: '#fef9c3', color: '#92400e' },
}

export default function LeadsPage() {
  const [data, setData] = useState<LeadsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [workspaceId, setWorkspaceId] = useState('all')
  const [label, setLabel] = useState('all')
  const [page, setPage] = useState(1)

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
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Leads</div>
          <div className="o-page-sub">{data?.total.toLocaleString() ?? '—'} leads from PlusVibe</div>
        </div>
      </div>

      <div className="o-toolbar">
        <div className="o-search-wrap">
          <span className="o-search-icon">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10.344 10.344a6 6 0 1 0-.707.707l3.656 3.656.707-.707-3.656-3.656zm-4.344 1.156a5 5 0 1 1 0-10 5 5 0 0 1 0 10z" fill="currentColor" />
            </svg>
          </span>
          <input
            type="text"
            placeholder="Search email, name, company..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select
          className="o-select"
          value={label}
          onChange={e => { setLabel(e.target.value); setPage(1) }}
        >
          <option value="all">All labels</option>
          <option value="INTERESTED">Interested</option>
          <option value="MEETING_BOOKED">Meeting Booked</option>
          <option value="NOT_INTERESTED">Not Interested</option>
          <option value="OUT_OF_OFFICE">Out of Office</option>
        </select>
      </div>

      <div className="o-card">
        <div className="o-table-wrap">
          <table className="o-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Company</th>
                <th>Label</th>
                <th>First Replied</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j}><span className="o-spin" /></td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6}><div className="o-empty">No leads found</div></td>
                </tr>
              ) : filtered.map(l => (
                <tr key={l.id}>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{l.email}</td>
                  <td>{[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}</td>
                  <td style={{ color: '#6B7280' }}>{l.company_name ?? '—'}</td>
                  <td>
                    {l.label ? (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 500,
                          padding: '2px 6px',
                          borderRadius: 4,
                          ...(LABEL_STYLES[l.label] ?? { background: '#f3f4f6', color: '#6B7280' }),
                        }}
                      >
                        {l.label}
                      </span>
                    ) : '—'}
                  </td>
                  <td style={{ color: '#6B7280', fontSize: 12 }}>
                    {l.first_replied_at ? new Date(l.first_replied_at).toLocaleDateString('en-GB') : '—'}
                  </td>
                  <td style={{ color: '#6B7280', fontSize: 12 }}>
                    {l.created_at ? new Date(l.created_at).toLocaleDateString('en-GB') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
          <span style={{ fontSize: 13, color: '#6B7280' }}>Page {page} of {totalPages} · {data?.total.toLocaleString()} total</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="o-btn o-btn-ghost o-btn-sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</button>
            <button className="o-btn o-btn-ghost o-btn-sm" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        </div>
      )}
    </div>
  )
}
