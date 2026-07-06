'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { LineChart } from '@/components/ui/themed-chart'
import type { Mailbox, MailboxGroupStats, MailboxesResponse } from '@/types/mailbox'

// Styled to match the admin-legacy mailboxes page (navy/teal palette, rounded
// pills, colored stat-cards, dense table) — deliberately distinct from the rest
// of admin-new's component look. All styling is scoped to this page.

const SUPPLIERS = ['Maildoso', 'Mithun', 'Winnr', 'Winnr Generic', 'Inboxing', 'Google Generic'] as const
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
  'Winnr Generic': '#8B5CF6', 'Google Generic': '#4285F4',
  Unassigned: '#9CA3AF', google: '#EA4335', 'google generic': '#FBBC04', microsoft: '#0078D4', smtp: '#475569',
}

interface DaySeries { sent: number[]; replies: number[]; ooo: number[]; bounces: number[]; contacted: number[] }
interface HistoryResponse { dimension: string; days: string[]; series: Record<string, DaySeries> }
// Billable leads (revenue leads) attributed to each supplier / provider type by
// the mailbox that received the reply. total = all marked leads in window;
// matched = those we could tie to a mailbox; unmatched = pre-portal / no mailbox.
interface LeadsResponse { days: number; total: number; matched: number; unmatched: number; bySupplier: Record<string, number>; byType: Record<string, number>; bySupplierType: Record<string, number> }

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
  const [typeHistory, setTypeHistory] = useState<HistoryResponse | null>(null)
  const [leads, setLeads] = useState<LeadsResponse | null>(null)

  const [search, setSearch] = useState('')
  const [fClient, setFClient] = useState('')
  const [fSupplier, setFSupplier] = useState('')
  const [fType, setFType] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fDmarc, setFDmarc] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [brokenDnsOnly, setBrokenDnsOnly] = useState(false)
  const [sortKey, setSortKey] = useState<string>('')
  const [sortDir, setSortDir] = useState<1 | -1>(1)
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
    fetch(`/api/mailboxes/history?dimension=type&days=${periodDays}`).then(r => r.json()).then(setTypeHistory).catch(() => setTypeHistory(null))
    fetch(`/api/mailboxes/leads?days=${periodDays}`).then(r => r.json()).then(setLeads).catch(() => setLeads(null))
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

  const runBackfill = useCallback(async () => {
    setSyncing(true); setMsg('Backfilling chart history… (a few minutes)')
    try {
      const r = await fetch(`/api/mailboxes/backfill?days=${periodDays}`, { method: 'POST' })
      const d = await r.json()
      setMsg(d.ok ? `Backfilled ${d.rows} trend rows from ${d.mailboxes} mailboxes.` : `Backfill failed: ${d.error}`)
      if (d.ok && tab === 'performance') {
        fetch(`/api/mailboxes/history?dimension=supplier&days=${periodDays}`).then(r => r.json()).then(setHistory).catch(() => {})
        fetch(`/api/mailboxes/history?dimension=type&days=${periodDays}`).then(r => r.json()).then(setTypeHistory).catch(() => {})
      }
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) } finally { setSyncing(false) }
  }, [periodDays, tab])

  const mailboxes = data?.mailboxes ?? []
  const clients = useMemo(() => Array.from(new Set(mailboxes.map(m => m.workspace_name).filter(Boolean))).sort() as string[], [mailboxes])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = mailboxes.filter(m => {
      if (q && !(m.email.toLowerCase().includes(q) || (m.domain || '').toLowerCase().includes(q) || (m.workspace_name || '').toLowerCase().includes(q))) return false
      if (fClient && m.workspace_name !== fClient) return false
      if (fSupplier && (fSupplier === '__unassigned' ? !!m.supplier : m.supplier !== fSupplier)) return false
      if (fType && m.type !== fType) return false
      if (fStatus && (m.status || '').toUpperCase() !== fStatus) return false
      if (fDmarc) {
        const pol = m.auth?.dmarc_present ? (m.auth.dmarc_policy || 'none') : '__missing'
        if (fDmarc === '__missing' ? pol !== '__missing' : pol !== fDmarc) return false
      }
      if (brokenDnsOnly) {
        const a = m.auth
        const broken = !a || !a.spf_present || !a.dkim_present || !a.dmarc_present
        if (!broken) return false
      }
      if (attentionOnly && m.attention.length === 0) return false
      return true
    })
    if (!sortKey) return filtered
    const val = (m: Mailbox): number | string => {
      switch (sortKey) {
        case 'renewal': return m.billing_day ?? 99
        case 'sent': return m.attributed_sent
        case 'reply': return m.reply_rate
        case 'bounce': return m.bounce_rate
        case 'score': return m.domain_score ?? -1
        case 'bl': return m.blacklist_count
        case 'cost': return m.unit_cost ?? -1
        case 'email': return m.email.toLowerCase()
        case 'client': return (m.workspace_name || '').toLowerCase()
        case 'supplier': return (m.supplier || '').toLowerCase()
        default: return 0
      }
    }
    return [...filtered].sort((a, b) => {
      const av = val(a), bv = val(b)
      if (av < bv) return -1 * sortDir
      if (av > bv) return 1 * sortDir
      return 0
    })
  }, [mailboxes, search, fClient, fSupplier, fType, fStatus, fDmarc, brokenDnsOnly, attentionOnly, sortKey, sortDir])

  const toggleSort = (k: string) => { if (sortKey === k) setSortDir(d => (d === 1 ? -1 : 1)); else { setSortKey(k); setSortDir(1) } }
  const sortInd = (k: string) => sortKey === k ? (sortDir === 1 ? ' ↑' : ' ↓') : ''

  const [billingOpen, setBillingOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [pricingOpen, setPricingOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpand = (e: string) => setExpanded(prev => { const n = new Set(prev); n.has(e) ? n.delete(e) : n.add(e); return n })

  // Inline per-row field edit → PUT /meta; optimistic local update.
  const setField = useCallback(async (email: string, field: 'supplier' | 'mailbox_type', value: string) => {
    setData(prev => prev ? { ...prev, mailboxes: prev.mailboxes.map(m => m.email === email ? { ...m, [field === 'mailbox_type' ? 'type' : 'supplier']: value || null } : m) } : prev)
    await fetch('/api/mailboxes/meta', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, field, value: value || null }) }).catch(() => {})
  }, [])

  const enableWarmup = useCallback(async (emails: string[]) => {
    setMsg('Enabling warmup…')
    try {
      const r = await fetch('/api/mailboxes/enable-warmup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emails }) })
      const d = await r.json()
      setMsg(d.ok ? `Warmup enabled on ${d.enabled} mailbox(es).` : `Failed: ${d.error}`)
      if (d.ok) await load()
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
  }, [load])

  const notWarming = useMemo(() => mailboxes.filter(m => (m.status || '').toUpperCase() === 'ACTIVE' && (m.warmup_status || '').toUpperCase() !== 'ACTIVE'), [mailboxes])

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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setAssignOpen(true)} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: C.muted, border: `1px solid ${C.border}` }}>⇪ Bulk assign</button>
            <button onClick={() => setBillingOpen(true)} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: C.muted, border: `1px solid ${C.border}` }}>📅 Set billing</button>
            <button onClick={() => setPricingOpen(true)} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: C.muted, border: `1px solid ${C.border}` }}>$ Pricing</button>
            <button onClick={runBackfill} disabled={syncing} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: C.muted, border: `1px solid ${C.border}`, opacity: syncing ? 0.6 : 1 }}>Backfill charts</button>
            <button onClick={runSync} disabled={syncing} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: C.navy, color: '#fff', border: 'none', opacity: syncing ? 0.6 : 1 }}>{syncing ? 'Syncing…' : '↻ Refresh'}</button>
          </div>
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

        {/* Not-on-warmup alert banner */}
        {notWarming.length > 0 && (
          <div style={{ marginBottom: 12, background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 10, padding: '.7rem 1rem', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: '#92400E', fontWeight: 600 }}>⚠ {notWarming.length} active mailbox{notWarming.length === 1 ? '' : 'es'} not running warmup</span>
            <button onClick={() => enableWarmup(notWarming.map(m => m.email))} style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: '#D97706', color: '#fff', border: 'none' }}>Enable warmup for all</button>
          </div>
        )}
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
              <select value={fDmarc} onChange={e => setFDmarc(e.target.value)} style={selStyle}><option value="">All DMARC</option><option value="none">p=none</option><option value="quarantine">p=quarantine</option><option value="reject">p=reject</option><option value="__missing">Missing</option></select>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.muted }}><input type="checkbox" checked={attentionOnly} onChange={e => setAttentionOnly(e.target.checked)} /> Needs attention only</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.muted }}><input type="checkbox" checked={brokenDnsOnly} onChange={e => setBrokenDnsOnly(e.target.checked)} /> Broken DNS only</label>
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
                <button onClick={async () => { if (!selected.size || !confirm(`Remove ${selected.size} mailbox(es) from the dashboard?`)) return; await fetch('/api/mailboxes/bulk-remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emails: Array.from(selected) }) }); setSelected(new Set()); await load() }} disabled={!selected.size} style={{ padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: '#DC2626', border: '1px solid #FECACA', opacity: !selected.size ? 0.5 : 1 }}>Remove</button>
                <button onClick={() => setBillingOpen(true)} style={{ padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: C.muted, border: `1px solid ${C.border}` }}>Set billing</button>
              </div>
            </div>

            {/* Table */}
            <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ background: '#F8F9FC' }}>
                  <tr>
                    <th style={{ ...th, width: 34 }}></th>
                    <th style={{ ...th, cursor: 'pointer' }} onClick={() => toggleSort('email')}>Mailbox{sortInd('email')}</th>
                    <th style={{ ...th, cursor: 'pointer' }} onClick={() => toggleSort('client')}>Client{sortInd('client')}</th>
                    <th style={{ ...th, cursor: 'pointer' }} onClick={() => toggleSort('renewal')}>Renewal{sortInd('renewal')}</th>
                    <th style={{ ...th, cursor: 'pointer' }} onClick={() => toggleSort('supplier')}>Supplier{sortInd('supplier')}</th>
                    <th style={th}>Type</th><th style={th}>Status</th><th style={th}>Warmup</th><th style={th}>Auth</th>
                    <th style={{ ...th, textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('bl')}>BL{sortInd('bl')}</th>
                    <th style={{ ...th, textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('score')}>Score{sortInd('score')}</th>
                    <th style={{ ...th, textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('sent')}>Sent{sortInd('sent')}</th>
                    <th style={{ ...th, textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('reply')}>Reply{sortInd('reply')}</th>
                    <th style={{ ...th, textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('bounce')}>Bounce{sortInd('bounce')}</th>
                    <th style={{ ...th, textAlign: 'right' }}>Daily</th>
                    <th style={{ ...th, textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('cost')}>$/mo{sortInd('cost')}</th><th style={th}>Attn</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(m => {
                    const r = renewalInfo(m)
                    return (
                    <React.Fragment key={m.email}>
                      <tr style={{ background: '#fff' }} onMouseEnter={e => (e.currentTarget.style.background = '#FAFBFF')} onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
                        <td style={td}><input type="checkbox" checked={selected.has(m.email)} onChange={() => toggleOne(m.email)} /></td>
                        <td style={td}><div style={{ fontWeight: 600 }}>{m.email}</div>{m.name && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{m.name}</div>}</td>
                        <td style={{ ...td, color: C.muted }}>{m.workspace_name || '—'}</td>
                        <td style={td}>{r ? <span style={{ color: r.urgent ? '#D97706' : C.muted, fontWeight: r.urgent ? 600 : 400 }}>{r.label}</span> : <span style={{ color: C.muted }}>—</span>}</td>
                        <td style={td}>
                          <select value={m.supplier || ''} onChange={e => setField(m.email, 'supplier', e.target.value)} style={{ padding: '3px 4px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, background: '#fff', minWidth: 90 }}>
                            <option value="">—</option>{SUPPLIERS.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </td>
                        <td style={td}>
                          <select value={m.type} onChange={e => setField(m.email, 'mailbox_type', e.target.value)} style={{ padding: '3px 4px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, background: '#fff', minWidth: 90 }}>
                            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                          {m.type_auto && m.type_auto !== m.type && <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>auto: {m.type_auto}</div>}
                        </td>
                        <td style={td}>{statusPill(m.status)}</td>
                        <td style={td}>{(m.warmup_status || '').toUpperCase() === 'ACTIVE' ? <Pill tone="good">on</Pill> : <Pill tone="gray">off</Pill>}</td>
                        <td style={{ ...td, cursor: m.auth ? 'pointer' : 'default' }} onClick={() => m.auth && toggleExpand(m.email)} title="Click for DNS detail">{m.auth ? <span><AuthBadge ok={m.auth.spf_present} label="S" /><AuthBadge ok={m.auth.dkim_present} label="K" /><AuthBadge ok={m.auth.dmarc_present} label={m.auth.dmarc_policy ? `p=${m.auth.dmarc_policy}` : 'D'} /></span> : <span style={{ color: C.muted }}>—</span>}</td>
                        <td style={tdNum}><span style={{ color: m.blacklist_count ? '#DC2626' : '#16A34A', fontWeight: 600 }}>{m.blacklist_count}</span></td>
                        <td style={tdNum}>{m.domain_score == null ? <span style={{ color: C.muted }}>—</span> : <span style={{ color: m.domain_score >= 80 ? '#16A34A' : m.domain_score >= 50 ? '#D97706' : '#DC2626' }}>{m.domain_score}</span>}</td>
                        <td style={tdNum}>{num(m.attributed_sent)}</td>
                        <td style={tdNum}>{m.attributed_sent ? <b>{pct(m.reply_rate)}</b> : <span style={{ color: C.muted }}>—</span>}</td>
                        <td style={tdNum}>{m.attributed_sent ? <span style={{ color: m.bounce_rate > 0.05 ? '#DC2626' : 'inherit', fontWeight: m.bounce_rate > 0.05 ? 700 : 400 }}>{pct(m.bounce_rate)}</span> : <span style={{ color: C.muted }}>—</span>}</td>
                        <td style={tdNum}>{m.daily_limit == null ? <span style={{ color: C.muted }}>—</span> : num(m.daily_limit)}</td>
                        <td style={{ ...tdNum, color: C.muted }}>{money(m.unit_cost)}</td>
                        <td style={td}>{m.attention.length === 0 ? <span style={{ color: '#16A34A' }}>✓</span> : <span style={{ color: '#DC2626', fontWeight: 600 }} title={m.attention.map(a => a.msg).join(', ')}>● {m.attention.length}</span>}</td>
                      </tr>
                      {expanded.has(m.email) && m.auth && (
                        <tr style={{ background: '#F8F9FC' }}>
                          <td colSpan={17} style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}` }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16, fontSize: 11 }}>
                              <DnsCol title="SPF" present={m.auth.spf_present} raw={m.auth.spf_raw} />
                              <DnsCol title="DKIM" present={m.auth.dkim_present} raw={m.auth.dkim_raw} extra={m.auth.dkim_selector ? `selector: ${m.auth.dkim_selector}` : null} />
                              <DnsCol title="DMARC" present={m.auth.dmarc_present} raw={m.auth.dmarc_raw} extra={m.auth.dmarc_policy ? `policy: p=${m.auth.dmarc_policy}` : null} />
                            </div>
                            {m.domain_notes && <div style={{ marginTop: 8, color: C.muted }}>Notes: {m.domain_notes}</div>}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
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
            {/* Period toggle */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
              {PERIODS.map(p => <button key={p.key} onClick={() => setPeriodDays(p.key)} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `1px solid ${C.border}`, background: periodDays === p.key ? C.navy : '#fff', color: periodDays === p.key ? '#fff' : C.muted }}>{p.label}</button>)}
            </div>

            {/* Leads attribution note */}
            {leads && (
              <div style={{ fontSize: 12, color: C.muted, background: '#F5F3FF', border: '1px solid #E9E4FF', borderRadius: 8, padding: '.5rem .75rem' }}>
                <span style={{ color: '#7C3AED', fontWeight: 600 }}>Leads</span> = billable leads (the ones counted in revenue), attributed to the supplier / provider of the mailbox that got the reply.{' '}
                <b>{leads.matched.toLocaleString()}</b> of {leads.total.toLocaleString()} leads in this window are tied to a mailbox{leads.unmatched > 0 ? <> · <b>{leads.unmatched.toLocaleString()}</b> can’t be attributed (marked before the client portal / mailbox removed) and aren’t shown per-provider</> : null}.
              </div>
            )}

            {/* By provider type — combined stat + chart cards */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: C.muted, margin: '0 0 .5rem' }}>By provider type (Google / Microsoft / SMTP)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: '1rem' }}>
                {data.stats.byType.map(g => <ProviderCard key={g.key} g={g} accent={ACCENT[g.key] || C.navy} days={typeHistory?.days ?? []} ds={typeHistory?.series[g.key]} leads={leads?.byType[g.key]} />)}
              </div>
            </div>

            {/* By supplier — combined stat + chart cards */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: C.muted, margin: '0 0 .5rem' }}>By supplier (Winnr / Maildoso / Mithun)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: '1rem' }}>
                {data.stats.bySupplier.map(g => <ProviderCard key={g.key} g={g} accent={ACCENT[g.key] || C.navy} days={history?.days ?? []} ds={history?.series[g.key]} leads={leads?.bySupplier[g.key]} />)}
              </div>
            </div>

            {/* Comparison table */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: C.muted, margin: '0 0 .5rem' }}>Comparison · supplier × type</div>
              <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ background: '#F8F9FC' }}><tr><th style={th}>Supplier · Type</th><th style={{ ...th, textAlign: 'right' }}>Mailboxes</th><th style={{ ...th, textAlign: 'right' }}>Active</th><th style={{ ...th, textAlign: 'right' }}>Auth clean</th><th style={{ ...th, textAlign: 'right' }}>BL</th><th style={{ ...th, textAlign: 'right' }}>Sent</th><th style={{ ...th, textAlign: 'right' }}>Leads</th><th style={{ ...th, textAlign: 'right' }}>Reply</th><th style={{ ...th, textAlign: 'right' }}>Bounce</th><th style={{ ...th, textAlign: 'right' }}>Avg daily</th><th style={{ ...th, textAlign: 'right' }}>$/mo</th><th style={{ ...th, textAlign: 'right' }}>Attn</th></tr></thead>
                  <tbody>
                    {data.stats.bySupplierType.map(g => (
                      <tr key={g.key} style={{ background: '#fff' }}>
                        <td style={{ ...td, fontWeight: 600 }}>{g.key}</td>
                        <td style={tdNum}>{num(g.count)}</td><td style={{ ...tdNum, color: '#16A34A' }}>{num(g.active)}</td><td style={tdNum}>{g.auth_clean_pct}%</td>
                        <td style={{ ...tdNum, color: g.blacklist_listed ? '#DC2626' : C.muted }}>{num(g.blacklist_listed)}</td>
                        <td style={tdNum}>{num(g.total_sent)}</td>
                        <td style={{ ...tdNum, color: leads?.bySupplierType[g.key] ? '#7C3AED' : C.muted, fontWeight: leads?.bySupplierType[g.key] ? 600 : 400 }}>{leads ? num(leads.bySupplierType[g.key] || 0) : '—'}</td>
                        <td style={tdNum}>{pct(g.reply_rate)}</td><td style={tdNum}>{pct(g.bounce_rate)}</td>
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

        {billingOpen && <BillingModal selectedCount={selected.size} onClose={() => setBillingOpen(false)} onDone={async () => { setBillingOpen(false); await load() }} emails={Array.from(selected)} />}
        {assignOpen && <AssignModal onClose={() => setAssignOpen(false)} onDone={async () => { setAssignOpen(false); await load() }} />}
        {pricingOpen && <PricingModal onClose={() => setPricingOpen(false)} />}
      </div>
    </div>
  )
}

// ── Modals ───────────────────────────────────────────────────────────────────
function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(5,12,41,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 640, width: '100%', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,.2)' }}>{children}</div>
    </div>
  )
}

function BillingModal({ selectedCount, emails, onClose, onDone }: { selectedCount: number; emails: string[]; onClose: () => void; onDone: () => void }) {
  const [target, setTarget] = useState<'selected' | 'supplier' | 'all'>(selectedCount ? 'selected' : 'all')
  const [supplier, setSupplier] = useState('Maildoso')
  const [start, setStart] = useState('')
  const [day, setDay] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const apply = async () => {
    if (!start) { setErr('Start date required'); return }
    setBusy(true); setErr('')
    const body: Record<string, unknown> = { billing_start_date: start }
    if (day) body.billing_day = Number(day)
    if (target === 'selected') body.emails = emails
    else if (target === 'supplier') body.supplier = supplier
    const r = await fetch('/api/mailboxes/bulk-billing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await r.json(); setBusy(false)
    if (!r.ok) { setErr(d.error || 'Failed'); return }
    onDone()
  }
  return (
    <Overlay onClose={onClose}>
      <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Set billing dates</h3>
      <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 16 }}>Set the purchase/renewal date for mailboxes.</p>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Apply to</label>
      <select value={target} onChange={e => setTarget(e.target.value as 'selected' | 'supplier' | 'all')} style={{ width: '100%', padding: 8, border: '1px solid #E2E6F0', borderRadius: 8, marginBottom: 12 }}>
        {selectedCount > 0 && <option value="selected">Selected mailboxes ({selectedCount})</option>}
        <option value="supplier">All mailboxes for a supplier</option>
        <option value="all">All mailboxes</option>
      </select>
      {target === 'supplier' && <select value={supplier} onChange={e => setSupplier(e.target.value)} style={{ width: '100%', padding: 8, border: '1px solid #E2E6F0', borderRadius: 8, marginBottom: 12 }}>{SUPPLIERS.map(s => <option key={s} value={s}>{s}</option>)}</select>}
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Purchase / start date</label>
      <input type="date" value={start} onChange={e => setStart(e.target.value)} style={{ width: '100%', padding: 8, border: '1px solid #E2E6F0', borderRadius: 8, marginBottom: 12 }} />
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Billing day (optional, 1–31)</label>
      <input type="number" min={1} max={31} value={day} onChange={e => setDay(e.target.value)} placeholder="defaults to start date's day" style={{ width: '100%', padding: 8, border: '1px solid #E2E6F0', borderRadius: 8, marginBottom: 12 }} />
      {err && <div style={{ color: '#DC2626', fontSize: 13, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, border: '1px solid #E2E6F0', background: '#fff', cursor: 'pointer' }}>Cancel</button>
        <button onClick={apply} disabled={busy} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: '#224388', color: '#fff', border: 'none', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Applying…' : 'Set billing dates'}</button>
      </div>
    </Overlay>
  )
}

function AssignModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [blocks, setBlocks] = useState<{ supplier: string; entries: string }[]>([{ supplier: 'Maildoso', entries: '' }])
  const [def, setDef] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const apply = async () => {
    setBusy(true); setErr('')
    const supplierDomains: Record<string, string[]> = {}, supplierEmails: Record<string, string[]> = {}
    for (const b of blocks) {
      const lines = b.entries.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
      for (const l of lines) {
        if (l.includes('@')) (supplierEmails[b.supplier] ||= []).push(l)
        else (supplierDomains[b.supplier] ||= []).push(l)
      }
    }
    const r = await fetch('/api/mailboxes/assign-suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplierDomains, supplierEmails, defaultSupplier: def ? 'Mithun' : null }) })
    const d = await r.json(); setBusy(false)
    if (!r.ok) { setErr(d.error || 'Failed'); return }
    onDone()
  }
  return (
    <Overlay onClose={onClose}>
      <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Bulk assign suppliers</h3>
      <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 16 }}>Paste domains or emails (one per line) for each supplier. Domains match a mailbox’s domain; emails match exactly.</p>
      {blocks.map((b, i) => (
        <div key={i} style={{ border: '1px solid #E2E6F0', borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <select value={b.supplier} onChange={e => setBlocks(bs => bs.map((x, j) => j === i ? { ...x, supplier: e.target.value } : x))} style={{ padding: 6, border: '1px solid #E2E6F0', borderRadius: 6 }}>{SUPPLIERS.map(s => <option key={s} value={s}>{s}</option>)}</select>
            {blocks.length > 1 && <button onClick={() => setBlocks(bs => bs.filter((_, j) => j !== i))} style={{ marginLeft: 'auto', color: '#DC2626', background: 'none', border: 'none', cursor: 'pointer' }}>×</button>}
          </div>
          <textarea value={b.entries} onChange={e => setBlocks(bs => bs.map((x, j) => j === i ? { ...x, entries: e.target.value } : x))} rows={4} placeholder="example.com&#10;jane@example.com" style={{ width: '100%', padding: 8, border: '1px solid #E2E6F0', borderRadius: 6, fontSize: 12, fontFamily: 'monospace' }} />
        </div>
      ))}
      <button onClick={() => setBlocks(bs => [...bs, { supplier: 'Winnr', entries: '' }])} style={{ fontSize: 12, color: '#224388', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 12 }}>+ Add supplier block</button>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 12 }}><input type="checkbox" checked={def} onChange={e => setDef(e.target.checked)} /> Default everything else to Mithun</label>
      {err && <div style={{ color: '#DC2626', fontSize: 13, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, border: '1px solid #E2E6F0', background: '#fff', cursor: 'pointer' }}>Cancel</button>
        <button onClick={apply} disabled={busy} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: '#224388', color: '#fff', border: 'none', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Applying…' : 'Apply assignments'}</button>
      </div>
    </Overlay>
  )
}

interface PriceRow { supplier: string; mailbox_type: string; unit_cost: number | null; notes?: string }
function PricingModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<PriceRow[]>([])
  const [msg, setMsg] = useState('')
  useEffect(() => { fetch('/api/mailboxes/pricing').then(r => r.json()).then(setRows).catch(() => {}) }, [])
  const save = async (r: PriceRow) => {
    const res = await fetch('/api/mailboxes/pricing', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) })
    setMsg(res.ok ? `Saved ${r.supplier} · ${r.mailbox_type}` : 'Save failed')
  }
  const del = async (r: PriceRow) => {
    await fetch('/api/mailboxes/pricing', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplier: r.supplier, mailbox_type: r.mailbox_type }) })
    setRows(rs => rs.filter(x => !(x.supplier === r.supplier && x.mailbox_type === r.mailbox_type)))
  }
  return (
    <Overlay onClose={onClose}>
      <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Mailbox pricing</h3>
      <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 16 }}>$/mailbox/month per supplier × type. Drives the $/mo column on the next sync.</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr><th style={{ textAlign: 'left', padding: 6 }}>Supplier</th><th style={{ textAlign: 'left', padding: 6 }}>Type</th><th style={{ textAlign: 'left', padding: 6 }}>$/mo</th><th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ padding: 4 }}><select value={r.supplier} onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, supplier: e.target.value } : x))} style={{ padding: 4, border: '1px solid #E2E6F0', borderRadius: 6 }}>{SUPPLIERS.map(s => <option key={s} value={s}>{s}</option>)}</select></td>
              <td style={{ padding: 4 }}><select value={r.mailbox_type} onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, mailbox_type: e.target.value } : x))} style={{ padding: 4, border: '1px solid #E2E6F0', borderRadius: 6 }}>{TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></td>
              <td style={{ padding: 4 }}><input type="number" step="0.01" value={r.unit_cost ?? ''} onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, unit_cost: e.target.value === '' ? null : Number(e.target.value) } : x))} style={{ width: 80, padding: 4, border: '1px solid #E2E6F0', borderRadius: 6 }} /></td>
              <td style={{ padding: 4 }}><button onClick={() => save(r)} style={{ fontSize: 11, color: '#224388', background: 'none', border: 'none', cursor: 'pointer' }}>Save</button> <button onClick={() => del(r)} style={{ fontSize: 11, color: '#DC2626', background: 'none', border: 'none', cursor: 'pointer' }}>Del</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={() => setRows(rs => [...rs, { supplier: 'Maildoso', mailbox_type: 'google', unit_cost: null }])} style={{ fontSize: 12, color: '#224388', background: 'none', border: 'none', cursor: 'pointer', marginTop: 8 }}>+ Add row</button>
      {msg && <div style={{ fontSize: 12, color: '#6B7280', marginTop: 8 }}>{msg}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}><button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, border: '1px solid #E2E6F0', background: '#fff', cursor: 'pointer' }}>Close</button></div>
    </Overlay>
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

function DnsCol({ title, present, raw, extra }: { title: string; present: boolean; raw: string | null; extra?: string | null }) {
  return (
    <div>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>{title} {present ? <span style={{ color: '#16A34A' }}>✓ present</span> : <span style={{ color: '#DC2626' }}>✕ missing</span>}</div>
      {extra && <div style={{ color: '#6B7280' }}>{extra}</div>}
      {raw && <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#374151', wordBreak: 'break-all', marginTop: 2 }}>{raw}</div>}
    </div>
  )
}

const sum = (a: number[] | undefined) => (a ?? []).reduce((s, v) => s + v, 0)

// Combined per-group card: window-total stats (SENT, human RR, RR+OOO, bounce)
// + a toggleable daily multi-line chart (Sent / RR human / RR+OOO). Click a
// legend item to hide/show that series — see results per day for what's left.
function ProviderCard({ g, accent, days, ds, leads }: { g: MailboxGroupStats; accent: string; days: string[]; ds?: DaySeries; leads?: number }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const toggle = (k: string) => setHidden(p => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n })

  // Window totals (from the daily series if present, else the point-in-time agg).
  const tSent = ds ? sum(ds.sent) : g.total_sent
  const tReplies = ds ? sum(ds.replies) : 0
  const tOoo = ds ? sum(ds.ooo) : 0
  const tBounces = ds ? sum(ds.bounces) : 0
  const tContacted = ds ? sum(ds.contacted) || tSent : tSent
  // PV's total_reply_count (stored as `replies`) is ALREADY the human/non-OOO
  // count; total_ooo (`ooo`) is a SEPARATE additive bucket. So:
  //   Human RR     = replies / contacted        (do NOT subtract ooo → went negative)
  //   RR incl OOO  = (replies + ooo) / contacted
  const human = tContacted > 0 ? tReplies / tContacted : 0
  const withOoo = tContacted > 0 ? (tReplies + tOoo) / tContacted : (ds ? 0 : g.reply_rate)
  const bounceRate = tSent > 0 ? tBounces / tSent : g.bounce_rate

  // Daily series for the chart (percentages computed per-day).
  const dailyHuman = days.map((_, i) => { const c = ds?.contacted[i] || ds?.sent[i] || 0; return c > 0 ? (ds!.replies[i] / c) * 100 : 0 })
  const dailyWithOoo = days.map((_, i) => { const c = ds?.contacted[i] || ds?.sent[i] || 0; return c > 0 ? ((ds!.replies[i] + ds!.ooo[i]) / c) * 100 : 0 })
  const series = [
    { key: 'Sent', label: 'Sent', data: (ds?.sent ?? []).map(Number), color: accent, percent: false },
    { key: 'RR human', label: 'RR human', data: dailyHuman, color: '#16A34A', percent: true },
    { key: 'RR+OOO', label: 'RR+OOO', data: dailyWithOoo, color: '#3B82F6', percent: true },
  ].filter(s => !hidden.has(s.key))

  const Stat = ({ v, l, color }: { v: string; l: string; color?: string }) => (
    <div><div style={{ fontSize: 18, fontWeight: 700, color: color || '#050C29' }}>{v}</div><div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '.3px', lineHeight: 1.2 }}>{l}</div></div>
  )
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E6F0', borderRadius: 10, padding: '1rem 1.1rem', borderTop: `3px solid ${accent}` }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>{g.key} · <span style={{ color: '#6B7280', fontWeight: 500 }}>{g.count} mailboxes</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 8, marginBottom: 10 }}>
        <Stat v={tSent.toLocaleString()} l="Sent" />
        <Stat v={leads == null ? '—' : leads.toLocaleString()} l="Leads" color="#7C3AED" />
        <Stat v={(human * 100).toFixed(2) + '%'} l="RR (human)" color="#16A34A" />
        <Stat v={(withOoo * 100).toFixed(2) + '%'} l="RR incl. OOO" color="#3B82F6" />
        <Stat v={(bounceRate * 100).toFixed(2) + '%'} l="Bounce" />
      </div>
      {days.length > 1 ? (
        <>
          <LineChart labels={days} series={series.length ? series : [{ label: '', data: days.map(() => 0) }]} height={150} />
          <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
            {['Sent', 'RR human', 'RR+OOO'].map(k => (
              <button key={k} onClick={() => toggle(k)} style={{ fontSize: 11, cursor: 'pointer', background: 'none', border: 'none', color: hidden.has(k) ? '#9CA3AF' : '#374151', textDecoration: hidden.has(k) ? 'line-through' : 'none' }}>
                {k}
              </button>
            ))}
          </div>
        </>
      ) : <div style={{ fontSize: 12, color: '#9CA3AF', padding: '1rem 0', textAlign: 'center' }}>Chart fills in after a backfill / daily syncs.</div>}
    </div>
  )
}
