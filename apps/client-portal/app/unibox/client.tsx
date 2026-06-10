'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'

interface Lead {
  id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  company_name: string | null
  status: string
  label: string | null
  first_replied_at: string | null
  created_at: string | null
  campaign_name: string | null
  job_title: string | null
  department: string | null
  industry: string | null
  city: string | null
  state: string | null
  country: string | null
  address_line: string | null
  company_website: string | null
  linkedin_url: string | null
  linkedin_company_url: string | null
  phone_number: string | null
  deal_value: string | null
  deal_notes: string | null
  client_label: string | null
  dispute_status: string | null
  dispute_reason: string | null
  dispute_admin_note: string | null
  has_unread: boolean
  dispute_eligible: boolean
}

interface ThreadMsg {
  id: string
  direction: 'IN' | 'OUT'
  subject: string | null
  body_html: string | null
  body_text: string | null
  content_preview: string | null
  from_email: string | null
  to_email: string | null
  eaccount: string | null
  pv_label: string | null
  sent_via_portal: boolean
  timestamp_created: string | null
}

interface CustomLabel { id: string; name: string; color: string; prompts_value?: boolean }

const COLOR_MAP: Record<string, string> = {
  purple: 'bg-purple-400', pink: 'bg-pink-400', orange: 'bg-orange-400',
  cyan: 'bg-cyan-400', lime: 'bg-lime-400', rose: 'bg-rose-400',
  green: 'bg-green-400', blue: 'bg-blue-400', teal: 'bg-teal-400',
  red: 'bg-red-400', gray: 'bg-gray-400', yellow: 'bg-yellow-400',
}
const COLOR_BADGE: Record<string, string> = {
  purple: 'bg-purple-100 text-purple-700', pink: 'bg-pink-100 text-pink-700',
  orange: 'bg-orange-100 text-orange-700', cyan: 'bg-cyan-100 text-cyan-700',
  lime: 'bg-lime-100 text-lime-700', rose: 'bg-rose-100 text-rose-700',
}
const CUSTOM_COLORS = Object.keys(COLOR_BADGE)

const NONLEAD_CATEGORIES = ['No response after follow-ups', 'Out of office / auto-reply only', 'Not interested', 'Wrong contact / left company', 'Spam or invalid']
const ICP_CATEGORIES = ['Wrong industry', 'Wrong job role / seniority', 'Wrong location', 'Wrong company size', 'Not our target market']
const AV = ['bg-indigo-100 text-indigo-700','bg-pink-100 text-pink-700','bg-amber-100 text-amber-700','bg-teal-100 text-teal-700','bg-purple-100 text-purple-700','bg-blue-100 text-blue-700','bg-green-100 text-green-700','bg-rose-100 text-rose-700']

