'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Logo } from '@/app/components/Logo'

type Folder = 'review' | 'inbox' | 'done' | 'unmapped' | 'rejected'

interface Reply {
  id: string
  bison_team_id: string
  bison_reply_id: string
  workspace_id: string | null
  lead_email: string
  lead_bison_id: string | null
  subject: string | null
  body_preview: string | null
  classify_state: string
  classify_attempts: number
  category: string | null
  confidence: string | number | null
  ai_model: string | null
  ai_reasoning: string | null
  admin_label: string | null
  folder: string
  marked_as_lead: boolean
  marked_by: string | null
  marked_at: string | null
  bison_tag_state: string | null
  received_at: string
  client_id: string | null
  company_name: string | null
  // Lead enrichment (from esp_leads + its raw), for the contact panel.
  first_name: string | null
  last_name: string | null
  lead_company: string | null
  job_title: string | null
  industry: string | null
  city: string | null
  state: string | null
  country: string | null
  company_website: string | null
  linkedin_url: string | null
  linkedin_company_url: string | null
  phone_number: string | null
  is_forwarded: boolean
  sender_email: string | null
  matched_lead_email: string | null
  matched_by: string | null
  body_html: string | null
  body_text: string | null
}

interface PortalClientLite { id: string; company_name: string; workspace_id: string }

const FOLDERS: { key: Folder; label: string }[] = [
  { key: 'review', label: 'Review' },
  { key: 'inbox', label: 'Inbox' },
  { key: 'done', label: 'Done' },
  { key: 'unmapped', label: 'Unmapped' },
  { key: 'rejected', label: 'Rejected' },
]

const CATEGORIES = ['interested', 'not_interested', 'ooo_auto_reply', 'question', 'unsubscribe', 'warmup', 'other']

const CAT_STYLE: Record<string, string> = {
  interested: 'bg-green-100 text-green-700',
  not_interested: 'bg-gray-100 text-gray-600',
  ooo_auto_reply: 'bg-blue-100 text-blue-700',
  question: 'bg-amber-100 text-amber-700',
  unsubscribe: 'bg-red-100 text-red-700',
  warmup: 'bg-purple-100 text-purple-700',
  other: 'bg-slate-100 text-slate-600',
}

