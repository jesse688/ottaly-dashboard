'use client'

import { useEffect, useState } from 'react'

interface HealthSnapshot {
  workspace_id: string
  workspace_name: string
  health_score: number
  health_band: 'green' | 'amber' | 'red' | 'na'
  campaign_manager?: string
  sent_7d: number
  replies_7d: number
  reply_rate_7d: number | null
  bounce_rate_7d: number | null
  leads_7d: number
  mailbox_total: number
  mailbox_unhealthy: number
  ai_briefing?: string
}

interface HealthClient {
  workspace_id: string
  workspace_name: string
  campaign_manager?: string
  snapshot?: HealthSnapshot
  has_data: boolean
}

export default function HealthPage() {
  const [clients, setClients] = useState<HealthClient[]>([])
  const [filtered, setFiltered] = useState<HealthClient[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/health/clients')
      .then(r => r.json())
      .then(d => {
        const cs = d.clients || []
        setClients(cs)
        setFiltered(cs)
      })
      .catch(() => {
        setClients([])
        setFiltered([])
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!search) {
      setFiltered(clients)
      return
    }
    const q = search.toLowerCase()
    setFiltered(clients.filter(c => (c.workspace_name ?? '').toLowerCase().includes(q)))
  }, [clients, search])

  const healthyCount = filtered.filter(c => c.snapshot?.health_band === 'green').length
  const warningCount = filtered.filter(c => c.snapshot?.health_band === 'amber').length
  const criticalCount = filtered.filter(c => c.snapshot?.health_band === 'red').length

  const bandTailwind = (band: string | undefined) => {
    if (band === 'red') return 'band-red'
    if (band === 'amber') return 'band-amber'
    if (band === 'green') return 'band-green'
    return 'band-na'
  }

  const bandBgColor = (band: string | undefined) => {
    if (band === 'red') return '#FEE2E2'
    if (band === 'amber') return '#FEF3C7'
    if (band === 'green') return '#D1FAE5'
    return '#F9FAFB'
  }

  const bandTextColor = (band: string | undefined) => {
    if (band === 'red') return '#DC2626'
    if (band === 'amber') return '#D97706'
    if (band === 'green') return '#059669'
    return '#6B7280'
  }

  const scoreTextColor = (band: string | undefined) => {
    if (band === 'red') return '#DC2626'
    if (band === 'amber') return '#D97706'
    if (band === 'green') return '#059669'
    return '#6B7280'
  }

  const bandLabel = (band: string | undefined) => {
    const labels: Record<string, string> = {
      red: 'Critical',
      amber: 'Watch',
      green: 'Healthy',
      na: 'No data',
    }
    return labels[band || 'na'] || band || 'No data'
  }

  return (
    <div className="min-h-screen" style={{ background: '#F0F2F8' }}>
      <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '1.75rem' }}>
        {/* Header */}
        <div style={{ marginBottom: '1.5rem' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, letterSpacing: '-0.01em', color: '#050C29' }}>Health</h1>
          <div style={{ fontSize: '13px', color: '#6B7280', marginTop: '4px' }}>Daily AI-powered briefings per client</div>
        </div>

        {/* Summary stripe */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.85rem', marginBottom: '1.5rem' }}>
          <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '10px', padding: '0.85rem 1rem', borderTop: '3px solid #050C29' }}>
            <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>Healthy</div>
            <div style={{ fontSize: '1.35rem', fontWeight: 700, marginTop: '2px', color: '#059669' }}>{healthyCount}</div>
          </div>
          <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '10px', padding: '0.85rem 1rem', borderTop: '3px solid #D97706' }}>
            <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>Warning</div>
            <div style={{ fontSize: '1.35rem', fontWeight: 700, marginTop: '2px', color: '#D97706' }}>{warningCount}</div>
          </div>
          <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '10px', padding: '0.85rem 1rem', borderTop: '3px solid #DC2626' }}>
            <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6B7280' }}>Critical</div>
            <div style={{ fontSize: '1.35rem', fontWeight: 700, marginTop: '2px', color: '#DC2626' }}>{criticalCount}</div>
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
                backgroundColor: '#fff',
              }}
            />
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: 'absolute', left: '10px', top: '10px', color: '#9CA3AF' }}>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>
        </div>

        {/* Section heading */}
        <div style={{ fontSize: '11.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: '#6B7280', margin: '1.5rem 0 0.65rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          Clients
          <span style={{ background: '#fff', color: '#050C29', border: '1px solid #E2E6F0', fontWeight: 700, fontSize: '11px', padding: '1px 7px', borderRadius: '20px' }}>
            {filtered.length}
          </span>
        </div>

        {/* Cards grid */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: '#6B7280', fontSize: '13px' }}>Loading health data…</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: '#6B7280', fontSize: '13px' }}>No workspaces found</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {filtered.map(c => {
              const snap = c.snapshot
              const band = snap?.health_band || 'na'
              const borderColor = snap ? bandTextColor(snap.health_band) : '#E2E6F0'
              const bgColor = snap ? bandBgColor(snap.health_band) : '#F9FAFB'
              const scoreColor = snap ? scoreTextColor(snap.health_band) : '#6B7280'

              if (!snap) {
                return (
                  <div
                    key={c.workspace_id}
                    style={{
                      background: '#fff',
                      border: `1px solid #E2E6F0`,
                      borderLeft: `4px solid #E2E6F0`,
                      borderRadius: '12px',
                      overflow: 'hidden',
                    }}
                  >
                    <div style={{ padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#050C29' }}>{c.workspace_name}</div>
                        {c.campaign_manager && <div style={{ fontSize: '11.5px', color: '#6B7280', marginTop: '1px' }}>Manager: {c.campaign_manager}</div>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                        <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#6B7280' }}>—</div>
                        <span style={{ fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', padding: '3px 8px', borderRadius: '6px', background: '#F9FAFB', color: '#6B7280' }}>
                          No data
                        </span>
                      </div>
                    </div>
                    <div style={{ padding: '1rem 1.25rem', fontSize: '13px', color: '#6B7280', fontStyle: 'italic' }}>
                      No snapshot yet. The first daily build runs ~2 minutes after the server starts and then every morning at 7am.
                    </div>
                  </div>
                )
              }

              return (
                <div
                  key={c.workspace_id}
                  style={{
                    background: '#fff',
                    border: `1px solid ${borderColor}`,
                    borderLeft: `4px solid ${borderColor}`,
                    borderRadius: '12px',
                    overflow: 'hidden',
                  }}
                >
                  {/* Card header */}
                  <div style={{ padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#050C29' }}>{c.workspace_name}</div>
                      {c.campaign_manager && <div style={{ fontSize: '11.5px', color: '#6B7280', marginTop: '1px' }}>Manager: {c.campaign_manager}</div>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                      <div style={{ fontSize: '1.75rem', fontWeight: 800, color: scoreColor, fontVariantNumeric: 'tabular-nums' }}>
                        {Math.round(snap.health_score)}
                      </div>
                      <span style={{ fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', padding: '3px 8px', borderRadius: '6px', background: bgColor, color: borderColor }}>
                        {bandLabel(snap.health_band)}
                      </span>
                    </div>
                  </div>

                  {/* Briefing */}
                  {snap.ai_briefing && (
                    <div style={{ padding: '0 1.25rem' }}>
                      <div style={{ fontSize: '13.5px', lineHeight: 1.6, color: '#050C29', padding: '1rem 1.15rem', background: '#FAFBFF', border: '1px solid #E2E6F0', borderRadius: '10px', marginBottom: '0.85rem' }}>
                        {snap.ai_briefing}
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
                        <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280' }}>Sent (7d)</div>
                        <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '1px', fontVariantNumeric: 'tabular-nums' }}>
                          {snap.sent_7d.toLocaleString()}
                        </div>
                      </div>
                      <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '8px', padding: '0.65rem 0.75rem' }}>
                        <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280' }}>Reply Rate</div>
                        <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '1px' }}>
                          {snap.reply_rate_7d != null ? (snap.reply_rate_7d * 100).toFixed(1) : '—'}%
                        </div>
                      </div>
                      <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '8px', padding: '0.65rem 0.75rem' }}>
                        <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280' }}>Bounce Rate</div>
                        <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '1px' }}>
                          {snap.bounce_rate_7d != null ? (snap.bounce_rate_7d * 100).toFixed(1) : '—'}%
                        </div>
                      </div>
                      <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '8px', padding: '0.65rem 0.75rem' }}>
                        <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280' }}>Leads (7d)</div>
                        <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '1px', fontVariantNumeric: 'tabular-nums' }}>
                          {snap.leads_7d.toLocaleString()}
                        </div>
                      </div>
                      <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '8px', padding: '0.65rem 0.75rem' }}>
                        <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280' }}>Mailboxes</div>
                        <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '1px', fontVariantNumeric: 'tabular-nums' }}>
                          {snap.mailbox_total}
                        </div>
                      </div>
                      <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: '8px', padding: '0.65rem 0.75rem' }}>
                        <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6B7280' }}>Unhealthy</div>
                        <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '1px', color: snap.mailbox_unhealthy > 0 ? '#DC2626' : '#059669', fontVariantNumeric: 'tabular-nums' }}>
                          {snap.mailbox_unhealthy}
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
    </div>
  )
}
