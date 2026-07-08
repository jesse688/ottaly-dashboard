'use client'

import { useCallback, useEffect, useState } from 'react'
import { BarChart } from '@/components/ui/themed-chart'

// ── Types (mirror /api/capacity/daily) ───────────────────────────────────────
interface ProviderRow {
  provider: string; activeBoxes: number; capacity: number; sent: number
  currentIntervalMin: number | null; neededIntervalMin: number | null
  needsSpeedUp: boolean; stalled: boolean
}
interface ClientRow {
  workspace_id: string; client: string
  capacity: number; mailboxes: number; activeMailboxes: number
  sentToday: number
  pacePct: number; donePct: number; paceState: 'ahead' | 'on' | 'behind'
  projected: number; onTarget: boolean; wasted: number
  providers: ProviderRow[]
  needsSpeedUp: boolean; stalled: boolean
  paused: boolean
}
interface Capacity {
  ukTime: string; dayFraction: number; hasTodayData: boolean; pausedCount: number
  summary: { totalCapacity: number; totalSentToday: number; totalProjected: number; totalWasted: number; usedPct: number; livePacePct: number; donePct: number }
  clients: ClientRow[]
  history: { date: string; sent: number; wasted: number }[]
  error?: string
}

const num = (n: number) => (n || 0).toLocaleString()
// Projected-utilisation colour: green healthy, amber slipping, red wasting a lot.
const utilTone = (p: number) => p >= 85 ? '#16A34A' : p >= 60 ? '#D97706' : '#DC2626'
// Live-pace colour by state.
const paceTone = (s: 'ahead' | 'on' | 'behind') => s === 'ahead' ? '#16A34A' : s === 'on' ? '#16A34A' : '#DC2626'
const paceLabel = (s: 'ahead' | 'on' | 'behind') => s === 'ahead' ? 'ahead' : s === 'on' ? 'on pace' : 'behind'