function av(id: string) { let h=0; for(let i=0;i<id.length;i++) h=(h+id.charCodeAt(i))%AV.length; return AV[h] }
function initials(l: Lead) {
  return ((l.first_name?.charAt(0) ?? '') + (l.last_name?.charAt(0) ?? '')).toUpperCase() || (l.email ?? '?').charAt(0).toUpperCase()
}
function fullName(l: Lead) {
  return [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || 'Lead'
}
function fmtDate(d: string | null) {
  if (!d) return ''
  const date = new Date(d); const now = new Date()
  const days = Math.floor((now.getTime() - date.getTime()) / 86400000)
  if (days === 0) return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (days < 7) return date.toLocaleDateString('en-GB', { weekday: 'short' })
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
function fmtFull(d: string | null) {
  if (!d) return ''
  return new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
// Split an email body into the new content vs the quoted history below it, so each
// message renders as just its own reply with prior thread tucked into a fold.
function splitQuote(text: string): { main: string; quoted: string } {
  if (!text) return { main: '', quoted: '' }
  const patterns = [
    /\n\s*-{2,}\s*Original Message\s*-{2,}/i,
    /\nOn\s[\s\S]{0,140}?wrote:/,
    /\n_{5,}/,
    /\nFrom:\s.+\n(Sent|Date):\s/i,
  ]
  let idx = -1
  for (const re of patterns) {
    const m = text.match(re)
    if (m && m.index !== undefined && (idx === -1 || m.index < idx)) idx = m.index
  }
  if (idx === -1) return { main: text.trim(), quoted: '' }
  return { main: text.slice(0, idx).trim(), quoted: text.slice(idx).trim() }
}
function cleanCampaign(n: string | null) {
  if (!n) return null
  const s = n.replace(/\s*https?:\/\/\S+/g, '').replace(/_+$/, '').trim()
  const c = s || n
  return c.length > 40 ? c.slice(0, 40) + '…' : c
}

export function UniboxClient({ companyName }: { companyName: string }) {
  const [leads, setLeads] = useState<Lead[] | null>(null)
  const [selected, setSelected] = useState<Lead | null>(null)
  const [thread, setThread] = useState<ThreadMsg[] | null>(null)
  const [customLabels, setCustomLabels] = useState<CustomLabel[]>([])
  const [activeLabel, setActiveLabel] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [balance, setBalance] = useState<{ balance: number; currency: string } | null>(null)

  const [labelDrop, setLabelDrop] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)

  const [replyText, setReplyText] = useState('')
  const [replying, setReplying] = useState(false)
  const [replyMsg, setReplyMsg] = useState('')

  const [dealEdit, setDealEdit] = useState(false)
  const [dealInput, setDealInput] = useState('')

  const [showDispute, setShowDispute] = useState(false)
  const [disputeType, setDisputeType] = useState<'non_lead' | 'icp_mismatch'>('non_lead')
  const [disputeReason, setDisputeReason] = useState('')
  const [disputeCategory, setDisputeCategory] = useState('')
  const [disputeAck, setDisputeAck] = useState(false)
  const [disputeSaving, setDisputeSaving] = useState(false)
  const [disputeError, setDisputeError] = useState('')

  // drag-and-drop of leads onto deal stages
  const [dragLeadId, setDragLeadId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  const [showNewLabel, setShowNewLabel] = useState(false)
  const [newLabelName, setNewLabelName] = useState('')
  const [newLabelColor, setNewLabelColor] = useState('purple')
  const [newLabelPromptsValue, setNewLabelPromptsValue] = useState(false)

  // Stage-triggered deal-value prompt
  const [valueStage, setValueStage] = useState<string | null>(null)
  const [valueInput, setValueInput] = useState('')

  const router = useRouter()

  useEffect(() => {
    loadLeads()
    fetch('/api/portal/labels').then(r => r.json()).then((d) => Array.isArray(d) && setCustomLabels(d)).catch(() => {})
    fetch('/api/portal/balance').then(r => r.json()).then((d) => !d.error && setBalance(d)).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function h(e: MouseEvent) { if (dropRef.current && !dropRef.current.contains(e.target as Node)) setLabelDrop(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  function loadLeads() {
    fetch('/api/portal/leads/all').then(r => r.json()).then((d) => {
      if (Array.isArray(d)) {
        setLeads(d)
        setSelected(prev => prev ? (d.find((l: Lead) => l.id === prev.id) ?? prev) : (d[0] ?? null))
        if (!selected && d[0]) openLead(d[0])
      }
    }).catch(() => setLeads([]))
  }

  function openLead(lead: Lead) {
    setSelected(lead)
    setReplyText(''); setReplyMsg('')
    setDealEdit(false); setDealInput(lead.deal_value ?? '')
    setShowDispute(false); setThread(null)
    setLeads(prev => prev?.map(l => l.id === lead.id ? { ...l, has_unread: false } : l) ?? null)
    fetch(`/api/portal/leads/${lead.id}/thread`).then(r => r.json()).then((d) => {
      setThread(Array.isArray(d) ? d : [])
    }).catch(() => setThread([]))
  }

  async function setClientLabel(leadId: string, label: string | null) {
    setLabelDrop(false)
    setLeads(prev => prev?.map(l => l.id === leadId ? { ...l, client_label: label } : l) ?? null)
    setSelected(prev => prev?.id === leadId ? { ...prev, client_label: label } : prev)
    await fetch(`/api/portal/leads/${leadId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) })

    // If the new stage captures a deal value and we don't have one yet, ask now
    // (never off the bat — only when a lead reaches a value stage).
    const meta = customLabels.find(c => c.name === label)
    if (meta?.prompts_value && selected && selected.id === leadId && !selected.deal_value) {
      setValueInput('')
      setValueStage(label)
    }
  }

  // Drag a lead row onto a stage in the sidebar to assign it.
  async function dropOnStage(name: string | null) {
    const leadId = dragLeadId
    setDragOver(null); setDragLeadId(null)
    if (!leadId) return
    const lead = (leads ?? []).find(l => l.id === leadId) ?? null
    setLeads(prev => prev?.map(l => l.id === leadId ? { ...l, client_label: name } : l) ?? null)
    setSelected(prev => prev?.id === leadId ? { ...prev, client_label: name } : prev)
    await fetch(`/api/portal/leads/${leadId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: name }) })
    // value stage with no value yet → open the lead and prompt
    const meta = customLabels.find(c => c.name === name)
    if (meta?.prompts_value && lead && !lead.deal_value) {
      openLead(lead)
      setValueInput(''); setValueStage(name)
    }
  }

  async function saveDealValue(val: string) {
    if (!selected) return
    await fetch(`/api/portal/leads/${selected.id}/data`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deal_value: val || null }),
    })
    setLeads(prev => prev?.map(l => l.id === selected.id ? { ...l, deal_value: val || null } : l) ?? null)
    setSelected(prev => prev ? { ...prev, deal_value: val || null } : prev)
  }

  async function handleReply() {
    if (!replyText.trim() || !selected) return
    setReplying(true); setReplyMsg('')
    const res = await fetch(`/api/portal/leads/${selected.id}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: replyText }),
    })
    const d = await res.json().catch(() => ({})) as { ok?: boolean; sentLive?: boolean }
    setReplying(false)
    if (d.ok) {
      setReplyText('')
      setReplyMsg(d.sentLive ? 'Reply sent.' : 'Reply received — our team will send it shortly.')
      openLead(selected)
      setTimeout(() => setReplyMsg(''), 4000)
    } else {
      setReplyMsg('Could not send. Please try again.')
    }
  }

  async function handleSaveDeal() {
    await saveDealValue(dealInput)
    setDealEdit(false)
  }

  function openDispute(type: 'non_lead' | 'icp_mismatch') {
    setDisputeType(type); setDisputeReason(''); setDisputeCategory(''); setDisputeAck(false); setDisputeError(''); setShowDispute(true)
  }
  async function handleDisputeSubmit() {
    if (!selected || !disputeCategory || disputeReason.trim().length < 10) return
    if (disputeType === 'non_lead' && !disputeAck) return
    setDisputeSaving(true); setDisputeError('')
    const res = await fetch(`/api/portal/leads/${selected.id}/dispute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: disputeType, category: disputeCategory, reason: disputeReason }),
    })
    setDisputeSaving(false)
    if (!res.ok) {
      const d = await res.json().catch(() => ({})) as { error?: string }
      setDisputeError(d.error ?? 'Could not submit. Please try again.')
      return
    }
    setShowDispute(false)
    setLeads(prev => prev?.map(l => l.id === selected.id ? { ...l, dispute_status: 'pending', dispute_reason: disputeReason } : l) ?? null)
    setSelected(prev => prev ? { ...prev, dispute_status: 'pending', dispute_reason: disputeReason } : prev)
  }

  async function handleCreateLabel() {
    if (!newLabelName.trim()) return
    const res = await fetch('/api/portal/labels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newLabelName.trim(), color: newLabelColor, promptsValue: newLabelPromptsValue }),
    })
    const created = await res.json() as CustomLabel
    setCustomLabels(prev => [...prev, created])
    setNewLabelName(''); setNewLabelColor('purple'); setNewLabelPromptsValue(false); setShowNewLabel(false)
  }

  async function handleDeleteLabel(id: string) {
    await fetch(`/api/portal/labels/${id}`, { method: 'DELETE' })
    setCustomLabels(prev => prev.filter(l => l.id !== id))
  }

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST' }); router.push('/login')
  }

  const counts: Record<string, number> = {}
  for (const l of leads ?? []) if (l.client_label) counts[l.client_label] = (counts[l.client_label] ?? 0) + 1

  const filtered = (leads ?? []).filter(l => {
    const matchLabel = activeLabel === null || l.client_label === activeLabel
    const q = search.toLowerCase()
    return matchLabel && (!q || fullName(l).toLowerCase().includes(q) || (l.company_name ?? '').toLowerCase().includes(q) || (l.email ?? '').toLowerCase().includes(q))
  })

  const labelMeta = (name: string | null) => customLabels.find(c => c.name === name)

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#f7f8fc]" style={{ fontFamily: 'system-ui,-apple-system,sans-serif' }}>
      {/* Top bar */}
      <header className="h-14 bg-white border-b border-gray-200 flex items-center px-5 shrink-0 gap-3">
        <span className="text-[#1a2332] font-bold text-lg">Ottaly</span>
        <span className="text-gray-300">|</span>
        <span className="text-gray-600 text-sm font-medium">{companyName}</span>
        <nav className="flex items-center gap-1 ml-4">
          <span className="px-3 py-1.5 text-indigo-600 bg-indigo-50 text-sm font-medium rounded-lg">Leads</span>
          <a href="/invoices" className="px-3 py-1.5 text-gray-500 hover:text-gray-800 text-sm rounded-lg">Billing &amp; ROI</a>
        </nav>
        <div className="ml-auto flex items-center gap-4">
          {balance && (
            <a href="/invoices" className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-50 hover:bg-gray-100 border border-gray-200">
              <span className="text-xs text-gray-500">Leads left</span>
              <span className={`text-sm font-semibold ${balance.balance <= 0 ? 'text-red-600' : 'text-gray-900'}`}>
                {balance.balance.toLocaleString()}
              </span>
            </a>
          )}
          <button onClick={handleLogout} className="text-gray-400 hover:text-gray-700 text-sm">Sign out</button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Column 1 — sidebar */}
        <aside className="w-56 bg-white border-r border-gray-200 flex flex-col shrink-0">
          <div className="p-3">
            <button
              onClick={() => setActiveLabel(null)}
              onDragOver={e => { if (dragLeadId) { e.preventDefault(); setDragOver('__inbox') } }}
              onDragLeave={() => setDragOver(d => d === '__inbox' ? null : d)}
              onDrop={e => { e.preventDefault(); dropOnStage(null) }}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium ${dragOver === '__inbox' ? 'ring-2 ring-indigo-400 bg-indigo-50' : activeLabel === null ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-50'}`}>
              <span className="flex items-center gap-2">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16v16H4z" opacity="0"/><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
                Inbox
              </span>
              <span className="text-xs text-gray-400">{leads?.length ?? 0}</span>
            </button>
          </div>
          <div className="px-3 flex items-center justify-between">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Deal stages</span>
            <button onClick={() => setShowNewLabel(true)} className="text-gray-400 hover:text-indigo-600" title="Create label">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>
          <div className="px-3 mt-1 flex-1 overflow-y-auto">
            {customLabels.length === 0 && <p className="text-xs text-gray-400 px-1 py-2">No stages yet. Click + to add (e.g. Meeting Booked, Closed).</p>}
            {customLabels.map(cl => (
              <div key={cl.id}
                onClick={() => setActiveLabel(activeLabel === cl.name ? null : cl.name)}
                onDragOver={e => { if (dragLeadId) { e.preventDefault(); setDragOver(cl.id) } }}
                onDragLeave={() => setDragOver(d => d === cl.id ? null : d)}
                onDrop={e => { e.preventDefault(); dropOnStage(cl.name) }}
                className={`group flex items-center justify-between px-3 py-1.5 rounded-lg text-sm cursor-pointer ${dragOver === cl.id ? 'ring-2 ring-indigo-400 bg-indigo-50' : activeLabel === cl.name ? 'bg-gray-100' : 'hover:bg-gray-50'}`}>
                <span className="flex items-center gap-2 text-gray-700">
                  <span className={`w-2.5 h-2.5 rounded-full ${COLOR_MAP[cl.color] ?? 'bg-purple-400'}`} />{cl.name}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-400">{counts[cl.name] ?? 0}</span>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteLabel(cl.id) }} className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                </span>
              </div>
            ))}
          </div>
        </aside>

        {/* Column 2 — lead list */}
        <section className="w-[380px] bg-white border-r border-gray-200 flex flex-col shrink-0">
          <div className="px-4 py-3 border-b border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-gray-900">Your Leads <span className="text-gray-400 font-normal">({filtered.length})</span></h2>
            </div>
            <div className="relative">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-2.5 top-2.5 text-gray-400"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input placeholder="Search leads" value={search} onChange={e => setSearch(e.target.value)} className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-300 bg-gray-50" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {leads === null ? (
              Array.from({ length: 6 }).map((_, i) => <div key={i} className="px-4 py-3 border-b border-gray-50"><div className="h-4 bg-gray-100 rounded animate-pulse mb-2" /><div className="h-3 bg-gray-50 rounded animate-pulse w-2/3" /></div>)
            ) : filtered.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-gray-400">No leads yet</div>
            ) : filtered.map(l => {
              const cl = labelMeta(l.client_label)
              return (
                <button key={l.id} onClick={() => openLead(l)}
                  draggable
                  onDragStart={() => setDragLeadId(l.id)}
                  onDragEnd={() => { setDragLeadId(null); setDragOver(null) }}
                  className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${dragLeadId === l.id ? 'opacity-50' : ''} ${selected?.id === l.id ? 'bg-indigo-50/60' : ''}`}>
                  <div className="flex gap-3">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${av(l.id)}`}>{initials(l)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-sm truncate ${l.has_unread ? 'font-bold text-gray-900' : 'font-medium text-gray-800'}`}>{fullName(l)}</span>
                        <span className="text-[11px] text-gray-400 shrink-0">{fmtDate(l.first_replied_at ?? l.created_at)}</span>
                      </div>
                      <p className="text-xs text-gray-500 truncate">{l.company_name ?? l.email}</p>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        {l.campaign_name && <span className="inline-flex items-center gap-1 text-[10px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded"><svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>{cleanCampaign(l.campaign_name)}</span>}
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-green-100 text-green-700 px-1.5 py-0.5 rounded">Lead</span>
                        {cl && <span className={`inline-flex text-[10px] font-medium px-1.5 py-0.5 rounded ${COLOR_BADGE[cl.color] ?? 'bg-purple-100 text-purple-700'}`}>{cl.name}</span>}
                        {l.dispute_status === 'pending' && <span className="inline-flex text-[10px] font-medium bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Dispute</span>}
                        {l.deal_value && <span className="inline-flex text-[10px] font-medium bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded">£{Number(l.deal_value).toLocaleString()}</span>}
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        {/* Column 3 — thread */}
        <section className="flex-1 flex flex-col min-w-0 bg-white">
          {!selected ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 text-gray-300"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>
              <p className="text-sm">Select a lead to read</p>
            </div>
          ) : (
            <>
              {/* thread header */}
              <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-3 shrink-0">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold ${av(selected.id)}`}>{initials(selected)}</div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{fullName(selected)}</p>
                  {selected.email && <p className="text-xs text-gray-500 truncate">{selected.email}</p>}
                </div>
                {/* deal-stage dropdown */}
                <div className="ml-auto relative" ref={dropRef}>
                  <button onClick={() => setLabelDrop(v => !v)} className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50">
                    {selected.client_label ? <><span className={`w-2 h-2 rounded-full ${COLOR_MAP[labelMeta(selected.client_label)?.color ?? 'purple']}`} />{selected.client_label}</> : <span className="text-gray-500">Set stage</span>}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  {labelDrop && (
                    <div className="absolute right-0 top-full mt-1 w-52 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-20 max-h-72 overflow-y-auto">
                      <button onClick={() => setClientLabel(selected.id, null)} className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-500 hover:bg-gray-50">Not set</button>
                      {customLabels.map(cl => (
                        <button key={cl.id} onClick={() => setClientLabel(selected.id, cl.name)} className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                          <span className={`w-2.5 h-2.5 rounded-full ${COLOR_MAP[cl.color]}`} />{cl.name}
                          {selected.client_label === cl.name && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-auto text-indigo-500"><polyline points="20 6 9 17 4 12"/></svg>}
                        </button>
                      ))}
                      <div className="border-t border-gray-100 mt-1 pt-1">
                        <button onClick={() => { setLabelDrop(false); setShowNewLabel(true) }} className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-indigo-600 hover:bg-indigo-50">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Create stage
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* dispute banners */}
              {selected.dispute_status === 'pending' && <Banner color="amber"><strong>Non-lead request pending review.</strong> {selected.dispute_reason}</Banner>}
              {selected.dispute_status === 'denied' && <Banner color="red"><strong>Non-lead request denied.</strong> {selected.dispute_admin_note ?? ''}</Banner>}
              {selected.dispute_status === 'approved' && <Banner color="green"><strong>Non-lead approved.</strong> Credit refunded.</Banner>}

              {/* thread body — each message its own colour-coded block */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 bg-[#fafbfd]">
                {thread === null ? (
                  <div className="space-y-3">{Array.from({length:2}).map((_,i)=><div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />)}</div>
                ) : thread.length === 0 ? (
                  <div className="text-center text-sm text-gray-400 py-12">No messages synced yet for this lead.</div>
                ) : thread.map(m => {
                  const out = m.direction === 'OUT'
                  const { main, quoted } = splitQuote(m.body_text || m.content_preview || '')
                  return (
                    <div key={m.id} className={`rounded-xl border overflow-hidden shadow-sm ${out ? 'border-indigo-200' : 'border-gray-200'}`}>
                      {/* header strip — indigo = us, grey = the lead */}
                      <div className={`flex items-center gap-2.5 px-4 py-2.5 ${out ? 'bg-indigo-50' : 'bg-gray-50'}`}>
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 ${out ? 'bg-indigo-600 text-white' : av(selected.id)}`}>{out ? 'O' : initials(selected)}</div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-900 leading-tight truncate">{out ? (m.sent_via_portal ? `${companyName} (you)` : 'Ottaly') : fullName(selected)}</p>
                          <p className="text-[11px] text-gray-500 truncate">{out ? `to: ${selected.email}` : (m.from_email ?? selected.email)}</p>
                        </div>
                        <div className="ml-auto flex items-center gap-2 shrink-0">
                          {m.pv_label && m.pv_label !== 'INTERESTED' && <span className="text-[10px] bg-white border border-gray-200 text-gray-500 px-1.5 py-0.5 rounded capitalize">{m.pv_label.replace(/_/g,' ').toLowerCase()}</span>}
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${out ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-200 text-gray-600'}`}>{out ? 'Sent' : 'Received'}</span>
                          <span className="text-[11px] text-gray-400 hidden sm:inline">{fmtFull(m.timestamp_created)}</span>
                        </div>
                      </div>
                      {/* body */}
                      <div className={`px-4 py-3 ${out ? 'bg-indigo-50/40' : 'bg-white'}`}>
                        {m.subject && <p className="text-xs font-medium text-gray-500 mb-2">{m.subject}</p>}
                        <div className="text-sm text-gray-800 whitespace-pre-wrap break-words leading-relaxed">{main || '(no content)'}</div>
                        {quoted && (
                          <details className="mt-3">
                            <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 select-none flex items-center gap-1 w-fit">
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
                              Show quoted history
                            </summary>
                            <div className="mt-2 pl-3 border-l-2 border-gray-200 text-xs text-gray-400 whitespace-pre-wrap break-words">{quoted}</div>
                          </details>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* reply composer */}
              <div className="border-t border-gray-100 px-4 py-3 shrink-0">
                <div className="rounded-xl border border-gray-200 overflow-hidden focus-within:border-indigo-300 focus-within:ring-1 focus-within:ring-indigo-200">
                  <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-gray-500"><span className="font-medium text-gray-700">Reply to:</span> {selected.email}</div>
                  <textarea rows={3} placeholder={`Write your reply to ${selected.first_name ?? fullName(selected).split(' ')[0]}…`} value={replyText} onChange={e => setReplyText(e.target.value)} className="w-full px-3 py-2 text-sm text-gray-800 outline-none resize-none placeholder:text-gray-400" />
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-t border-gray-100">
                    <span className="text-xs">{replyMsg ? <span className="text-green-600 font-medium">{replyMsg}</span> : <span className="text-gray-400">Sent via your campaign mailbox</span>}</span>
                    <button onClick={handleReply} disabled={!replyText.trim() || replying} className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg">
                      {replying ? 'Sending…' : <><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>Send</>}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        {/* Column 4 — lead details */}
        {selected && (
          <aside className="w-72 bg-white border-l border-gray-200 flex flex-col shrink-0 overflow-y-auto">
            <div className="p-5 text-center border-b border-gray-100">
              <div className={`w-16 h-16 rounded-full mx-auto flex items-center justify-center text-lg font-semibold mb-2 ${av(selected.id)}`}>{initials(selected)}</div>
              <p className="text-sm font-semibold text-gray-900">{fullName(selected)}</p>
              {selected.job_title && <p className="text-xs text-gray-500 mt-0.5">{selected.job_title}</p>}
              {selected.company_name && <p className="text-xs text-indigo-600 mt-0.5">{selected.company_name}</p>}
            </div>

            {/* deal value */}
            <Section title="Deal value">
              {dealEdit ? (
                <div className="flex items-center gap-2">
                  <div className="relative flex-1"><span className="absolute left-2 top-1.5 text-gray-400 text-sm">£</span><input type="number" min="0" value={dealInput} onChange={e => setDealInput(e.target.value)} autoFocus className="w-full pl-6 pr-2 py-1.5 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" /></div>
                  <button onClick={handleSaveDeal} className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded-lg">Save</button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-900">{selected.deal_value ? `£${Number(selected.deal_value).toLocaleString()}` : 'Not set'}</span>
                  <button onClick={() => { setDealEdit(true); setDealInput(selected.deal_value ?? '') }} className="text-xs text-indigo-600 hover:text-indigo-800">{selected.deal_value ? 'Edit' : '+ Add'}</button>
                </div>
              )}
            </Section>

            <Section title="Status">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-green-100 text-green-700 px-2 py-1 rounded-full"><span className="w-1.5 h-1.5 rounded-full bg-green-500" />Lead</span>
              {selected.client_label && <span className={`inline-flex ml-1.5 text-xs font-medium px-2 py-1 rounded-full ${COLOR_BADGE[labelMeta(selected.client_label)?.color ?? 'purple'] ?? 'bg-purple-100 text-purple-700'}`}>{selected.client_label}</span>}
            </Section>

            {(selected.email || selected.phone_number || selected.linkedin_url) && (
              <Section title="Contact">
                {selected.email && <Row icon="mail" label={selected.email} />}
                {selected.phone_number && <Row icon="phone" label={selected.phone_number} />}
                {selected.linkedin_url && <Row icon="link" label="LinkedIn profile" href={selected.linkedin_url} />}
              </Section>
            )}

            {(selected.company_name || selected.industry || selected.city || selected.company_website || selected.department) && (
              <Section title="Company & role">
                {selected.company_name && <Row icon="building" label={selected.company_name} />}
                {selected.company_website && <Row icon="globe" label={selected.company_website.replace(/^https?:\/\//,'')} href={selected.company_website} />}
                {selected.job_title && <Row icon="badge" label={selected.job_title} />}
                {selected.department && <Row icon="badge" label={selected.department} />}
                {selected.industry && <Row icon="tag" label={selected.industry} />}
                {(selected.city || selected.state || selected.country) && <Row icon="pin" label={[selected.city, selected.state, selected.country].filter(Boolean).join(', ')} />}
                {selected.linkedin_company_url && <Row icon="link" label="Company LinkedIn" href={selected.linkedin_company_url} />}
              </Section>
            )}

            {/* report a problem — understated, two paths */}
            <div className="p-4 mt-auto border-t border-gray-100">
              {selected.dispute_status ? (
                <p className="text-xs text-center text-gray-400">Reported · {selected.dispute_status}</p>
              ) : (
                <details className="group">
                  <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 select-none flex items-center gap-1 w-fit mx-auto">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    Report a problem with this lead
                  </summary>
                  <div className="mt-2 space-y-1.5">
                    <button onClick={() => openDispute('icp_mismatch')} className="w-full text-left px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 text-xs">
                      <span className="font-medium text-gray-700">Doesn&apos;t fit our criteria</span>
                      <span className="block text-gray-400">Wrong industry, role, location or size — not worth replying.</span>
                    </button>
                    {selected.dispute_eligible ? (
                      <button onClick={() => openDispute('non_lead')} className="w-full text-left px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 text-xs">
                        <span className="font-medium text-gray-700">Tried, but no response</span>
                        <span className="block text-gray-400">You replied / followed up and it went nowhere.</span>
                      </button>
                    ) : (
                      <div className="w-full text-left px-3 py-2 rounded-lg border border-dashed border-gray-200 text-xs bg-gray-50">
                        <span className="font-medium text-gray-400">Tried, but no response</span>
                        <span className="block text-gray-400">Available once you&apos;ve replied &amp; followed up, or after 7 days.</span>
                      </div>
                    )}
                  </div>
                </details>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* report modal — adapts to type */}
      {showDispute && selected && (
        <Modal onClose={() => setShowDispute(false)} title={disputeType === 'icp_mismatch' ? "Doesn't fit our criteria" : 'Report a non-lead'}>
          <p className="text-sm text-gray-500 mb-3">
            {disputeType === 'icp_mismatch'
              ? `Flag ${fullName(selected)} as the wrong fit for your campaign. Our team will review.`
              : `Only report ${fullName(selected)} as a non-lead if you've genuinely replied and followed up with no result. Our team will review.`}
          </p>

          <label className="block text-xs text-gray-500 mb-1">Reason</label>
          <select value={disputeCategory} onChange={e => setDisputeCategory(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 bg-white mb-3">
            <option value="">Choose a reason…</option>
            {(disputeType === 'icp_mismatch' ? ICP_CATEGORIES : NONLEAD_CATEGORIES).map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          <label className="block text-xs text-gray-500 mb-1">Details</label>
          <textarea rows={3} value={disputeReason} onChange={e => setDisputeReason(e.target.value)}
            placeholder={disputeType === 'icp_mismatch' ? 'e.g. They’re a sole trader; we only serve 50+ staff companies.' : 'e.g. Replied twice over 2 weeks, sent a follow-up, no response at all.'}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 mb-3" />

          {disputeType === 'non_lead' && (
            <label className="flex items-start gap-2 mb-3 cursor-pointer">
              <input type="checkbox" checked={disputeAck} onChange={e => setDisputeAck(e.target.checked)} className="mt-0.5" />
              <span className="text-xs text-gray-600">I&apos;ve replied to this lead and genuinely followed up.</span>
            </label>
          )}

          {disputeError && <p className="text-xs text-red-600 mb-3">{disputeError}</p>}

          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowDispute(false)} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
            <button onClick={handleDisputeSubmit} disabled={disputeSaving || !disputeCategory || disputeReason.trim().length < 10 || (disputeType === 'non_lead' && !disputeAck)} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg disabled:opacity-50">{disputeSaving ? 'Submitting…' : 'Submit for review'}</button>
          </div>
        </Modal>
      )}

      {/* new label modal */}
      {showNewLabel && (
        <Modal onClose={() => setShowNewLabel(false)} title="Create deal stage">
          <input value={newLabelName} onChange={e => setNewLabelName(e.target.value)} placeholder="e.g. Meeting Booked, Quote Sent, Won" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 mb-3" />
          <div className="flex gap-2 mb-4">
            {CUSTOM_COLORS.map(c => <button key={c} onClick={() => setNewLabelColor(c)} className={`w-7 h-7 rounded-full ${COLOR_MAP[c]} ${newLabelColor === c ? 'ring-2 ring-offset-2 ring-gray-400' : ''}`} />)}
          </div>
          <label className="flex items-start gap-2 mb-4 cursor-pointer">
            <input type="checkbox" checked={newLabelPromptsValue} onChange={e => setNewLabelPromptsValue(e.target.checked)} className="mt-0.5" />
            <span className="text-sm text-gray-700">Ask for the deal value when a lead reaches this stage
              <span className="block text-xs text-gray-400">Turn on for stages like “Quote Sent” or “Won”. Leave off for early stages.</span>
            </span>
          </label>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowNewLabel(false)} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
            <button onClick={handleCreateLabel} disabled={!newLabelName.trim()} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg disabled:opacity-50">Create</button>
          </div>
        </Modal>
      )}

      {/* stage-triggered deal-value prompt */}
      {valueStage && selected && (
        <Modal onClose={() => setValueStage(null)} title={`Deal value — ${valueStage}`}>
          <p className="text-sm text-gray-500 mb-3">{fullName(selected)} moved to <strong>{valueStage}</strong>. What&apos;s this deal worth? You can skip and add it later.</p>
          <div className="relative mb-4">
            <span className="absolute left-3 top-2.5 text-gray-400">£</span>
            <input type="number" min="0" autoFocus value={valueInput} onChange={e => setValueInput(e.target.value)} placeholder="0"
              onKeyDown={e => { if (e.key === 'Enter' && valueInput) { saveDealValue(valueInput); setValueStage(null) } }}
              className="w-full pl-7 pr-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" />
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setValueStage(null)} className="px-4 py-2 text-sm text-gray-600">Skip</button>
            <button onClick={() => { saveDealValue(valueInput); setValueStage(null) }} disabled={!valueInput} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg disabled:opacity-50">Save deal value</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-5 py-4 border-b border-gray-100">
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">{title}</p>
      {children}
    </div>
  )
}
function Row({ icon, label, href }: { icon: string; label: string; href?: string }) {
  const inner = <span className="text-sm text-gray-700 break-words">{label}</span>
  return (
    <div className="flex items-start gap-2 mb-1.5">
      <span className="text-gray-400 mt-0.5 shrink-0"><Icon name={icon} /></span>
      {href ? <a href={href} target="_blank" rel="noreferrer" className="text-sm text-indigo-600 hover:underline break-words">{label}</a> : inner}
    </div>
  )
}
function Icon({ name }: { name: string }) {
  const p: Record<string, ReactNode> = {
    mail: <><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></>,
    phone: <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></>,
    building: <><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01"/></>,
    globe: <><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></>,
    badge: <><path d="M12 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 20a8 8 0 0 1 16 0"/></>,
    tag: <><path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1"/></>,
    pin: <><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></>,
  }
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{p[name]}</svg>
}
function Banner({ color, children }: { color: 'amber'|'red'|'green'; children: ReactNode }) {
  const cls = { amber: 'bg-amber-50 border-amber-200 text-amber-800', red: 'bg-red-50 border-red-200 text-red-800', green: 'bg-green-50 border-green-200 text-green-800' }[color]
  return <div className={`mx-5 mt-3 px-3 py-2 border rounded-lg text-xs shrink-0 ${cls}`}>{children}</div>
}
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-gray-900 mb-3">{title}</h3>
        {children}
      </div>
    </div>
  )
}