// Label filter chips (no Question tab per request). key = effective category value.
const LABEL_FILTERS: { key: string; label: string }[] = [
  { key: 'interested', label: 'Leads' },
  { key: 'not_interested', label: 'Not interested' },
  { key: 'ooo_auto_reply', label: 'OOO' },
  { key: 'unsubscribe', label: 'Unsubscribe' },
  { key: 'warmup', label: 'Warm-up' },
  { key: 'other', label: 'Other' },
]

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function CategoryBadge({ category, confidence }: { category: string | null; confidence: string | number | null }) {
  if (!category) return <span className="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-400">unclassified</span>
  const conf = confidence == null ? null : Math.round(Number(confidence) * 100)
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${CAT_STYLE[category] ?? CAT_STYLE.other}`}>
      {category.replace(/_/g, ' ')}{conf != null ? ` · ${conf}%` : ''}
    </span>
  )
}

export function AdminUniboxClient() {
  const router = useRouter()
  const [folder, setFolder] = useState<Folder>('review')
  const [rows, setRows] = useState<Reply[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({})
  const [category, setCategory] = useState('')    // active label filter ('' = none)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [query, setQuery] = useState('')          // search box text
  const [activeQuery, setActiveQuery] = useState('') // the query actually applied
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Reply | null>(null)
  const [clients, setClients] = useState<PortalClientLite[]>([])
  const [pickClientId, setPickClientId] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  // Associate-to-campaign panel state.
  const [assocOpen, setAssocOpen] = useState(false)
  const [assocLoading, setAssocLoading] = useState(false)
  const [campaigns, setCampaigns] = useState<{ id: number; name: string; status?: string | null }[]>([])
  const [assocPick, setAssocPick] = useState<string>('')
  const [assocSuggest, setAssocSuggest] = useState<{ id: number | null; reason: string }>({ id: null, reason: '' })

  const load = useCallback(async (f: Folder, cursor?: string, q?: string, cat?: string) => {
    setLoading(true)
    try {
      const u = new URL('/api/admin/unibox/list', window.location.origin)
      u.searchParams.set('folder', f)
      u.searchParams.set('limit', '50')
      if (cursor) u.searchParams.set('before', cursor)
      if (q && q.trim()) u.searchParams.set('q', q.trim())
      if (cat) u.searchParams.set('category', cat)
      const r = await fetch(u.toString())
      if (r.status === 401) { router.push('/admin/login'); return }
      const d = await r.json() as { rows: Reply[]; nextCursor: string | null; counts: Record<string, number>; categoryCounts?: Record<string, number> }
      setRows(prev => cursor ? [...prev, ...d.rows] : d.rows)
      setNextCursor(d.nextCursor)
      setCounts(d.counts ?? {})
      if (d.categoryCounts) setCategoryCounts(d.categoryCounts)
    } finally {
      setLoading(false)
    }
  }, [router])

  // Reload when folder, search, or label filter changes.
  useEffect(() => { load(folder, undefined, activeQuery, category) }, [folder, activeQuery, category, load])

  function runSearch() {
    setSelected(null)
    setActiveQuery(query.trim())
  }
  function clearSearch() {
    setQuery('')
    setActiveQuery('')
  }
  // Toggle a label filter; clicking the active one clears it.
  function toggleCategory(c: string) {
    setSelected(null)
    setCategory(prev => prev === c ? '' : c)
  }

  useEffect(() => {
    fetch('/api/admin/clients')
      .then(r => r.ok ? r.json() : [])
      .then((d: PortalClientLite[]) => setClients(Array.isArray(d) ? d : []))
      .catch(() => {})
  }, [])

  function selectReply(r: Reply) {
    setSelected(r)
    setMsg('')
    // Prefill the picker from the reply's mapped client.
    setPickClientId(r.client_id ?? '')
  }

  async function markAsLead() {
    if (!selected) return
    setBusy(true); setMsg('')
    try {
      const r = await fetch(`/api/admin/unibox/${selected.id}/mark-as-lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pickClientId ? { clientId: pickClientId } : {}),
      })
      const d = await r.json() as { ok?: boolean; already?: boolean; error?: string; bison_tag_state?: string }
      if (!r.ok || !d.ok) { setMsg(d.error ?? 'Failed to mark as lead'); return }
      setMsg(d.already ? 'Already marked as a lead.' : `Marked as lead${d.bison_tag_state ? ` (tag: ${d.bison_tag_state})` : ''}.`)
      await load(folder)
      setSelected(null)
    } finally {
      setBusy(false)
    }
  }

  // Open the associate-to-campaign panel: load the client's campaigns + suggestion.
  async function openAssociate() {
    if (!selected) return
    setAssocOpen(true); setAssocLoading(true); setMsg('')
    setCampaigns([]); setAssocPick(''); setAssocSuggest({ id: null, reason: '' })
    try {
      const r = await fetch(`/api/admin/unibox/${selected.id}/associate`)
      const d = await r.json() as {
        ok?: boolean; error?: string
        campaigns?: { id: number; name: string; status?: string | null }[]
        suggestedId?: number | null; suggestedReason?: string; currentId?: number | null
      }
      if (!r.ok || !d.ok) { setMsg(d.error ?? 'Could not load campaigns'); setAssocOpen(false); return }
      setCampaigns(d.campaigns ?? [])
      setAssocSuggest({ id: d.suggestedId ?? null, reason: d.suggestedReason ?? '' })
      // Pre-select: current campaign if any, else the suggestion.
      const pre = d.currentId ?? d.suggestedId ?? null
      setAssocPick(pre != null ? String(pre) : '')
    } finally {
      setAssocLoading(false)
    }
  }

  async function saveAssociate() {
    if (!selected || !assocPick) return
    setBusy(true); setMsg('')
    try {
      const r = await fetch(`/api/admin/unibox/${selected.id}/associate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: assocPick }),
      })
      const d = await r.json() as { ok?: boolean; error?: string }
      if (!r.ok || !d.ok) { setMsg(d.error ?? 'Could not associate'); return }
      const name = campaigns.find(c => String(c.id) === assocPick)?.name ?? assocPick
      setMsg(`Associated with campaign "${name}".`)
      setAssocOpen(false)
    } finally {
      setBusy(false)
    }
  }

  async function reject() {
    if (!selected) return
    setBusy(true); setMsg('')
    try {
      const r = await fetch(`/api/admin/unibox/${selected.id}/reject`, { method: 'POST' })
      const d = await r.json() as { ok?: boolean; error?: string }
      if (!r.ok || !d.ok) { setMsg(d.error ?? 'Failed to reject'); return }
      await load(folder)
      setSelected(null)
    } finally {
      setBusy(false)
    }
  }

  async function setAdminLabel(label: string) {
    if (!selected) return
    setBusy(true); setMsg('')
    try {
      const r = await fetch(`/api/admin/unibox/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_label: label }),
      })
      const d = await r.json() as { ok?: boolean; error?: string; admin_label?: string }
      if (!r.ok || !d.ok) { setMsg(d.error ?? 'Failed to set label'); return }
      setSelected({ ...selected, admin_label: d.admin_label ?? label })
      setRows(rows.map(x => x.id === selected.id ? { ...x, admin_label: d.admin_label ?? label } : x))
    } finally {
      setBusy(false)
    }
  }

  // The category that's in effect = admin override if set, else the AI category.
  // Drives both the highlighted "Correct category" chip and how strongly we push
  // "Mark as lead" (de-emphasized when this isn't 'interested').
  const effectiveCategory = (selected?.admin_label ?? selected?.category) ?? 'other'
  const isInterested = effectiveCategory === 'interested'

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'system-ui,-apple-system,sans-serif' }}>
      {/* Top bar — matches the admin clients header */}
      <header className="h-12 bg-[#1a2332] flex items-center px-6 gap-3">
        <Logo size="sm" onDark />
        <span className="text-slate-500 text-xs">|</span>
        <span className="text-slate-300 text-sm">Master Unibox</span>
        <div className="ml-auto flex items-center gap-4">
          <a href="/admin/clients" className="text-slate-400 hover:text-white text-xs">Clients</a>
          <a href="/admin/unibox" className="text-white text-xs font-medium">Unibox</a>
        </div>
      </header>

      <div className="flex" style={{ height: 'calc(100vh - 3rem)' }}>
        {/* Left: folder tabs + reply list. Full-width on mobile; hidden once a reply
            is open (the detail takes over), restored via the in-detail Back button. */}
        <aside className={`${selected ? 'hidden md:flex' : 'flex'} w-full md:w-[420px] border-r border-gray-200 bg-white flex-col`}>
          <div className="flex border-b border-gray-200 px-2">
            {FOLDERS.map(f => (
              <button
                key={f.key}
                onClick={() => { setSelected(null); setFolder(f.key) }}
                className={`flex items-center gap-1.5 px-3 py-3 text-xs font-medium border-b-2 transition-colors ${folder === f.key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
              >
                {f.label}
                {counts[f.key] ? (
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-600">{counts[f.key]}</span>
                ) : null}
              </button>
            ))}
          </div>

          {/* Label filters (by category, across all folders) */}
          <div className="flex flex-wrap gap-1.5 px-3 py-2 border-b border-gray-200">
            {LABEL_FILTERS.map(c => {
              const active = category === c.key
              const n = categoryCounts[c.key] ?? 0
              return (
                <button
                  key={c.key}
                  onClick={() => toggleCategory(c.key)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${active ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                >
                  {c.label}
                  {n > 0 && <span className={`px-1 rounded-full text-[10px] font-semibold ${active ? 'bg-indigo-200 text-indigo-800' : 'bg-gray-100 text-gray-500'}`}>{n}</span>}
                </button>
              )
            })}
          </div>

          {/* Search across all folders */}
          <div className="px-3 py-2 border-b border-gray-200 bg-gray-50/60">
            <div className="relative flex items-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-2.5 text-gray-400"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') runSearch(); if (e.key === 'Escape') clearSearch() }}
                placeholder="Search replies — name, email, subject, company…"
                className="w-full pl-8 pr-16 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400"
              />
              {activeQuery ? (
                <button onClick={clearSearch} className="absolute right-2 text-xs font-medium text-gray-400 hover:text-gray-700">Clear</button>
              ) : (
                <button onClick={runSearch} disabled={!query.trim()} className="absolute right-2 text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-40">Search</button>
              )}
            </div>
            {activeQuery && (
              <p className="text-[11px] text-gray-500 mt-1.5">Searching all folders for “{activeQuery}” — {rows.length}{nextCursor ? '+' : ''} result{rows.length === 1 ? '' : 's'}</p>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading && rows.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-10">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-10">{activeQuery ? 'No replies match your search.' : category ? 'No replies with this label.' : 'No replies in this folder.'}</p>
            ) : rows.map(r => (
              <button
                key={r.id}
                onClick={() => selectReply(r)}
                className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 ${selected?.id === r.id ? 'bg-indigo-50/60' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-gray-900 truncate">{r.lead_email}</span>
                  <span className="text-[11px] text-gray-400 whitespace-nowrap">{fmtDate(r.received_at)}</span>
                </div>
                <p className="text-xs text-gray-600 truncate mt-0.5">{r.subject || '(no subject)'}</p>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <CategoryBadge category={r.admin_label ?? r.category} confidence={r.confidence} />
                  {r.is_forwarded && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700">Fwd</span>}
                  {r.company_name
                    ? <span className="text-[11px] text-gray-400 truncate">{r.company_name}</span>
                    : <span className="text-[11px] text-amber-600">team {r.bison_team_id}</span>}
                </div>
              </button>
            ))}
            {nextCursor && (
              <button
                onClick={() => load(folder, nextCursor, activeQuery, category)}
                disabled={loading}
                className="w-full py-3 text-xs text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        </aside>

        {/* Right: selected reply detail */}
        <main className={`${selected ? 'flex' : 'hidden md:flex'} flex-1 flex-col overflow-y-auto`}>
          {!selected ? (
            <div className="h-full flex items-center justify-center text-gray-400 text-sm">Select a reply to view it.</div>
          ) : (
            <div className="flex flex-col lg:flex-row gap-6 p-4 sm:p-6 max-w-5xl mx-auto w-full">
             {/* Mobile back button to return to the reply list */}
             <button onClick={() => setSelected(null)} className="md:hidden inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 -mt-1 mb-1">
               <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
               Back to replies
             </button>
             <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-lg font-semibold text-gray-900">{selected.subject || '(no subject)'}</h1>
                  {selected.is_forwarded && (
                    <span className="inline-flex items-center gap-1 mt-1 mb-0.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-violet-100 text-violet-700">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>
                      Forwarded reply
                    </span>
                  )}
                  <p className="text-sm text-gray-500 mt-0.5">
                    From <span className="font-medium text-gray-700">{leadName(selected)}</span> &lt;{selected.lead_email}&gt;
                  </p>
                  {selected.is_forwarded && selected.sender_email && (
                    <p className="text-xs text-violet-600 mt-0.5">
                      Replied by <span className="font-medium">{selected.sender_email}</span>
                      {selected.matched_lead_email ? <> · matched to original lead <span className="font-medium">{selected.matched_lead_email}</span> (by {selected.matched_by})</> : null}
                    </p>
                  )}
                  <p className="text-xs text-gray-400 mt-0.5">
                    {selected.company_name ? `Client: ${selected.company_name}` : `Unmapped — Bison team ${selected.bison_team_id}`}
                    {' · '}{fmtDate(selected.received_at)}
                  </p>
                </div>
                <CategoryBadge category={selected.admin_label ?? selected.category} confidence={selected.confidence} />
              </div>

              {selected.ai_reasoning && (
                <div className="mt-4 text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg p-3">
                  <span className="font-medium text-gray-600">AI:</span> {selected.ai_reasoning}
                  {selected.ai_model ? <span className="text-gray-400"> ({selected.ai_model})</span> : null}
                </div>
              )}

              <div className="mt-4 whitespace-pre-wrap break-words text-sm leading-[1.55] text-gray-800 bg-white border border-gray-200 rounded-xl p-4 max-w-[68ch]">
                {replyBody(selected)}
              </div>

              {/* Classification — correct the AI's category (does NOT take an action) */}
              <div className="mt-5 rounded-lg border border-gray-100 bg-gray-50/60 p-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-gray-600">Correct category</label>
                  <span className="text-[11px] text-gray-400">Classification only — doesn&apos;t mark or reject</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {CATEGORIES.map(c => (
                    <button
                      key={c}
                      onClick={() => setAdminLabel(c)}
                      disabled={busy}
                      className={`px-2.5 py-1 rounded-full text-xs border transition-colors disabled:opacity-50 ${effectiveCategory === c ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                    >
                      {c.replace(/_/g, ' ')}
                    </button>
                  ))}
                </div>
                {selected.admin_label && selected.admin_label !== selected.category && (
                  <p className="text-[11px] text-gray-500 mt-2">Overridden from AI&apos;s &quot;{(selected.category ?? 'unclassified').replace(/_/g, ' ')}&quot;.</p>
                )}
              </div>

              {/* Actions — what to DO with this reply, distinct from classifying it */}
              <div className="mt-5 border-t border-gray-100 pt-5">
                <p className="text-xs font-semibold text-gray-600 mb-3">Action</p>
                {selected.marked_as_lead ? (
                  <div className="text-sm text-green-700 bg-green-50 border border-green-100 rounded-lg p-3">
                    ✓ Marked as lead{selected.marked_at ? ` on ${fmtDate(selected.marked_at)}` : ''}
                    {selected.bison_tag_state ? ` · Bison tag: ${selected.bison_tag_state}` : ''}
                  </div>
                ) : (
                  <>
                    {!isInterested && (
                      <div className="mb-3 flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 mt-0.5"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                        <span>This is classified as <strong>{effectiveCategory.replace(/_/g, ' ')}</strong>, not interested. You can still mark it as a lead, but double-check first.</span>
                      </div>
                    )}
                    <label className="text-xs font-medium text-gray-500">Bill to client</label>
                    <select
                      value={pickClientId}
                      onChange={e => setPickClientId(e.target.value)}
                      className="block w-full mt-1.5 border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="">{selected.company_name ? `${selected.company_name} (mapped)` : 'Select a client…'}</option>
                      {clients.map(c => (
                        <option key={c.id} value={c.id}>{c.company_name}</option>
                      ))}
                    </select>
                    <div className="flex items-center gap-2 mt-4">
                      <button
                        onClick={markAsLead}
                        disabled={busy}
                        title={isInterested ? 'Mark this reply as a real lead' : 'AI thinks this is not interested — mark as lead anyway'}
                        className={`px-4 py-2 text-sm font-medium rounded-lg disabled:opacity-50 ${isInterested
                          ? 'bg-green-600 hover:bg-green-700 text-white'
                          : 'border border-green-300 text-green-700 hover:bg-green-50'}`}
                      >
                        {busy ? 'Working…' : isInterested ? 'Mark as lead' : 'Mark as lead anyway'}
                      </button>
                      <button
                        onClick={reject}
                        disabled={busy}
                        className="px-4 py-2 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        onClick={openAssociate}
                        disabled={busy}
                        title="Link this reply to the right campaign (for forwarded / no-campaign replies)"
                        className="px-4 py-2 border border-indigo-200 text-indigo-700 text-sm font-medium rounded-lg hover:bg-indigo-50 disabled:opacity-50"
                      >
                        Associate to campaign
                      </button>
                    </div>

                    {/* Associate-to-campaign panel */}
                    {assocOpen && (
                      <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
                        <p className="text-sm font-semibold text-gray-900">Associate to campaign</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Client: <span className="font-medium">{selected.company_name ?? `Bison team ${selected.bison_team_id}`}</span> · from the address it was sent to
                        </p>
                        {assocLoading ? (
                          <p className="text-xs text-gray-500 mt-3">Loading campaigns…</p>
                        ) : campaigns.length === 0 ? (
                          <p className="text-xs text-gray-500 mt-3">No campaigns found for this client.</p>
                        ) : (
                          <>
                            {assocSuggest.id != null && (
                              <p className="text-xs text-indigo-700 mt-3">
                                💡 Suggested: <span className="font-medium">{campaigns.find(c => c.id === assocSuggest.id)?.name}</span>
                                {assocSuggest.reason ? ` — ${assocSuggest.reason}` : ''}
                              </p>
                            )}
                            <select
                              value={assocPick}
                              onChange={e => setAssocPick(e.target.value)}
                              className="block w-full mt-2 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                            >
                              <option value="">Choose a campaign…</option>
                              {campaigns.map(c => (
                                <option key={c.id} value={String(c.id)}>
                                  {c.name}{c.id === assocSuggest.id ? '  (suggested)' : ''}
                                </option>
                              ))}
                            </select>
                            <div className="flex items-center gap-2 mt-3">
                              <button
                                onClick={saveAssociate}
                                disabled={busy || !assocPick}
                                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
                              >
                                {busy ? 'Saving…' : 'Associate'}
                              </button>
                              <button
                                onClick={() => setAssocOpen(false)}
                                disabled={busy}
                                className="px-4 py-2 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}
                {msg && <p className="text-xs text-gray-600 mt-3">{msg}</p>}
              </div>
             </div>

             {/* Lead contact panel — full-width below the conversation on mobile,
                 inline on the right at lg+. */}
             <aside className="w-full lg:w-64 shrink-0 order-first lg:order-none">
               <div className="rounded-xl border border-gray-200 bg-white p-4 lg:sticky lg:top-4">
                 <div className="flex items-center gap-3 mb-3">
                   <div className="w-10 h-10 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-sm font-semibold">{leadInitials(selected)}</div>
                   <div className="min-w-0">
                     <p className="text-sm font-semibold text-gray-900 truncate">{leadName(selected)}</p>
                     {selected.job_title && <p className="text-xs text-gray-500 truncate">{selected.job_title}</p>}
                   </div>
                 </div>
                 <dl className="space-y-2 text-xs">
                   <ContactRow label="Email" value={selected.lead_email} href={`mailto:${selected.lead_email}`} />
                   {selected.phone_number && <ContactRow label="Phone" value={selected.phone_number} href={`tel:${selected.phone_number}`} />}
                   {(selected.lead_company || selected.company_website) && <ContactRow label="Company" value={selected.lead_company ?? selected.company_website ?? ''} href={selected.company_website ? ensureUrl(selected.company_website) : undefined} />}
                   {selected.linkedin_url && <ContactRow label="LinkedIn" value="View profile" href={ensureUrl(selected.linkedin_url)} />}
                   {selected.linkedin_company_url && <ContactRow label="Company LinkedIn" value="View page" href={ensureUrl(selected.linkedin_company_url)} />}
                   {selected.industry && <ContactRow label="Industry" value={selected.industry} />}
                   {(selected.city || selected.state || selected.country) && <ContactRow label="Location" value={[selected.city, selected.state, selected.country].filter(Boolean).join(', ')} />}
                 </dl>
               </div>
             </aside>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

function leadName(r: Reply): string {
  const n = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
  return n || r.lead_email
}
function leadInitials(r: Reply): string {
  const a = (r.first_name?.[0] ?? '') + (r.last_name?.[0] ?? '')
  return (a || r.lead_email[0] || '?').toUpperCase()
}
function ensureUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`
}
function replyBody(r: Reply): string {
  const text = (r.body_text && r.body_text.trim())
    || (r.body_html ? r.body_html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim() : '')
    || r.body_preview
    || '(no message body captured)'
  return text.replace(/\n{3,}/g, '\n\n').trim()
}
function ContactRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="text-gray-700 break-words">
        {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:text-indigo-800">{value}</a> : value}
      </dd>
    </div>
  )
}
