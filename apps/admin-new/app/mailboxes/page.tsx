'use client'

import { useEffect, useState } from 'react'
import type { Mailbox } from '@/types/mailbox'

const STATUS_MAP: Record<string, string> = {
  active: 'o-status o-status-active',
  disconnected: 'o-status o-status-critical',
  warming: 'o-status o-status-warning',
  paused: 'o-status o-status-inactive',
  error: 'o-status o-status-critical',
}

export default function MailboxesPage() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [filtered, setFiltered] = useState<Mailbox[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [supplier, setSupplier] = useState('all')

  useEffect(() => {
    fetch('/api/mailboxes')
      .then(r => r.json())
      .then(d => setMailboxes(Array.isArray(d) ? d : d.mailboxes ?? []))
      .catch(() => setMailboxes([]))
      .finally(() => setLoading(false))
  }, [])

  const suppliers = [...new Set(mailboxes.map(m => m.supplier).filter(Boolean))] as string[]

  useEffect(() => {
    let result = [...mailboxes]
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(m =>
        m.email.toLowerCase().includes(q) ||
        (m.workspace_name ?? '').toLowerCase().includes(q)
      )
    }
    if (status !== 'all') result = result.filter(m => m.status === status)
    if (supplier !== 'all') result = result.filter(m => m.supplier === supplier)
    setFiltered(result)
  }, [mailboxes, search, status, supplier])

  const needsAttention = filtered.filter(m => m.status === 'disconnected' || m.status === 'error').length

  return (
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Mailboxes</div>
          <div className="o-page-sub">
            {filtered.length} mailboxes
            {needsAttention > 0 && (
              <span style={{ marginLeft: 8, color: '#DC2626', fontWeight: 500 }}>· {needsAttention} need attention</span>
            )}
          </div>
        </div>
      </div>

      <div className="o-toolbar">
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
                <th>Sent Today</th>
                <th>Daily Limit</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j}><span className="o-spin" /></td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7}><div className="o-empty">No mailboxes found</div></td>
                </tr>
              ) : (
                filtered.map(m => (
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
                    <td>{m.sent_today ?? '—'}</td>
                    <td>{m.daily_limit ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
