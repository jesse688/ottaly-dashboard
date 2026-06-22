'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { LineChart } from '@/components/ui/themed-chart'
import type { Mailbox, MailboxGroupStats, MailboxesResponse } from '@/types/mailbox'

// Styled to match the admin-legacy mailboxes page (navy/teal palette, rounded
// pills, colored stat-cards, dense table) — deliberately distinct from the rest
// of admin-new's component look. All styling is scoped to this page.

const SUPPLIERS = ['Maildoso', 'Mithun', 'Winnr', 'Inboxing'] as const
const TYPES = ['google', 'microsoft', 'smtp'] as const
const PERIODS: { key: number; label: string }[] = [{ key: 1, label: 'Today' }, { key: 7, label: '7d' }, { key: 14, label: '14d' }, { key: 30, label: '30d' }]

type TabKey = 'inventory' | 'performance'
type Status = 'loading' | 'ok' | 'empty' | 'error'

const num = (n: number | null | undefined) => (n || 0).toLocaleString()
const pct = (n: number) => (n == null || isNaN(n) ? '—' : (n * 100).toFixed(1) + '%')
const money = (n: number | null) => (n == null ? '—' : '$' + n.toFixed(2))

// Top-border color per supplier/type (legacy stat-card accents).
const ACCENT: Record<string, string> = {
  Maildoso: '#10B981', Mithun: '#F59E0B', Winnr: '#6366F1', Inboxing: '#7C89CD',
  Unassigned: '#9CA3AF', google: '#EA4335', microsoft: '#0078D4', smtp: '#475569',
}

interface HistoryResponse { days: string[]; series: Record<string, { sent: number[]; reply_rate: number[]; bounce_rate: number[] }> }

// ── Legacy pill ──────────────────────────────────────────────────────────────
function Pill({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'gray' | 'google' | 'microsoft' | 'smtp'; children: React.ReactNode }) {
  const styles: Record<string, React.CSSProperties> = {
    good: { background: '#D1FAE5', color: '#065F46' },
    warn: { background: '#FEF3C7', color: '#92400E' },
    bad: { background: '#FEE2E2', color: '#991B1B' },
    gray: { background: '#F3F4F6', color: '#4B5563' },
    google: { background: '#FEE2E2', color: '#991B1B' },
    microsoft: { background: '#DBEAFE', color: '#1E40AF' },
    smtp: { background: '#F1F5F9', color: '#334155' },
  }
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, textTransform: 'capitalize', ...styles[tone] }}>{children}</span>
}

function statusPill(s: string | null) {
  const u = (s || '').toUpperCase()
  if (u === 'ACTIVE') return <Pill tone="good">active</Pill>
  if (u === 'PAUSED') return <Pill tone="warn">paused</Pill>
  return u ? <Pill tone="bad">{u.toLowerCase()}</Pill> : <span style={{ color: '#6B7280' }}>—</span>
}
function typePill(t: string) {
  const tone = t === 'google' ? 'google' : t === 'microsoft' ? 'microsoft' : 'smtp'
  return <Pill tone={tone}>{t}</Pill>
}
function AuthBadge({ ok, label }: { ok: boolean; label: string }) {
  return <span style={{ fontSize: 10, fontWeight: 600, marginRight: 4, color: ok ? '#16A34A' : '#DC2626' }}>{label}</span>
}

function renewalInfo(m: Mailbox): { label: string; urgent: boolean } | null {
  if (!m.billing_day) return null
  const now = new Date()
  let next = new Date(now.getFullYear(), now.getMonth(), m.billing_day)
  if (next < now) next = new Date(now.getFullYear(), now.getMonth() + 1, m.billing_day)
  const days = Math.ceil((next.getTime() - now.getTime()) / 86400000)
  return { label: `${next.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${days}d`, urgent: days <= 5 }
}

