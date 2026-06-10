'use client'

import { useEffect, useState } from 'react'

interface SupplierStats {
  name: string
  total: number
  active: number
  broken: number
  replyRate: number
  bounceRate: number
  warmupPct: number
  authClean: number
  sentPerDay: number
  trend?: { date: string; sent: number; replyRate: number; bounceRate: number }[]
}

export default function MailboxesPage() {
  const [suppliers, setSuppliers] = useState<SupplierStats[]>([])
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<string>('')

  useEffect(() => {
    const fetch = async () => {
      try {
        const res = await fetch('/api/mailboxes/summary')
        const data = await res.json()
        setSuppliers(data.suppliers || [])
        setLastRefresh(new Date().toLocaleString('en-GB'))
      } catch (err) {
        console.error('Failed to fetch mailboxes:', err)
      } finally {
        setLoading(false)
      }
    }
    fetch()
  }, [])

  const total = suppliers.reduce((s, x) => s + x.total, 0)
  const unassigned = suppliers.find(s => !s.name || s.name === 'unassigned')?.total || 0
  const needsAttention = suppliers.reduce((s, x) => s + x.broken, 0)

  const colors: Record<string, { bg: string; border: string; text: string }> = {
    winnr: { bg: '#D1FAE5', border: '#059669', text: '#059669' },
    mithun: { bg: '#FED7AA', border: '#D97706', text: '#D97706' },
    inboxing: { bg: '#DBEAFE', border: '#0284C7', text: '#0284C7' },
    maildoso: { bg: '#E9D5FF', border: '#9333EA', text: '#9333EA' },
    default: { bg: '#F3F4F6', border: '#6B7280', text: '#6B7280' },
  }

  const getColor = (name: string) => {
    const key = name?.toLowerCase() || 'default'
    return colors[key] || colors.default
  }

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '1.5rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 700 }}>Mailboxes</h1>
          <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>
            Every sending mailbox across all clients. Assign each one a supplier and compare performance.
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: '#6B7280' }}>Last refresh: {lastRefresh}</div>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 8, padding: '7px 14px', borderRadius: 6, border: '1px solid #E2E6F0', background: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #E2E6F0', padding: '1.5rem' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#6B7280' }}>Total Mailboxes</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: 8, color: '#050C29' }}>{total.toLocaleString()}</div>
        </div>
        <div style={{ background: '#FEF3C7', borderRadius: 8, border: '1px solid #FCD34D', padding: '1.5rem' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#92400E' }}>Unassigned Supplier</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: 8, color: '#D97706' }}>{unassigned.toLocaleString()}</div>
        </div>
        <div style={{ background: '#FEE2E2', borderRadius: 8, border: '1px solid #FECACA', padding: '1.5rem' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#7F1D1D' }}>Need Attention</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: 8, color: '#DC2626' }}>{needsAttention.toLocaleString()}</div>
          <div style={{ fontSize: 11, color: '#991B1B', marginTop: 4 }}>click "Needs attention only" below</div>
        </div>
      </div>

      {/* Supplier cards */}
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: '#6B7280', marginBottom: '1rem', letterSpacing: '0.05em' }}>
          By Supplier — Who Performs Best
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: '#6B7280' }}>Loading supplier stats...</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1rem' }}>
            {suppliers.filter(s => s.name).map(supplier => {
              const c = getColor(supplier.name)
              return (
                <div key={supplier.name} style={{ background: '#fff', borderRadius: 8, border: `2px solid ${c.border}`, borderTopColor: c.border, borderTopWidth: 3, overflow: 'hidden' }}>
                  {/* Header */}
                  <div style={{ background: c.bg, padding: '1rem', borderBottom: `2px solid ${c.border}` }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: c.text, textTransform: 'uppercase' }}>
                      {supplier.name}
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: c.text }}>
                      {supplier.total.toLocaleString()}
                    </div>
                  </div>
                  {/* Stats */}
                  <div style={{ padding: '1rem' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', fontSize: 12, marginBottom: '0.75rem' }}>
                      <div>
                        <div style={{ color: '#6B7280', fontSize: 10, fontWeight: 600 }}>Active</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: '#059669' }}>{supplier.active.toLocaleString()}</div>
                      </div>
                      <div>
                        <div style={{ color: '#6B7280', fontSize: 10, fontWeight: 600 }}>Broken</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: '#DC2626' }}>{supplier.broken.toLocaleString()}</div>
                      </div>
                      <div>
                        <div style={{ color: '#6B7280', fontSize: 10, fontWeight: 600 }}>Reply Rate</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: c.text }}>{supplier.replyRate.toFixed(2)}%</div>
                      </div>
                      <div>
                        <div style={{ color: '#6B7280', fontSize: 10, fontWeight: 600 }}>Bounce Rate</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: '#DC2626' }}>{supplier.bounceRate.toFixed(2)}%</div>
                      </div>
                      <div>
                        <div style={{ color: '#6B7280', fontSize: 10, fontWeight: 600 }}>Warmup</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: '#059669' }}>{supplier.warmupPct.toFixed(0)}%</div>
                      </div>
                      <div>
                        <div style={{ color: '#6B7280', fontSize: 10, fontWeight: 600 }}>Sent/Day</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: '#6B7280' }}>{supplier.sentPerDay.toFixed(0)}</div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Legacy note */}
      <div style={{ padding: '1rem', background: '#F0F9FF', borderRadius: 8, border: '1px solid #BFDBFE', color: '#1E40AF', fontSize: 12 }}>
        ℹ️ Mailbox management (bulk assign, detailed charts) coming soon. Use <a href="https://admin.ottaly.co.uk/mailboxes" style={{ color: '#0284C7', textDecoration: 'underline' }}>admin.ottaly.co.uk</a> for full controls.
      </div>
    </div>
  )
}
        <div className="o-search-wrap">
          <span className="o-search-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <input
            type="text"
            placeholder="Search email, workspace..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select className="o-select" value={status} onChange={e => { if (e.target.value) setStatus(e.target.value) }}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="warming">Warming</option>
          <option value="paused">Paused</option>
          <option value="disconnected">Disconnected</option>
          <option value="error">Error</option>
        </select>
        {suppliers.length > 0 && (
          <select className="o-select" value={supplier} onChange={e => { if (e.target.value) setSupplier(e.target.value) }}>
            <option value="all">All suppliers</option>
            {suppliers.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )}
        {needsAttention > 0 && (
          <button className="o-btn o-btn-ghost o-btn-sm" style={{ color: '#DC2626', borderColor: '#FECACA' }} onClick={() => setStatus('disconnected')}>
            Show attention only
          </button>
        )}
      </div>

      <div className="o-card">
        <div className="o-table-wrap">
          <table className="o-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Workspace</th>
                <th>Status</th>
                <th>Supplier</th>
                <th>Warmup</th>
                <th style={{ textAlign: 'right' }}>Reply Rate</th>
                <th style={{ textAlign: 'right' }}>Bounce Rate</th>
                <th style={{ textAlign: 'right' }}>Sent (30d)</th>
                <th style={{ textAlign: 'right' }}>Daily Limit</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <td key={j}><span className="o-spin" /></td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9}><div className="o-empty">No mailboxes found</div></td>
                </tr>
              ) : (
                filtered.map(m => {
                  const rr = m.stats?.replyRate ?? 0
                  const br = m.stats?.bounceRate ?? 0
                  const rrClass = rr >= 0.025 ? '#059669' : rr >= 0.01 ? '#D97706' : rr > 0 ? '#DC2626' : '#9CA3AF'
                  const brClass = br >= 0.05 ? '#DC2626' : br >= 0.02 ? '#D97706' : '#059669'
                  return (
                    <tr key={m.id}>
                      <td style={{ fontFamily: 'monospace' }}>{m.email}</td>
                      <td style={{ color: '#6B7280' }}>{m.workspace_name ?? '—'}</td>
                      <td>
                        <span className={STATUS_MAP[m.status] ?? 'o-status o-status-unknown'}>
                          {m.status}
                        </span>
                      </td>
                      <td>{m.supplier ?? '—'}</td>
                      <td>
                        {m.warmup_enabled ? (
                          <span style={{ color: '#16A34A' }}>
                            On {m.warmup_score != null ? `(${m.warmup_score})` : ''}
                          </span>
                        ) : (
                          <span style={{ color: '#9CA3AF' }}>Off</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', color: rrClass, fontWeight: m.stats ? 600 : 400 }}>
                        {m.stats ? (rr * 100).toFixed(1) + '%' : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: brClass, fontWeight: m.stats ? 600 : 400 }}>
                        {m.stats ? (br * 100).toFixed(1) + '%' : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: '#6B7280' }}>
                        {m.stats ? m.stats.sent.toLocaleString() : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: '#6B7280' }}>{m.daily_limit ?? '—'}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
