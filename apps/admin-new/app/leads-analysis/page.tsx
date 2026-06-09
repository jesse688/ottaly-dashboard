'use client'

import { useEffect, useState } from 'react'

interface Lead { workspace_id: string; workspace_name: string; lead_email: string; first_name: string; last_name: string; campaign: string; lead_price: number; date: string; label: string }

const LABEL_COLORS: Record<string, { background: string; color: string }> = {
  INTERESTED: { background: '#dcfce7', color: '#166534' },
  LEAD: { background: '#dbeafe', color: '#1d4ed8' },
  MEETING_BOOKED: { background: '#f3e8ff', color: '#7e22ce' },
  NOT_INTERESTED: { background: '#f3f4f6', color: '#4b5563' },
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
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Leads Analysis</div>
          <div className="o-page-sub">{filtered.length.toLocaleString()} leads</div>
        </div>
      </div>
      <div className="o-card">
        <div className="o-card-body" style={{ padding: 0 }}>
          <div className="o-toolbar">
            <div className="o-search-wrap">
              <span className="o-search-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </span>
              <input type="text" placeholder="Search email, campaign..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <select className="o-select" value={workspace} onChange={e => setWorkspace(e.target.value)}>
              <option value="all">All workspaces</option>
              {workspaces.map(w => <option key={w} value={w}>{w}</option>)}
            </select>
            <select className="o-select" value={label} onChange={e => setLabel(e.target.value)}>
              <option value="all">All labels</option>
              {labels.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div className="o-table-wrap">
            <table className="o-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Workspace</th>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Campaign</th>
                  <th>Label</th>
                  <th>Price</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 7 }).map((_, j) => (
                        <td key={j}><span className="o-spin" /></td>
                      ))}
                    </tr>
                  ))
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={7}><div className="o-empty">No leads found</div></td></tr>
                ) : (
                  filtered.map((l, i) => (
                    <tr key={i}>
                      <td style={{ color: '#6B7280' }}>{new Date(l.date).toLocaleDateString('en-GB')}</td>
                      <td>{l.workspace_name}</td>
                      <td><code style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{l.lead_email}</code></td>
                      <td>{[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}</td>
                      <td style={{ color: '#6B7280', maxWidth: '16rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.campaign}</td>
                      <td>
                        <span style={{
                          fontSize: '0.75rem',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontWeight: 500,
                          background: (LABEL_COLORS[l.label] ?? { background: '#f3f4f6', color: '#4b5563' }).background,
                          color: (LABEL_COLORS[l.label] ?? { background: '#f3f4f6', color: '#4b5563' }).color,
                        }}>{l.label}</span>
                      </td>
                      <td style={{ fontWeight: 500 }}>£{parseFloat(String(l.lead_price ?? 0)).toFixed(0)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