export default function MailboxesPage() {
  const [tab, setTab] = useState<TabKey>('inventory')
  const [data, setData] = useState<MailboxesResponse | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [err, setErr] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState('')
  const [periodDays, setPeriodDays] = useState(30)
  const [history, setHistory] = useState<HistoryResponse | null>(null)

  const [search, setSearch] = useState('')
  const [fClient, setFClient] = useState('')
  const [fSupplier, setFSupplier] = useState('')
  const [fType, setFType] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [assignTo, setAssignTo] = useState('')
  const [assignField, setAssignField] = useState<'supplier' | 'mailbox_type'>('supplier')
  const [assigning, setAssigning] = useState(false)

  const load = useCallback(async () => {
    setStatus('loading'); setErr('')
    try {
      const r = await fetch('/api/mailboxes')
      if (!r.ok) throw new Error(`Server returned ${r.status}`)
      const d = await r.json() as MailboxesResponse & { error?: string }
      if (d.error) throw new Error(d.error)
      setData(d); setStatus(d.mailboxes.length ? 'ok' : 'empty')
    } catch (e) { setStatus('error'); setErr(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (tab !== 'performance') return
    fetch(`/api/mailboxes/history?dimension=supplier&days=${periodDays}`).then(r => r.json()).then(setHistory).catch(() => setHistory(null))
  }, [tab, periodDays])

  const runSync = useCallback(async () => {
    setSyncing(true); setMsg('')
    try {
      const r = await fetch('/api/mailboxes/sync', { method: 'POST' })
      const d = await r.json()
      setMsg(d.ok ? `Synced ${d.count} mailboxes.` : `Sync failed: ${d.error}`)
      if (d.ok) await load()
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) } finally { setSyncing(false) }
  }, [load])

  const mailboxes = data?.mailboxes ?? []
  const clients = useMemo(() => Array.from(new Set(mailboxes.map(m => m.workspace_name).filter(Boolean))).sort() as string[], [mailboxes])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return mailboxes.filter(m => {
      if (q && !(m.email.toLowerCase().includes(q) || (m.domain || '').toLowerCase().includes(q) || (m.workspace_name || '').toLowerCase().includes(q))) return false
      if (fClient && m.workspace_name !== fClient) return false
      if (fSupplier && (fSupplier === '__unassigned' ? !!m.supplier : m.supplier !== fSupplier)) return false
      if (fType && m.type !== fType) return false
      if (fStatus && (m.status || '').toUpperCase() !== fStatus) return false
      if (attentionOnly && m.attention.length === 0) return false
      return true
    })
  }, [mailboxes, search, fClient, fSupplier, fType, fStatus, attentionOnly])

  const allSel = rows.length > 0 && rows.every(m => selected.has(m.email))
  const toggleAll = () => setSelected(prev => { const n = new Set(prev); allSel ? rows.forEach(m => n.delete(m.email)) : rows.forEach(m => n.add(m.email)); return n })
  const toggleOne = (e: string) => setSelected(prev => { const n = new Set(prev); n.has(e) ? n.delete(e) : n.add(e); return n })

  const doBulkAssign = useCallback(async () => {
    if (!assignTo || selected.size === 0) return
    setAssigning(true); setMsg('')
    try {
      const r = await fetch('/api/mailboxes/bulk-tag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emails: Array.from(selected), field: assignField, value: assignTo }) })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `Server returned ${r.status}`)
      setMsg(`Updated ${selected.size} mailbox(es).`); setSelected(new Set()); setAssignTo(''); await load()
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) } finally { setAssigning(false) }
  }, [assignTo, assignField, selected, load])

  const C = {
    navy: '#224388', navyDark: '#050C29', teal: '#1F6F78', bg: '#F0F2F8', card: '#fff',
    border: '#E2E6F0', text: '#050C29', muted: '#6B7280',
  }
  const lastRun = data?.lastRun ? new Date(data.lastRun).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'
  const th: React.CSSProperties = { padding: '8px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: C.muted, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { padding: '7px 8px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'middle', fontSize: 12, whiteSpace: 'nowrap' }
  const tdNum: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
  const selStyle: React.CSSProperties = { padding: '8px 10px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, background: '#fff', outline: 'none' }

  return (
    <div style={{ background: C.bg, minHeight: '100%', color: C.text, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ maxWidth: 1900, margin: '0 auto', padding: '1.25rem 1.5rem' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '.75rem' }}>
          <div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, fontFamily: 'Genos, Inter, sans-serif' }}>Mailboxes</div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>Every sending mailbox across all clients — assign suppliers and compare performance · last synced {lastRun}</div>
          </div>
          <button onClick={runSync} disabled={syncing} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: C.navy, color: '#fff', border: 'none', opacity: syncing ? 0.6 : 1 }}>{syncing ? 'Syncing…' : '↻ Refresh'}</button>
        </div>

        {/* KPI cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '1rem', marginBottom: '1.25rem' }}>
          <StatCard accent={C.navy} label="Total mailboxes" val={num(data?.summary.total)} />
          <StatCard accent="#9CA3AF" label="Unassigned supplier" val={num(data?.summary.unassigned_supplier)} />
          <StatCard accent="#DC2626" label="Need attention" val={num(data?.summary.needs_attention)} />
        </div>

        {/* Tabs */}
        <div style={{ display: 'inline-flex', gap: 4, background: '#E6E9F2', padding: 4, borderRadius: 8, marginBottom: '1rem' }}>
          {(['inventory', 'performance'] as TabKey[]).map(k => (
            <button key={k} onClick={() => setTab(k)} style={{ padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', background: tab === k ? '#fff' : 'transparent', color: tab === k ? C.text : C.muted, boxShadow: tab === k ? '0 1px 2px rgba(0,0,0,.08)' : 'none' }}>{k === 'inventory' ? 'Inventory' : 'Supplier Performance'}</button>
          ))}
        </div>

        {msg && <div style={{ marginBottom: 12, background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: C.navy }}>{msg}</div>}
        {status === 'error' && <div style={{ background: '#FEE2E2', border: '1px solid #FECACA', borderRadius: 8, padding: 16, fontSize: 13, color: '#991B1B' }}>Couldn’t load mailboxes: {err} <button onClick={load} style={{ marginLeft: 8, textDecoration: 'underline' }}>Retry</button></div>}

        {tab === 'inventory' && status !== 'error' && (
          <>
            {/* Toolbar */}
            <div style={{ display: 'flex', gap: '.6rem', margin: '.75rem 0 1rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input placeholder="Search email, domain, client" value={search} onChange={e => setSearch(e.target.value)} style={{ flex: 1, minWidth: 240, padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, background: '#fff', outline: 'none' }} />
              <select value={fClient} onChange={e => setFClient(e.target.value)} style={selStyle}><option value="">All clients</option>{clients.map(c => <option key={c} value={c}>{c}</option>)}</select>
              <select value={fSupplier} onChange={e => setFSupplier(e.target.value)} style={selStyle}><option value="">All suppliers</option>{SUPPLIERS.map(s => <option key={s} value={s}>{s}</option>)}<option value="__unassigned">Unassigned</option></select>
              <select value={fType} onChange={e => setFType(e.target.value)} style={selStyle}><option value="">All types</option>{TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select>
              <select value={fStatus} onChange={e => setFStatus(e.target.value)} style={selStyle}><option value="">All statuses</option><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option></select>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.muted }}><input type="checkbox" checked={attentionOnly} onChange={e => setAttentionOnly(e.target.checked)} /> Needs attention only</label>
            </div>

            {/* Bulk bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', background: selected.size ? '#EEF2FF' : '#F8F9FC', border: `1px solid ${selected.size ? '#C7D2FE' : C.border}`, padding: '.6rem .9rem', borderRadius: 10, marginBottom: '.75rem', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, color: C.navy }}>{selected.size} selected</span>
              <button onClick={toggleAll} disabled={!rows.length} style={{ fontSize: 12, color: C.navy, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer' }}>{allSel ? 'Clear' : 'Select all visible'}</button>
              <span style={{ fontSize: 12, color: C.muted }}>{rows.length} of {mailboxes.length} shown</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                <select value={assignField} onChange={e => setAssignField(e.target.value as 'supplier' | 'mailbox_type')} style={selStyle}><option value="supplier">Supplier</option><option value="mailbox_type">Type</option></select>
                <select value={assignTo} onChange={e => setAssignTo(e.target.value)} disabled={!selected.size} style={selStyle}><option value="">Assign…</option>{(assignField === 'supplier' ? SUPPLIERS : TYPES).map(s => <option key={s} value={s}>{s}</option>)}</select>
                <button onClick={doBulkAssign} disabled={!assignTo || !selected.size || assigning} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: C.navy, color: '#fff', border: 'none', opacity: (!assignTo || !selected.size) ? 0.6 : 1 }}>{assigning ? 'Applying…' : 'Apply'}</button>
              </div>
            </div>

            {/* Table */}
            <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ background: '#F8F9FC' }}>
                  <tr>
                    <th style={{ ...th, width: 34 }}></th>
                    <th style={th}>Mailbox</th><th style={th}>Client</th><th style={th}>Renewal</th><th style={th}>Supplier</th><th style={th}>Type</th><th style={th}>Status</th><th style={th}>Warmup</th><th style={th}>Auth</th>
                    <th style={{ ...th, textAlign: 'right' }}>BL</th><th style={{ ...th, textAlign: 'right' }}>Score</th><th style={{ ...th, textAlign: 'right' }}>Sent</th><th style={{ ...th, textAlign: 'right' }}>Reply</th><th style={{ ...th, textAlign: 'right' }}>Bounce</th><th style={{ ...th, textAlign: 'right' }}>Daily</th><th style={{ ...th, textAlign: 'right' }}>$/mo</th><th style={th}>Attn</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(m => {
                    const r = renewalInfo(m)
                    return (
                      <tr key={m.email} style={{ background: '#fff' }} onMouseEnter={e => (e.currentTarget.style.background = '#FAFBFF')} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                        <td style={td}><input type="checkbox" checked={selected.has(m.email)} onChange={() => toggleOne(m.email)} /></td>
                        <td style={td}><div style={{ fontWeight: 600 }}>{m.email}</div>{m.name && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{m.name}</div>}</td>
                        <td style={{ ...td, color: C.muted }}>{m.workspace_name || '—'}</td>
                        <td style={td}>{r ? <span style={{ color: r.urgent ? '#D97706' : C.muted, fontWeight: r.urgent ? 600 : 400 }}>{r.label}</span> : <span style={{ color: C.muted }}>—</span>}</td>
                        <td style={td}>{m.supplier ? <Pill tone="gray">{m.supplier}</Pill> : <span style={{ color: C.muted }}>—</span>}</td>
                        <td style={td}>{typePill(m.type)}</td>
                        <td style={td}>{statusPill(m.status)}</td>
                        <td style={td}>{(m.warmup_status || '').toUpperCase() === 'ACTIVE' ? <Pill tone="good">on</Pill> : <Pill tone="gray">off</Pill>}</td>
                        <td style={td}>{m.auth ? <span><AuthBadge ok={m.auth.spf_present} label="S" /><AuthBadge ok={m.auth.dkim_present} label="K" /><AuthBadge ok={m.auth.dmarc_present} label={m.auth.dmarc_policy ? `p=${m.auth.dmarc_policy}` : 'D'} /></span> : <span style={{ color: C.muted }}>—</span>}</td>
                        <td style={tdNum}><span style={{ color: m.blacklist_count ? '#DC2626' : '#16A34A', fontWeight: 600 }}>{m.blacklist_count}</span></td>
                        <td style={tdNum}>{m.domain_score == null ? <span style={{ color: C.muted }}>—</span> : <span style={{ color: m.domain_score >= 80 ? '#16A34A' : m.domain_score >= 50 ? '#D97706' : '#DC2626' }}>{m.domain_score}</span>}</td>
                        <td style={tdNum}>{num(m.attributed_sent)}</td>
                        <td style={tdNum}>{m.attributed_sent ? <b>{pct(m.reply_rate)}</b> : <span style={{ color: C.muted }}>—</span>}</td>
                        <td style={tdNum}>{m.attributed_sent ? <span style={{ color: m.bounce_rate > 0.05 ? '#DC2626' : 'inherit', fontWeight: m.bounce_rate > 0.05 ? 700 : 400 }}>{pct(m.bounce_rate)}</span> : <span style={{ color: C.muted }}>—</span>}</td>
                        <td style={tdNum}>{m.daily_limit == null ? <span style={{ color: C.muted }}>—</span> : num(m.daily_limit)}</td>
                        <td style={{ ...tdNum, color: C.muted }}>{money(m.unit_cost)}</td>
                        <td style={td}>{m.attention.length === 0 ? <span style={{ color: '#16A34A' }}>✓</span> : <span style={{ color: '#DC2626', fontWeight: 600 }} title={m.attention.map(a => a.msg).join(', ')}>● {m.attention.length}</span>}</td>
                      </tr>
                    )
                  })}
                  {rows.length === 0 && <tr><td colSpan={17} style={{ textAlign: 'center', padding: '3rem', color: C.muted }}>{status === 'loading' ? 'Loading…' : 'No mailboxes match these filters.'}</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'performance' && status !== 'error' && data && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginTop: '.5rem' }}>
            {/* By-supplier cards */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: C.muted, margin: '0 0 .5rem' }}>By supplier — who performs best</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: '1rem' }}>
                {data.stats.bySupplier.map(g => <GroupCard key={g.key} g={g} accent={ACCENT[g.key] || C.navy} />)}
              </div>
            </div>

            {/* Trend charts */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '.25rem 0 .5rem' }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: C.muted }}>Performance trends</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {PERIODS.map(p => <button key={p.key} onClick={() => setPeriodDays(p.key)} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `1px solid ${C.border}`, background: periodDays === p.key ? C.navy : '#fff', color: periodDays === p.key ? '#fff' : C.muted }}>{p.label}</button>)}
                </div>
              </div>
              {history && Object.keys(history.series).length > 0 && history.days.length > 1 ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: '1rem' }}>
                  <ChartCard title="Reply rate %"><LineChart labels={history.days} series={Object.entries(history.series).map(([k, s], i) => ({ label: k, data: s.reply_rate.map(v => v * 100), tone: ((i % 5 + 1) as 1 | 2 | 3 | 4 | 5), percent: true }))} /></ChartCard>
                  <ChartCard title="Bounce rate %"><LineChart labels={history.days} series={Object.entries(history.series).map(([k, s], i) => ({ label: k, data: s.bounce_rate.map(v => v * 100), tone: ((i % 5 + 1) as 1 | 2 | 3 | 4 | 5), percent: true }))} /></ChartCard>
                  <ChartCard title="Total sent"><LineChart labels={history.days} series={Object.entries(history.series).map(([k, s], i) => ({ label: k, data: s.sent, tone: ((i % 5 + 1) as 1 | 2 | 3 | 4 | 5) }))} /></ChartCard>
                </div>
              ) : <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, padding: '2rem', textAlign: 'center', fontSize: 13, color: C.muted }}>Trend charts fill in as daily snapshots accumulate.</div>}
            </div>

            {/* By-type cards */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: C.muted, margin: '0 0 .5rem' }}>By type — Google vs Microsoft vs SMTP</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: '1rem' }}>
                {data.stats.byType.map(g => <GroupCard key={g.key} g={g} accent={ACCENT[g.key] || C.navy} />)}
              </div>
            </div>

            {/* Comparison table */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: C.muted, margin: '0 0 .5rem' }}>Comparison · supplier × type</div>
              <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ background: '#F8F9FC' }}><tr><th style={th}>Supplier · Type</th><th style={{ ...th, textAlign: 'right' }}>Mailboxes</th><th style={{ ...th, textAlign: 'right' }}>Active</th><th style={{ ...th, textAlign: 'right' }}>Auth clean</th><th style={{ ...th, textAlign: 'right' }}>BL</th><th style={{ ...th, textAlign: 'right' }}>Sent</th><th style={{ ...th, textAlign: 'right' }}>Reply</th><th style={{ ...th, textAlign: 'right' }}>Bounce</th><th style={{ ...th, textAlign: 'right' }}>Avg daily</th><th style={{ ...th, textAlign: 'right' }}>$/mo</th><th style={{ ...th, textAlign: 'right' }}>Attn</th></tr></thead>
                  <tbody>
                    {data.stats.bySupplierType.map(g => (
                      <tr key={g.key} style={{ background: '#fff' }}>
                        <td style={{ ...td, fontWeight: 600 }}>{g.key}</td>
                        <td style={tdNum}>{num(g.count)}</td><td style={{ ...tdNum, color: '#16A34A' }}>{num(g.active)}</td><td style={tdNum}>{g.auth_clean_pct}%</td>
                        <td style={{ ...tdNum, color: g.blacklist_listed ? '#DC2626' : C.muted }}>{num(g.blacklist_listed)}</td>
                        <td style={tdNum}>{num(g.total_sent)}</td><td style={tdNum}>{pct(g.reply_rate)}</td><td style={tdNum}>{pct(g.bounce_rate)}</td>
                        <td style={tdNum}>{num(g.avg_daily_limit)}</td><td style={tdNum}>{money(g.total_monthly_cost)}</td>
                        <td style={{ ...tdNum, color: g.attention_count ? '#DC2626' : C.muted }}>{num(g.attention_count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({ accent, label, val }: { accent: string; label: string; val: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: 10, padding: '1rem 1.25rem', borderTop: `3px solid ${accent}` }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px', color: '#6B7280' }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: 4 }}>{val}</div>
    </div>
  )
}

function GroupCard({ g, accent }: { g: MailboxGroupStats; accent: string }) {
  const total = g.count || 1
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: 10, padding: '1rem 1.25rem', borderTop: `3px solid ${accent}` }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px', color: '#6B7280' }}>{g.key}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: 4 }}>{g.count.toLocaleString()}</div>
      <div style={{ fontSize: 11, color: '#6B7280', marginTop: 6, lineHeight: 1.5 }}>
        {g.active} active · {g.warmup_pct}% warming<br />
        Reply {(g.reply_rate * 100).toFixed(1)}% · Bounce {(g.bounce_rate * 100).toFixed(1)}%<br />
        Auth clean {g.auth_clean_pct}% · ${g.total_monthly_cost.toFixed(0)}/mo
      </div>
      <div style={{ display: 'flex', height: 6, borderRadius: 3, background: '#F3F4F6', overflow: 'hidden', marginTop: 8 }}>
        <div style={{ height: '100%', width: `${(g.active / total) * 100}%`, background: '#16A34A' }} />
        <div style={{ height: '100%', width: `${(g.paused / total) * 100}%`, background: '#D97706' }} />
        <div style={{ height: '100%', width: `${(g.disconnected / total) * 100}%`, background: '#DC2626' }} />
      </div>
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: 10, padding: '.75rem' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#6B7280', marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  )
}