export default function CapacityPage() {
  const [data, setData] = useState<Capacity | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [err, setErr] = useState('')

  const [busy, setBusy] = useState<string | null>(null)

  const [refreshing, setRefreshing] = useState(false)

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

  // Refresh pulls TODAY's sent live from PlusVibe into the stats table, then
  // reloads — so the button actually updates the numbers (the plain read serves
  // the periodically-synced cache, which lags PV by up to an hour).
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await fetch('/api/capacity/refresh', { method: 'POST' })
    } catch { /* fall through to reload — worst case shows cached */ }
    await load()
    setRefreshing(false)
  }, [load])

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
          <button onClick={refresh} disabled={refreshing || status === 'loading'} title="Pull today's sent live from PlusVibe (takes ~20–40s)" style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: C.navy, color: '#fff', border: 'none', opacity: (refreshing || status === 'loading') ? 0.6 : 1 }}>{refreshing ? 'Refreshing from PlusVibe…' : status === 'loading' ? 'Loading…' : '↻ Refresh (live)'}</button>
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
              <StatCard label="Sent so far today" val={num(data.summary.totalSentToday)} sub={`${data.summary.donePct}% of today’s capacity`} accent="#0EA5E9" />
              <StatCard label="Live pace (now)" val={data.summary.livePacePct + '%'} sub={`vs expected by ${data.ukTime} · ${data.summary.livePacePct >= 90 ? 'on/ahead' : 'behind'}`} accent={data.summary.livePacePct >= 90 ? '#16A34A' : '#DC2626'} />
              <StatCard label="Projected today" val={num(data.summary.totalProjected)} sub={`${data.summary.usedPct}% of capacity end-of-day`} accent={utilTone(data.summary.usedPct)} />
              <StatCard label="Wasted (projected)" val={num(data.summary.totalWasted)} sub="capacity that won’t be used" accent="#DC2626" />
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
                    <th style={{ ...th, textAlign: 'right' }} title="Sent vs where they should be by now (live). 100% = on pace.">Live pace</th>
                    <th style={{ ...th, textAlign: 'right' }} title="Forecast total by end of day at the current pace.">Projected</th>
                    <th style={{ ...th, textAlign: 'center' }} title="On track to fill capacity by end of day at the current rate?">On target</th>
                    <th style={th} title="For behind clients: the per-mailbox sending interval needed to still hit capacity.">Speed to fix</th>
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
                      <td style={tdN}>{c.paused ? '—' : <>{num(c.sentToday)}<div style={{ fontSize: 10, color: C.muted }}>{c.donePct}% of cap</div></>}</td>
                      {/* Live pace (now) */}
                      <td style={tdN}>
                        {c.paused ? <span style={{ color: C.muted }}>—</span> : <>
                          <span style={{ fontWeight: 700, color: paceTone(c.paceState) }}>{c.pacePct > 300 ? '300%+' : c.pacePct + '%'}</span>
                          <div style={{ fontSize: 10, color: paceTone(c.paceState), fontWeight: 600 }}>{paceLabel(c.paceState)}</div>
                        </>}
                      </td>
                      {/* Projected today (end-of-day forecast at current pace) */}
                      <td style={tdN}>
                        {c.paused ? <span style={{ color: C.muted }}>—</span>
                          : <><span style={{ fontWeight: 600, color: utilTone(c.capacity > 0 ? Math.round(c.projected / c.capacity * 100) : 0) }}>{num(c.projected)}</span>
                            <div style={{ fontSize: 10, color: C.muted }}>{c.capacity > 0 ? Math.round(c.projected / c.capacity * 100) : 0}% of cap</div></>}
                      </td>
                      {/* On target */}
                      <td style={{ ...td, textAlign: 'center' }}>
                        {c.paused ? <span style={{ color: C.muted }}>—</span>
                          : c.onTarget ? <span style={{ color: '#16A34A', fontWeight: 700 }}>✓</span>
                          : <span style={{ color: '#DC2626', fontWeight: 700 }} title="Won't fill capacity at current rate">✕</span>}
                      </td>
                      {/* Speed to fix — PER PROVIDER. Interval only when it's the real
                          bottleneck; otherwise "stalled" (sends not happening). */}
                      <td style={td}>
                        {c.paused ? <span style={{ color: C.muted }}>—</span>
                          : (() => {
                            const tighten = c.providers.filter(p => p.needsSpeedUp && p.neededIntervalMin && p.currentIntervalMin)
                            const stalled = c.providers.filter(p => p.stalled)
                            if (tighten.length === 0 && stalled.length === 0)
                              return c.onTarget ? <span style={{ fontSize: 12, color: '#16A34A' }}>on track</span> : <span style={{ color: C.muted }}>—</span>
                            return (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                {tighten.map(p => (
                                  <span key={p.provider} style={{ fontSize: 11.5, color: '#B45309', whiteSpace: 'nowrap' }} title="Interval is the bottleneck — tighten the gap between sends">
                                    <span style={{ display: 'inline-block', minWidth: 62, fontWeight: 600, color: C.muted }}>{p.provider}</span>
                                    {p.currentIntervalMin}m → <b>{p.neededIntervalMin}m</b>
                                  </span>
                                ))}
                                {stalled.filter(s => !tighten.some(t => t.provider === s.provider)).map(p => (
                                  <span key={p.provider} style={{ fontSize: 11.5, color: '#DC2626', whiteSpace: 'nowrap' }} title={`Interval (${p.currentIntervalMin ?? '?'}m) has headroom — sends aren't going out. Check campaign / leads / warmup.`}>
                                    <span style={{ display: 'inline-block', minWidth: 62, fontWeight: 600, color: C.muted }}>{p.provider}</span>
                                    ⚠ stalled
                                  </span>
                                ))}
                              </div>
                            )
                          })()}
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
                  {data.clients.length === 0 && <tr><td colSpan={10} style={{ textAlign: 'center', padding: '2.5rem', color: C.muted }}>No clients with capacity right now.</td></tr>}
                </tbody>
              </table>
            </div>

            <div style={{ fontSize: 11, color: C.muted, marginTop: 14, lineHeight: 1.5 }}>
              <b>Live pace</b> = sent so far ÷ where they should be by now (100% = exactly on pace right now — this is the real-time signal, not a forecast). <b>On target</b> = will they fill capacity by end of day at the current rate. <b>Speed to fix</b> (per provider): shows the ACTUAL sending interval, and “20m → 14m” only when the interval is genuinely the bottleneck. If a provider is behind but its interval has headroom (its daily limit is the real cap), it reads <b>⚠ stalled</b> — the sends just aren’t going out, so check the campaign / leads / warmup, not the interval. Capacity = Σ each ACTIVE mailbox’s daily limit (08:00–17:00 UK window). The <b>Pause</b> toggle excludes a client from the totals — a dashboard flag only, it does NOT change anything on PlusVibe.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
