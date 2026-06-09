'use client'

import { useEffect, useState } from 'react'

interface WorkloadRow { workspace_id: string; workspace_name: string; status: string; leads_30d: number; leads_90d: number; reply_rate_30d: number; mailbox_count: number; sent_30d: number; lpt_30d: number; lead_target: number }

function pct(v: number | null) { return v != null ? `${Number(v).toFixed(1)}%` : '—' }

export default function WorkloadPage() {
  const [rows, setRows] = useState<WorkloadRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/workload').then(r => r.json()).then(d => setRows(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const totalLeads = rows.reduce((s, r) => s + (r.leads_30d ?? 0), 0)

  return (
    <div className="o-page">
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Workload</div>
          <div className="o-page-sub">{rows.length} workspaces · {totalLeads} leads this month</div>
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
                  <th>Leads 30d</th>
                  <th>Leads 90d</th>
                  <th>Target</th>
                  <th>Reply % 30d</th>
                  <th>LPT 30d</th>
                  <th>Mailboxes</th>
                  <th>Sent 30d</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i}>
                        {Array.from({ length: 9 }).map((_, j) => (
                          <td key={j}><span className="o-spin" /></td>
                        ))}
                      </tr>
                    ))
                  : rows.length === 0
                    ? <tr><td colSpan={9}><div className="o-empty">No data</div></td></tr>
                    : rows.map(r => (
                        <tr key={r.workspace_id}>
                          <td style={{ fontWeight: 500 }}>{r.workspace_name}</td>
                          <td>
                            <span className={`o-status ${r.status === 'active' ? 'o-status-active' : 'o-status-inactive'}`}>{r.status ?? '—'}</span>
                          </td>
                          <td style={{ fontWeight: 600, color: '#224388' }}>{r.leads_30d ?? '—'}</td>
                          <td>{r.leads_90d ?? '—'}</td>
                          <td style={{ color: '#6B7280' }}>{r.lead_target ?? '—'}</td>
                          <td>{pct(r.reply_rate_30d)}</td>
                          <td>{r.lpt_30d != null ? Number(r.lpt_30d).toFixed(1) : '—'}</td>
                          <td>{r.mailbox_count ?? '—'}</td>
                          <td>{r.sent_30d?.toLocaleString() ?? '—'}</td>
                        </tr>
                      ))
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
