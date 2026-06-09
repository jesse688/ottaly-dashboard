'use client'

import { useEffect, useState } from 'react'

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
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Revenue</div>
          <div className="o-page-sub">{totalLeads} leads · £{totalRevenue.toLocaleString('en-GB', { maximumFractionDigits: 0 })} total</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #E2E6F0', marginBottom: '1.25rem' }}>
        {(['summary', 'leads'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '0.625rem 1rem',
              fontSize: '0.875rem',
              fontWeight: 500,
              border: 'none',
              borderBottom: tab === t ? '2px solid #224388' : '2px solid transparent',
              background: 'none',
              color: tab === t ? '#224388' : '#6B7280',
              cursor: 'pointer',
              textTransform: 'capitalize',
              marginBottom: '-1px',
            }}
          >{t}</button>
        ))}
      </div>

      {tab === 'leads' && (
        <div className="o-toolbar" style={{ marginBottom: '1rem' }}>
          <div className="o-search-wrap">
            <span className="o-search-icon">
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M10 6.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Zm-.747 3.56a4.5 4.5 0 1 1 .707-.707l2.844 2.843a.5.5 0 1 1-.708.708L9.253 10.06Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd"/>
              </svg>
            </span>
            <input type="text" placeholder="Search email, workspace, campaign..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      )}

      <div className="o-card">
        <div className="o-table-wrap">
          {tab === 'summary' ? (
            <table className="o-table">
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th>Leads</th>
                  <th>Revenue</th>
                  <th>Avg / Lead</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 4 }).map((_, j) => (
                        <td key={j}><span className="o-spin" /></td>
                      ))}
                    </tr>
                  ))
                  : summary.sort((a, b) => b.revenue - a.revenue).map(s => (
                    <tr key={s.workspace_id}>
                      <td style={{ fontWeight: 500 }}>{s.name}</td>
                      <td>{s.leads}</td>
                      <td style={{ fontWeight: 600, color: '#16A34A' }}>£{s.revenue.toLocaleString('en-GB', { maximumFractionDigits: 0 })}</td>
                      <td style={{ color: '#6B7280' }}>£{s.leads > 0 ? (s.revenue / s.leads).toFixed(0) : 0}</td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          ) : (
            <table className="o-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Workspace</th>
                  <th>Email</th>
                  <th>Campaign</th>
                  <th>Label</th>
                  <th>Price</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 6 }).map((_, j) => (
                        <td key={j}><span className="o-spin" /></td>
                      ))}
                    </tr>
                  ))
                  : filtered.map((l, i) => (
                    <tr key={i}>
                      <td style={{ color: '#6B7280' }}>{new Date(l.date).toLocaleDateString('en-GB')}</td>
                      <td>{l.workspace_name}</td>
                      <td><code style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{l.lead_email}</code></td>
                      <td style={{ color: '#374151', maxWidth: '16rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.campaign}</td>
                      <td><span className="o-status o-status-active">{l.label}</span></td>
                      <td style={{ fontWeight: 500 }}>£{parseFloat(String(l.lead_price)).toFixed(0)}</td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
