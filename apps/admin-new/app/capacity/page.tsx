'use client'

import { useCallback, useEffect, useState } from 'react'
import { BarChart } from '@/components/ui/themed-chart'

// ── Types (mirror /api/capacity/daily) ───────────────────────────────────────
interface ClientRow {
  workspace_id: string; client: string
  capacity: number; mailboxes: number; activeMailboxes: number
  sentToday: number; projected: number; usedPct: number; wasted: number
  paused: boolean
}
interface Capacity {
  ukTime: string; dayFraction: number; hasTodayData: boolean; pausedCount: number
  summary: { totalCapacity: number; totalSentToday: number; totalProjected: number; totalWasted: number; usedPct: number }
  clients: ClientRow[]
  history: { date: string; sent: number; wasted: number }[]
  error?: string
}

const num = (n: number) => (n || 0).toLocaleString()
// Utilisation colour: green healthy, amber slipping, red wasting a lot.
const utilTone = (p: number) => p >= 85 ? '#16A34A' : p >= 60 ? '#D97706' : '#DC2626'

export default function CapacityPage() {
  const [data, setData] = useState<Capacity | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [err, setErr] = useState('')

  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setStatus('loading'); setErr('')
    try {
      const r = await fetch('/api/capacity/daily')
      const j = await r.json() as Capacity
      if (j.error) throw new Error(j.error)
      setData(j); setStatus('ok')
    } catch (e) { setStatus('error'); setErr(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { load() }, [load])

  // Toggle a client's "paused" flag (dashboard-only — does NOT touch PlusVibe).
  // Optimistic: flip locally, POST, then reload for fresh totals.
  const togglePause = useCallback(async (ws: string, paused: boolean) => {
    setBusy(ws)
    setData(prev => prev ? { ...prev, clients: prev.clients.map(c => c.workspace_id === ws ? { ...c, paused } : c) } : prev)
    try {
      const r = await fetch('/api/capacity/pause', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: ws, paused }),
      })
      if (!r.ok) throw new Error('save failed')
      await load()
    } catch { await load() } finally { setBusy(null) }
  }, [load])

  const C = { navy: '#224388', text: '#050C29', muted: '#6B7280', border: '#E2E6F0', bg: '#F0F2F8' }
  const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: C.muted, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { padding: '8px 10px', borderBottom: `1px solid ${C.border}`, fontSize: 13, whiteSpace: 'nowrap' }
  const tdN: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

  const StatCard = ({ label, val, sub, accent }: { label: string; val: string; sub?: string; accent: string }) => (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, padding: '1rem 1.15rem', borderTop: `3px solid ${accent}` }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px', color: C.muted }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 800, marginTop: 4, color: accent }}>{val}</div>
      {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  )

  return (
    <div style={{ background: C.bg, minHeight: '100%', color: C.text, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ maxWidth: 1500, margin: '0 auto', padding: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, fontFamily: 'Genos, Inter, sans-serif' }}>Capacity</div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>
              Are we using all our sending resource? Per-client daily limits vs what’s actually sending.
              {data && <> · Now {data.ukTime} UK · sending day {data.dayFraction}% elapsed{data.pausedCount > 0 ? ` · ${data.pausedCount} paused (excluded)` : ''}</>}
            </div>
          </div>
          <button onClick={load} disabled={status === 'loading'} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: C.navy, color: '#fff', border: 'none', opacity: status === 'loading' ? 0.6 : 1 }}>{status === 'loading' ? 'Loading…' : '↻ Refresh'}</button>
        </div>

        {status === 'error' && <div style={{ background: '#FEE2E2', border: '1px solid #FECACA', borderRadius: 8, padding: 16, fontSize: 13, color: '#991B1B' }}>Couldn’t load capacity: {err} <button onClick={load} style={{ marginLeft: 8, textDecoration: 'underline' }}>Retry</button></div>}
        {status === 'loading' && !data && <div style={{ padding: '3rem', textAlign: 'center', color: C.muted }}>Loading capacity…</div>}

        {status === 'ok' && data && (
          <>
            {/* Today's data not synced yet — don't let 0 read as "100% wasted". */}
            {!data.hasTodayData && (
              <div style={{ background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 10, padding: '.7rem 1rem', marginBottom: '1rem', fontSize: 13, color: '#92400E' }}>
                ⏳ Today’s send data hasn’t synced yet (sync runs periodically). “Sent so far” shows 0 until it lands — this isn’t 0% real utilisation, just no data yet. Yesterday’s totals are in the chart below.
              </div>
            )}

            {/* Summary */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '1rem', marginBottom: '1.25rem' }}>
              <StatCard label="Daily capacity" val={num(data.summary.totalCapacity)} sub="max sends/day (active boxes)" accent={C.navy} />
              <StatCard label="Sent so far today" val={num(data.summary.totalSentToday)} sub={`${data.dayFraction}% of sending day done`} accent="#0EA5E9" />
              <StatCard label="Projected today" val={num(data.summary.totalProjected)} sub="at the current pace" accent="#6366F1" />
              <StatCard label="Utilisation" val={data.summary.usedPct + '%'} sub="projected ÷ capacity" accent={utilTone(data.summary.usedPct)} />
              <StatCard label="Wasted today" val={num(data.summary.totalWasted)} sub="capacity that won’t be used" accent="#DC2626" />
            </div>

            {/* Daily sent vs wasted chart */}
            <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, padding: '1rem 1.15rem', marginBottom: '1.25rem' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: C.muted, marginBottom: 8 }}>Sent vs wasted capacity — last {data.history.length} days</div>
              <BarChart
                labels={data.history.map(h => h.date.slice(5))}
                series={[
                  { label: 'Sent', data: data.history.map(h => h.sent), color: '#16A34A' },
                  { label: 'Wasted', data: data.history.map(h => h.wasted), color: '#DC2626' },
                ]}
                height={220}
              />
              <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>Green = sent, red = unused capacity that day. Historical capacity uses today’s total as the baseline, so past “wasted” is an estimate.</div>
            </div>

            {/* Per-client table */}
            <div style={{ background: '#fff', borderRadius: 12, border: `1px solid ${C.border}`, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={{ background: '#F8F9FC' }}>
                  <tr>
                    <th style={th}>Client</th>
                    <th style={{ ...th, textAlign: 'right' }}>Active boxes</th>
                    <th style={{ ...th, textAlign: 'right' }}>Daily capacity</th>
                    <th style={{ ...th, textAlign: 'right' }}>Sent so far</th>
                    <th style={{ ...th, textAlign: 'right' }}>Projected today</th>
                    <th style={{ ...th, textAlign: 'right' }}>Utilisation</th>
                    <th style={{ ...th, textAlign: 'right' }}>Wasted</th>
                    <th style={{ ...th, textAlign: 'center' }}>Pause</th>
                  </tr>
                </thead>
                <tbody>
                  {data.clients.map(c => (
                    <tr key={c.workspace_id} style={{ opacity: c.paused ? 0.5 : 1, background: c.paused ? '#F8F9FC' : undefined }}>
                      <td style={{ ...td, fontWeight: 600 }}>
                        {c.client}
                        {c.paused && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#92400E', background: '#FEF3C7', padding: '1px 6px', borderRadius: 20 }}>PAUSED · not counted</span>}
                      </td>
                      <td style={{ ...tdN, color: C.muted }}>{num(c.activeMailboxes)}{c.activeMailboxes !== c.mailboxes ? ` / ${num(c.mailboxes)}` : ''}</td>
                      <td style={tdN}>{num(c.capacity)}</td>
                      <td style={tdN}>{c.paused ? '—' : num(c.sentToday)}</td>
                      <td style={tdN}>{c.paused ? '—' : num(c.projected)}</td>
                      <td style={tdN}>
                        {c.paused ? <span style={{ color: C.muted }}>—</span> : <>
                          <span style={{ fontWeight: 700, color: utilTone(c.usedPct) }}>{c.usedPct}%</span>
                          <div style={{ height: 5, background: '#EEF0F5', borderRadius: 3, marginTop: 3, overflow: 'hidden', minWidth: 60 }}>
                            <div style={{ height: '100%', width: Math.min(c.usedPct, 100) + '%', background: utilTone(c.usedPct) }} />
                          </div>
                        </>}
                      </td>
                      <td style={{ ...tdN, color: c.paused ? C.muted : (c.wasted > 0 ? '#DC2626' : C.muted), fontWeight: !c.paused && c.wasted > 0 ? 700 : 400 }}>{c.paused ? '—' : num(c.wasted)}</td>
                      <td style={{ ...td, textAlign: 'center' }}>
                        <button
                          onClick={() => togglePause(c.workspace_id, !c.paused)}
                          disabled={busy === c.workspace_id}
                          title={c.paused ? 'Resume — count this client again' : 'Pause — exclude from capacity totals'}
                          style={{
                            position: 'relative', width: 40, height: 22, borderRadius: 20, border: 'none', cursor: 'pointer',
                            background: c.paused ? '#D97706' : '#CBD5E1', transition: 'background .15s', opacity: busy === c.workspace_id ? 0.6 : 1,
                          }}>
                          <span style={{ position: 'absolute', top: 2, left: c.paused ? 20 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {data.clients.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', padding: '2.5rem', color: C.muted }}>No clients with capacity right now.</td></tr>}
                </tbody>
              </table>
            </div>

            <div style={{ fontSize: 11, color: C.muted, marginTop: 14, lineHeight: 1.5 }}>
              Capacity = sum of each ACTIVE mailbox’s daily limit (paused / 0-limit boxes don’t count). Projected = today’s sent extrapolated at the current pace across the 08:00–17:00 UK sending window, capped at capacity. Wasted = capacity the projection won’t reach — the resource the CMs should be filling. Sent figures update through the day. The <b>Pause</b> toggle excludes a client from the totals when they’re deliberately not sending — it’s a dashboard flag only and does NOT change anything on PlusVibe.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
