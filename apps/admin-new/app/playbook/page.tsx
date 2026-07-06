'use client'

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

// ── Types (mirror /api/playbook) ─────────────────────────────────────────────
interface Combo { sender: string; recipient: string; sent: number; leads: number; lpk: number; low_volume: boolean }
interface ClientRow {
  workspace_id: string; client: string
  totalSent: number; totalLeads: number; lpk: number
  best: Combo | null; worst: Combo | null; combos: Combo[]
}
interface SenderRow { sender: string; label: string; sent: number; leads: number; lpk: number }
interface Playbook { days: number; min_sent: number; globalSenders: SenderRow[]; perClient: ClientRow[]; error?: string }

const num = (n: number) => n.toLocaleString()
const lpkStr = (n: number) => n.toFixed(2)
// LPK colour scale — green good, amber ok, red weak. Tuned to observed data
// (top combos ~2-3/1k, weak ~0.3/1k).
const lpkTone = (n: number) => n >= 1.5 ? '#16A34A' : n >= 0.8 ? '#D97706' : n > 0 ? '#DC2626' : '#9CA3AF'

export default function PlaybookPage() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<Playbook | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())

  const load = useCallback(async (d: number) => {
    setStatus('loading'); setErr('')
    try {
      const r = await fetch(`/api/playbook?days=${d}`)
      const j = await r.json() as Playbook
      if (j.error) throw new Error(j.error)
      setData(j); setStatus('ok')
    } catch (e) { setStatus('error'); setErr(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { load(days) }, [days, load])

  const C = { navy: '#224388', text: '#050C29', muted: '#6B7280', border: '#E2E6F0', card: '#fff', bg: '#F0F2F8' }

  // Weekly digest: global verdict + top opportunities, in plain words.
  const digest = (() => {
    if (!data) return null
    const g = data.globalSenders.filter(s => s.sent > 0)
    if (!g.length) return null
    const winner = g[0], laggard = g[g.length - 1]
    // Biggest per-client wins/misses.
    const withBest = data.perClient.filter(c => c.best)
    const topClients = [...withBest].sort((a, b) => (b.best!.lpk) - (a.best!.lpk)).slice(0, 3)
    const weak = data.perClient.filter(c => c.totalLeads === 0 && c.totalSent >= data.min_sent).slice(0, 3)
    return { winner, laggard, topClients, weak }
  })()

  return (
    <div style={{ background: C.bg, minHeight: '100%', color: C.text, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ maxWidth: 1500, margin: '0 auto', padding: '1.5rem' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, fontFamily: 'Genos, Inter, sans-serif' }}>Playbook</div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>
              Where to put effort & who to send to — ranked by <b>leads per 1,000 sent</b> (conversion, not raw count). Best setup per client, updated live.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {[{ k: 7, l: 'This week (7d)' }, { k: 30, l: '30 days' }].map(p => (
              <button key={p.k} onClick={() => setDays(p.k)}
                style={{ padding: '6px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: `1px solid ${C.border}`, background: days === p.k ? C.navy : '#fff', color: days === p.k ? '#fff' : C.muted }}>
                {p.l}
              </button>
            ))}
          </div>
        </div>

        {status === 'error' && <div style={{ background: '#FEE2E2', border: '1px solid #FECACA', borderRadius: 8, padding: 16, fontSize: 13, color: '#991B1B', marginTop: 12 }}>Couldn’t load playbook: {err} <button onClick={() => load(days)} style={{ marginLeft: 8, textDecoration: 'underline' }}>Retry</button></div>}
        {status === 'loading' && <div style={{ padding: '3rem', textAlign: 'center', color: C.muted }}>Crunching the numbers…</div>}

        {status === 'ok' && data && (
          <>
            {/* ── Weekly digest ── */}
            {digest && (
              <div style={{ background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 12, padding: '1rem 1.25rem', margin: '1rem 0' }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: C.navy, marginBottom: 8 }}>📋 The verdict ({days === 7 ? 'this week' : 'last 30 days'})</div>
                <div style={{ fontSize: 14, lineHeight: 1.6 }}>
                  Your best sender type is <b style={{ color: lpkTone(digest.winner.lpk) }}>{digest.winner.label}</b> at <b>{lpkStr(digest.winner.lpk)}</b> leads/1k
                  {digest.laggard.sender !== digest.winner.sender && <> — <b style={{ color: lpkTone(digest.laggard.lpk) }}>{digest.laggard.label}</b> is lagging at {lpkStr(digest.laggard.lpk)}/1k, so shift volume away from it.</>}
                  {digest.topClients.length > 0 && (
                    <> <br />Push hardest on: {digest.topClients.map((c, i) => (
                      <span key={c.workspace_id}>{i > 0 ? ', ' : ''}<b>{c.client}</b> → {c.best!.sender}→{c.best!.recipient} ({lpkStr(c.best!.lpk)}/1k)</span>
                    ))}.</>
                  )}
                  {digest.weak.length > 0 && (
                    <> <br /><span style={{ color: '#B45309' }}>Review targeting for: {digest.weak.map(c => c.client).join(', ')} — sending but 0 leads.</span></>
                  )}
                </div>
              </div>
            )}

            {/* ── Global sender-type verdict ── */}
            <div style={{ marginBottom: '1.25rem' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: C.muted, margin: '0 0 .5rem' }}>Which sender type is winning?</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: '1rem' }}>
                {data.globalSenders.map((s, i) => (
                  <div key={s.sender} style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, padding: '1rem 1.15rem', borderTop: `3px solid ${lpkTone(s.lpk)}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{s.label}</div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: i === 0 ? '#16A34A' : i === data.globalSenders.length - 1 ? '#DC2626' : C.muted }}>
                        {i === 0 ? '▲ WINNING' : i === data.globalSenders.length - 1 ? '▼ LACKING' : ''}
                      </div>
                    </div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: lpkTone(s.lpk), marginTop: 4 }}>{lpkStr(s.lpk)}</div>
                    <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '.3px' }}>leads / 1,000 sent</div>
                    <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{num(s.sent)} sent · <b>{num(s.leads)}</b> leads</div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Per-client best setup ── */}
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: C.muted, margin: '0 0 .5rem' }}>Best setup per client (ranked by conversion)</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {data.perClient.map(c => {
                const isOpen = open.has(c.workspace_id)
                return (
                  <div key={c.workspace_id} style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
                    {/* Summary row */}
                    <div onClick={() => setOpen(p => { const n = new Set(p); n.has(c.workspace_id) ? n.delete(c.workspace_id) : n.add(c.workspace_id); return n })}
                      style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1.6fr 1.6fr auto', gap: 12, alignItems: 'center', padding: '.9rem 1.1rem', cursor: 'pointer' }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 15 }}>{c.client}</div>
                        <div style={{ fontSize: 12, color: C.muted }}>{num(c.totalSent)} sent · {c.totalLeads} leads</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 22, fontWeight: 800, color: lpkTone(c.lpk) }}>{lpkStr(c.lpk)}</div>
                        <div style={{ fontSize: 10, color: C.muted, textTransform: 'uppercase' }}>leads / 1k</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: '#16A34A', textTransform: 'uppercase', letterSpacing: '.3px' }}>✓ Do more of</div>
                        {c.best ? <div style={{ fontSize: 13, fontWeight: 600 }}>{c.best.sender} → {c.best.recipient} <span style={{ color: lpkTone(c.best.lpk) }}>({lpkStr(c.best.lpk)}/1k)</span></div>
                          : <div style={{ fontSize: 13, color: C.muted }}>No lead-winning setup yet</div>}
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: '#DC2626', textTransform: 'uppercase', letterSpacing: '.3px' }}>✕ Shift away from</div>
                        {c.worst && c.worst.sender !== c.best?.sender ? <div style={{ fontSize: 13, fontWeight: 600 }}>{c.worst.sender} → {c.worst.recipient} <span style={{ color: lpkTone(c.worst.lpk) }}>({lpkStr(c.worst.lpk)}/1k)</span></div>
                          : <div style={{ fontSize: 13, color: C.muted }}>—</div>}
                      </div>
                      <div style={{ fontSize: 13, color: C.muted, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</div>
                    </div>

                    {/* Expanded combo breakdown */}
                    {isOpen && (
                      <div style={{ borderTop: `1px solid ${C.border}`, background: '#F8F9FC', padding: '.5rem 0' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead>
                            <tr>
                              {['Sender', 'Recipient', 'Sent', 'Leads', 'Leads / 1k', ''].map((h, i) => (
                                <th key={h + i} style={{ textAlign: i >= 2 && i <= 4 ? 'right' : 'left', padding: '6px 16px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: C.muted }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {c.combos.map((k, i) => (
                              <tr key={i}>
                                <td style={{ padding: '6px 16px', fontWeight: 600 }}>{k.sender}</td>
                                <td style={{ padding: '6px 16px' }}>{k.recipient}</td>
                                <td style={{ padding: '6px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(k.sent)}</td>
                                <td style={{ padding: '6px 16px', textAlign: 'right', fontWeight: 600 }}>{k.leads}</td>
                                <td style={{ padding: '6px 16px', textAlign: 'right', fontWeight: 700, color: lpkTone(k.lpk) }}>{lpkStr(k.lpk)}</td>
                                <td style={{ padding: '6px 16px', fontSize: 10, color: C.muted }}>{k.low_volume ? 'low volume' : ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })}
              {data.perClient.length === 0 && <div style={{ padding: '2rem', textAlign: 'center', color: C.muted }}>No clients with enough volume ({data.min_sent}+ sent) in this window.</div>}
            </div>

            <div style={{ fontSize: 11, color: C.muted, marginTop: 16 }}>
              Leads = billable leads (unibox marked leads). Setups with under {data.min_sent} sent are flagged “low volume” — their conversion is noisy, so they can’t be a client’s best/worst pick. Recipient provider from MX records (99% enriched).
            </div>
          </>
        )}
      </div>
    </div>
  )
}
