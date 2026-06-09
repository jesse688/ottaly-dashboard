'use client'

import { useEffect, useState } from 'react'

interface CapacityRow { workspace_id: string; workspace_name: string; mailbox_count: number; avg_daily_per_mailbox: number; monthly_capacity: number; sent_30d: number; avg_monthly_sends: number; contacts_total: number; client_status: string }

export default function CapacityPage() {
  const [rows, setRows] = useState<CapacityRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/capacity').then(r => r.json()).then(d => setRows(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const totalMailboxes = rows.reduce((s, r) => s + (r.mailbox_count ?? 0), 0)
  const totalCapacity = rows.reduce((s, r) => s + (r.monthly_capacity ?? 0), 0)

  return (
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Capacity</div>
          <div className="o-page-sub">{totalMailboxes.toLocaleString()} mailboxes · {totalCapacity.toLocaleString()} monthly capacity</div>
        </div>
      </div>
      <div className="o-card">
        <div className="o-card-body">
          <div className="o-table-wrap">
            <table className="o-table">
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th>Status</th>
                  <th>Mailboxes</th>
                  <th>Avg Daily/Box</th>
                  <th>Monthly Capacity</th>
                  <th>Sent 30d</th>
                  <th>Utilisation</th>
                  <th>Contacts</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i}>
                        {Array.from({ length: 8 }).map((_, j) => (
                          <td key={j}><span className="o-spin" /></td>
                        ))}
                      </tr>
                    ))
                  : rows.map(r => {
                      const util = r.monthly_capacity > 0 ? (r.sent_30d ?? 0) / r.monthly_capacity : 0
                      return (
                        <tr key={r.workspace_id}>
                          <td style={{ fontWeight: 500 }}>{r.workspace_name}</td>
                          <td>
                            <span className={r.client_status === 'active' ? 'o-status o-status-active' : 'o-status o-status-inactive'}>
                              {r.client_status ?? '—'}
                            </span>
                          </td>
                          <td>{r.mailbox_count ?? '—'}</td>
                          <td>{r.avg_daily_per_mailbox != null ? Number(r.avg_daily_per_mailbox).toFixed(0) : '—'}</td>
                          <td>{r.monthly_capacity?.toLocaleString() ?? '—'}</td>
                          <td>{r.sent_30d?.toLocaleString() ?? '—'}</td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 64, background: '#E2E6F0', borderRadius: 999, height: 6, flexShrink: 0 }}>
                                <div
                                  style={{
                                    height: 6,
                                    borderRadius: 999,
                                    width: `${Math.min(100, util * 100)}%`,
                                    background: util > 0.8 ? '#16A34A' : util > 0.4 ? '#D97706' : '#6B7280',
                                  }}
                                />
                              </div>
                              <span style={{ fontSize: 12, color: '#6B7280' }}>{(util * 100).toFixed(0)}%</span>
                            </div>
                          </td>
                          <td>{r.contacts_total?.toLocaleString() ?? '—'}</td>
                        </tr>
                      )
                    })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
