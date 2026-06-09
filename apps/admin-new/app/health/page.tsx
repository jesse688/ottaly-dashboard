'use client'

import { useEffect, useState } from 'react'

interface HealthRow {
  workspace_id: string
  workspace_name: string | null
  health_score: number
  health_band: 'green' | 'amber' | 'red' | 'na'
  sent_7d: number
  sent_30d: number
  replies_30d: number
  leads_30d: number
  reply_rate_30d: number | null
  bounce_rate_7d: number | null
  mailbox_total: number
  mailbox_unhealthy: number
  snapshot_date: string
  briefing?: string
  signals?: Record<string, number | string>
  campaign_manager?: string
}

export default function HealthPage() {
  const [rows, setRows] = useState<HealthRow[]>([])
  const [filtered, setFiltered] = useState<HealthRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(d => setRows(Array.isArray(d) ? d : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!search) { setFiltered(rows); return }
    const q = search.toLowerCase()
    setFiltered(rows.filter(r => (r.workspace_name ?? '').toLowerCase().includes(q)))
  }, [rows, search])

  const redCount = filtered.filter(r => r.health_band === 'red').length
  const amberCount = filtered.filter(r => r.health_band === 'amber').length
  const greenCount = filtered.filter(r => r.health_band === 'green').length
  const avgScore = filtered.length
    ? Math.round(filtered.reduce((s, r) => s + r.health_score, 0) / filtered.length)
    : 0

  const bandColor = (band: string) => {
    if (band === 'red') return { border: '#DC2626', bg: '#FEE2E2' }
    if (band === 'amber') return { border: '#D97706', bg: '#FEF3C7' }
    if (band === 'green') return { border: '#059669', bg: '#D1FAE5' }
    return { border: '#E2E6F0', bg: '#F9FAFB' }
  }

  const scoreColor = (band: string) => {
    if (band === 'red') return '#DC2626'
    if (band === 'amber') return '#D97706'
    if (band === 'green') return '#059669'
    return '#6B7280'
  }

  return (
    <div style={{ padding: '1.75rem', maxWidth: '1280px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '1.5rem', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, letterSpacing: '-0.01em' }}>Health</h1>
          <div style={{ fontSize: '13px', color: '#6B7280', marginTop: '4px' }}>Daily AI-powered briefings per client</div>
        </div>
      </div>

      {/* Summary stripe */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.85rem', marginBottom: '1.5rem' }}>
        <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '10px', padding: '0.85rem 1rem', borderTop: '3px solid #050C29' }}>
          <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>Avg Score</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, marginTop: '2px' }}>{avgScore}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '10px', padding: '0.85rem 1rem', borderTop: '3px solid #059669' }}>
          <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>Healthy</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, marginTop: '2px', color: '#059669' }}>{greenCount}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '10px', padding: '0.85rem 1rem', borderTop: '3px solid #D97706' }}>
          <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>Warning</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, marginTop: '2px', color: '#D97706' }}>{amberCount}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '10px', padding: '0.85rem 1rem', borderTop: '3px solid #DC2626' }}>
          <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>Critical</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, marginTop: '2px', color: '#DC2626' }}>{redCount}</div>
        </div>
      </div>

      {/* Search */}
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ position: 'relative', display: 'inline-block', width: '100%', maxWidth: '400px' }}>
          <input
            type="text"
            placeholder="Search workspace..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px 8px 36px',
              border: '1px solid #E2E6F0',
              borderRadius: '8px',
              fontSize: '13px',
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: 'absolute', left: '10px', top: '10px', color: '#9CA3AF' }}>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
      </div>

      {/* Client cards */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: '#6B7280', fontSize: '13px' }}>Loading health data…</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: '#6B7280', fontSize: '13px' }}>No workspaces found</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {filtered.map(ws => {
            const colors = bandColor(ws.health_band)
            const scoreCol = scoreColor(ws.health_band)
            const replyRate = ws.reply_rate_30d ? (ws.reply_rate_30d * 100).toFixed(1) : '—'
            const bounceRate = ws.bounce_rate_7d ? (ws.bounce_rate_7d * 100).toFixed(1) : '—'

            return (
              <div
                key={ws.workspace_id}
                style={{
                  background: '#fff',
                  border: `1px solid ${colors.border}`,
                  borderLeft: `4px solid ${colors.border}`,
                  borderRadius: '12px',
                  overflow: 'hidden',
                }}
              >
                {/* Card header */}
                <div style={{ padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{ws.workspace_name || ws.workspace_id}</div>
                    {ws.campaign_manager && <div style={{ fontSize: '11.5px', color: '#6B7280', marginTop: '1px' }}>Manager: {ws.campaign_manager}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                    <div style={{ fontSize: '1.75rem', fontWeight: 800, color: scoreCol }}>{Math.round(ws.health_score)}</div>
                    <div style={{ fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', padding: '3px 8px', borderRadius: '6px', background: colors.bg, color: colors.border }}>
                      {ws.health_band}
                    </div>
                  </div>
                </div>

                {/* Briefing */}
                {ws.briefing && (
                  <div style={{ padding: '0 1.25rem' }}>
                    <div style={{ fontSize: '13.5px', lineHeight: 1.6, color: '#050C29', padding: '1rem 1.15rem', background: '#FAFBFF', border: '1px solid #E2E6F0', borderRadius: '10px', marginBottom: '0.85rem' }}>
                      {ws.briefing}
                      <span style={{ display: 'block', marginTop: '0.5rem', fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280', fontWeight: 600 }}>
                        AI-generated summary
                      </span>
                    </div>
                  </div>
                )}

                {/* Signals grid */}
                <div style={{ padding: '0 1.25rem 1.25rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.65rem' }}>
                    <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '8px', padding: '0.65rem 0.75rem' }}>
                      <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280' }}>Sent (30d)</div>
                      <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '1px' }}>{ws.sent_30d.toLocaleString()}</div>
                    </div>
                    <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '8px', padding: '0.65rem 0.75rem' }}>
                      <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280' }}>Reply Rate</div>
                      <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '1px' }}>{replyRate}%</div>
                    </div>
                    <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '8px', padding: '0.65rem 0.75rem' }}>
                      <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280' }}>Bounce Rate</div>
                      <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '1px' }}>{bounceRate}%</div>
                    </div>
                    <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '8px', padding: '0.65rem 0.75rem' }}>
                      <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280' }}>Leads (30d)</div>
                      <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '1px' }}>{ws.leads_30d.toLocaleString()}</div>
                    </div>
                    <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '8px', padding: '0.65rem 0.75rem' }}>
                      <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280' }}>Mailboxes</div>
                      <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '1px' }}>{ws.mailbox_total}</div>
                    </div>
                    <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '8px', padding: '0.65rem 0.75rem' }}>
                      <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280' }}>Unhealthy</div>
                      <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '1px', color: ws.mailbox_unhealthy > 0 ? '#DC2626' : '#059669' }}>
                        {ws.mailbox_unhealthy}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
