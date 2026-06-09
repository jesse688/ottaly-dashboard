'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'

interface Lead {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  status: string
  label: string | null
  first_replied_at: string | null
  campaign_name: string | null
  job_title: string | null
  industry: string | null
  city: string | null
  country: string | null
  linkedin_url: string | null
  phone_number: string | null
  deal_value: string | null
  deal_notes: string | null
  dispute_status: string | null
  dispute_reason: string | null
  dispute_admin_note: string | null
}

interface CustomLabel { id: string; name: string; color: string }

// ── System labels ─────────────────────────────────────────────────────────
const SYS_LABELS = [
  { value: 'INTERESTED',        label: 'Lead',              dot: 'bg-green-400',  badge: 'bg-green-100 text-green-700' },
  { value: 'MEETING_BOOKED',    label: 'Meeting Booked',    dot: 'bg-blue-400',   badge: 'bg-blue-100 text-blue-700' },
  { value: 'MEETING_COMPLETED', label: 'Meeting Completed', dot: 'bg-teal-400',   badge: 'bg-teal-100 text-teal-700' },
  { value: 'CLOSED',            label: 'Closed',            dot: 'bg-red-400',    badge: 'bg-red-100 text-red-600' },
  { value: 'NOT_INTERESTED',    label: 'Not Interested',    dot: 'bg-gray-400',   badge: 'bg-gray-100 text-gray-500' },
  { value: 'INFO',              label: 'Info',              dot: 'bg-yellow-400', badge: 'bg-yellow-100 text-yellow-700' },
]

const CUSTOM_COLORS = [
  { value: 'purple',  cls: 'bg-purple-400' },
  { value: 'pink',    cls: 'bg-pink-400' },
  { value: 'orange',  cls: 'bg-orange-400' },
  { value: 'cyan',    cls: 'bg-cyan-400' },
  { value: 'lime',    cls: 'bg-lime-400' },
  { value: 'rose',    cls: 'bg-rose-400' },
]
const COLOR_MAP: Record<string, string> = {
  purple: 'bg-purple-400', pink: 'bg-pink-400', orange: 'bg-orange-400',
  cyan: 'bg-cyan-400', lime: 'bg-lime-400', rose: 'bg-rose-400',
  green: 'bg-green-400', blue: 'bg-blue-400', teal: 'bg-teal-400',
  red: 'bg-red-400', gray: 'bg-gray-400', yellow: 'bg-yellow-400',
}

function dotFor(label: string | null, custom: CustomLabel[]) {
  const sys = SYS_LABELS.find(l => l.value === label)
  if (sys) return sys.dot
  const cust = custom.find(l => l.name === label)
  if (cust) return COLOR_MAP[cust.color] ?? 'bg-purple-400'
  return 'bg-indigo-400'
}
function badgeFor(label: string | null, custom: CustomLabel[]) {
  const sys = SYS_LABELS.find(l => l.value === label)
  if (sys) return sys.badge
  return 'bg-purple-100 text-purple-700'
}
function labelText(label: string | null, custom: CustomLabel[]) {
  const sys = SYS_LABELS.find(l => l.value === label)
  if (sys) return sys.label
  const cust = custom.find(l => l.name === label)
  if (cust) return cust.name
  return label ?? 'Lead'
}

// ── Helpers ───────────────────────────────────────────────────────────────
function initials(l: Lead) {
  return ((l.first_name?.charAt(0) ?? '') + (l.last_name?.charAt(0) ?? '')).toUpperCase() || l.email.charAt(0).toUpperCase()
}
function fullName(l: Lead) {
  return [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email
}
function fmtDate(d: string | null) {
  if (!d) return ''
  const date = new Date(d); const now = new Date()
  const days = Math.floor((now.getTime() - date.getTime()) / 86400000)
  if (days === 0) return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (days < 7) return date.toLocaleDateString('en-GB', { weekday: 'short' })
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
function fmtDateLong(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}
function cleanCampaign(n: string | null) {
  if (!n) return null
  const s = n.replace(/\s+https?:\/\/\S+/g, '').trim()
  const c = s || n
  return c.length > 36 ? c.slice(0, 36) + '…' : c
}
const AV = ['bg-indigo-100 text-indigo-700','bg-pink-100 text-pink-700','bg-amber-100 text-amber-700','bg-teal-100 text-teal-700','bg-purple-100 text-purple-700','bg-blue-100 text-blue-700','bg-green-100 text-green-700','bg-rose-100 text-rose-700']
function av(id: string) { let h=0; for(let i=0;i<id.length;i++) h=(h+id.charCodeAt(i))%AV.length; return AV[h] }


// ─────────────────────────────────────────────────────────────────────────
export function UniboxClient({ companyName }: { companyName: string }) {
  const [leads, setLeads]             = useState<Lead[] | null>(null)
  const [selected, setSelected]       = useState<Lead | null>(null)
  const [customLabels, setCustomLabels] = useState<CustomLabel[]>([])
  const [activeLabel, setActiveLabel]  = useState<string | null>(null)
  const [search, setSearch]            = useState('')

  // label dropdown
  const [labelDrop, setLabelDrop]      = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)

  // reply composer
  const [replyText, setReplyText]      = useState('')
  const [replying, setReplying]        = useState(false)
  const [replySent, setReplySent]      = useState(false)

  // deal value
  const [dealEdit, setDealEdit]        = useState(false)
  const [dealInput, setDealInput]      = useState('')
  const [dealSaving, setDealSaving]    = useState(false)

  // dispute modal
  const [showDispute, setShowDispute]  = useState(false)
  const [disputeReason, setDisputeReason] = useState('')
  const [disputeSaving, setDisputeSaving] = useState(false)

  // create label modal
  const [showNewLabel, setShowNewLabel] = useState(false)
  const [newLabelName, setNewLabelName] = useState('')
  const [newLabelColor, setNewLabelColor] = useState('purple')
  const [labelSaving, setLabelSaving]  = useState(false)

  const router = useRouter()

  useEffect(() => {
    loadLeads()
    fetch('/api/portal/labels').then(r => r.json()).then((d: CustomLabel[] | { error: string }) => {
      if (Array.isArray(d)) setCustomLabels(d)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function h(e: MouseEvent) { if (dropRef.current && !dropRef.current.contains(e.target as Node)) setLabelDrop(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  function loadLeads() {
    fetch('/api/portal/leads/all').then(r => r.json()).then((d: Lead[] | { error: string }) => {
      if (Array.isArray(d)) {
        setLeads(d)
        if (d.length > 0) setSelected(prev => prev ? (d.find(l => l.id === prev.id) ?? d[0]) : d[0])
      }
    })
  }

  const allSystemLabels = leads ? Array.from(new Set(leads.map(l => l.label).filter(Boolean) as string[])) : []
  const filtered = (leads ?? []).filter(l => {
    const matchLabel = activeLabel === null || l.label === activeLabel
    const q = search.toLowerCase()
    return matchLabel && (!q || fullName(l).toLowerCase().includes(q) || (l.company_name ?? '').toLowerCase().includes(q) || l.email.toLowerCase().includes(q))
  })

  async function handleLabelChange(leadId: string, newLabel: string) {
    setLabelDrop(false)
    setLeads(prev => prev?.map(l => l.id === leadId ? { ...l, label: newLabel } : l) ?? null)
    setSelected(prev => prev?.id === leadId ? { ...prev, label: newLabel } : prev)
    await fetch(`/api/portal/leads/${leadId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: newLabel }) })
  }

  async function handleReply() {
    if (!replyText.trim() || !selected) return
    setReplying(true)
    await new Promise(r => setTimeout(r, 800))
    setReplying(false); setReplyText(''); setReplySent(true)
    setTimeout(() => setReplySent(false), 3000)
  }

  async function handleSaveDeal() {
    if (!selected) return
    setDealSaving(true)
    await fetch(`/api/portal/leads/${selected.id}/data`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deal_value: dealInput || null })
    })
    setDealSaving(false); setDealEdit(false)
    setLeads(prev => prev?.map(l => l.id === selected.id ? { ...l, deal_value: dealInput || null } : l) ?? null)
    setSelected(prev => prev ? { ...prev, deal_value: dealInput || null } : prev)
  }

  async function handleDisputeSubmit() {
    if (!disputeReason.trim() || !selected) return
    setDisputeSaving(true)
    await fetch(`/api/portal/leads/${selected.id}/dispute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: disputeReason })
    })
    setDisputeSaving(false); setShowDispute(false); setDisputeReason('')
    setLeads(prev => prev?.map(l => l.id === selected.id ? { ...l, dispute_status: 'pending', dispute_reason: disputeReason } : l) ?? null)
    setSelected(prev => prev ? { ...prev, dispute_status: 'pending', dispute_reason: disputeReason } : prev)
  }

  async function handleCreateLabel() {
    if (!newLabelName.trim()) return
    setLabelSaving(true)
    const res = await fetch('/api/portal/labels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newLabelName.trim(), color: newLabelColor })
    })
    const created = await res.json() as CustomLabel
    setCustomLabels(prev => [...prev, created])
    setNewLabelName(''); setNewLabelColor('purple'); setShowNewLabel(false); setLabelSaving(false)
  }

  async function handleDeleteLabel(id: string) {
    await fetch(`/api/portal/labels/${id}`, { method: 'DELETE' })
    setCustomLabels(prev => prev.filter(l => l.id !== id))
  }

  function openLead(lead: Lead) {
    setSelected(lead); setReplySent(false); setReplyText('')
    setDealEdit(false); setDealInput(lead.deal_value ?? '')
    setShowDispute(false)
  }

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST' }); router.push('/login')
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-white" style={{ fontFamily: 'system-ui,-apple-system,sans-serif' }}>

      {/* Top bar */}
      <header className="h-12 bg-[#1a2332] flex items-center px-4 shrink-0 gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-white font-bold text-sm">Ottaly</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-slate-500"><polyline points="6 9 12 15 18 9"/></svg>
          <span className="text-slate-300 text-sm">{companyName}</span>
        </div>
        <nav className="flex items-center gap-1 ml-6">
          <a href="/unibox" className="px-3 py-1 text-white bg-slate-700 text-xs rounded">Leads</a>
          <a href="/invoices" className="px-3 py-1 text-slate-400 hover:text-white text-xs rounded transition-colors">Invoices &amp; ROI</a>
        </nav>
        <div className="ml-auto">
          <button onClick={handleLogout} className="w-7 h-7 rounded-full bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white text-xs font-semibold transition-colors">
            {companyName.charAt(0).toUpperCase()}
          </button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">

        {/* ── Sidebar ── */}
        <aside className="w-48 border-r border-gray-100 flex flex-col shrink-0 bg-white">
          <div
            onClick={() => setActiveLabel(null)}
            className={`flex items-center gap-2.5 px-4 py-2.5 cursor-pointer transition-colors border-l-2 ${activeLabel === null ? 'border-indigo-500 bg-gray-50 text-gray-900' : 'border-transparent text-gray-500 hover:bg-gray-50'}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={activeLabel === null ? 'text-indigo-500' : 'text-gray-400'}>
              <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
              <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
            </svg>
            <span className="text-sm font-medium">Inbox</span>
            {leads && <span className="ml-auto text-xs text-gray-400">{leads.length}</span>}
          </div>

          {/* Labels */}
          {(allSystemLabels.length > 0 || customLabels.length > 0) && (
            <div className="mt-1">
              <div className="flex items-center justify-between px-4 py-1.5">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Labels</p>
                <button onClick={() => setShowNewLabel(true)} className="text-gray-400 hover:text-indigo-600 transition-colors" title="Add label">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
              </div>
              {allSystemLabels.map(label => (
                <div
                  key={label}
                  onClick={() => setActiveLabel(label)}
                  className={`flex items-center gap-2 px-4 py-2 cursor-pointer transition-colors border-l-2 text-sm ${activeLabel === label ? 'border-indigo-500 bg-gray-50 text-gray-900' : 'border-transparent text-gray-500 hover:bg-gray-50'}`}
                >
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotFor(label, customLabels)}`} />
                  <span className="truncate text-xs">{labelText(label, customLabels)}</span>
                  {leads && <span className="ml-auto text-xs text-gray-400">{leads.filter(l => l.label === label).length}</span>}
                </div>
              ))}
              {customLabels.map(cl => (
                <div
                  key={cl.id}
                  onClick={() => setActiveLabel(cl.name)}
                  className={`flex items-center gap-2 px-4 py-2 cursor-pointer transition-colors border-l-2 text-sm group ${activeLabel === cl.name ? 'border-indigo-500 bg-gray-50 text-gray-900' : 'border-transparent text-gray-500 hover:bg-gray-50'}`}
                >
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${COLOR_MAP[cl.color] ?? 'bg-purple-400'}`} />
                  <span className="truncate text-xs">{cl.name}</span>
                  <button
                    onClick={e => { e.stopPropagation(); handleDeleteLabel(cl.id) }}
                    className="ml-auto opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {allSystemLabels.length === 0 && customLabels.length === 0 && (
            <div className="mt-1 px-4 py-1.5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Labels</p>
                <button onClick={() => setShowNewLabel(true)} className="text-gray-400 hover:text-indigo-600 transition-colors">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
              </div>
            </div>
          )}

          <div className="flex-1" />
          <button onClick={handleLogout} className="flex items-center gap-2 px-4 py-3 text-xs text-gray-400 hover:text-gray-600 border-t border-gray-100 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Sign out
          </button>
        </aside>

        {/* ── Lead list ── */}
        <div className="w-[268px] border-r border-gray-100 flex flex-col shrink-0">
          <div className="px-3 pt-3 pb-2 border-b border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-gray-900">Your Leads <span className="font-normal text-gray-400">({filtered.length})</span></h2>
            </div>
            <div className="relative">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="text" placeholder="Search mail" value={search} onChange={e => setSearch(e.target.value)} className="w-full pl-8 pr-3 py-1.5 rounded-md border border-gray-200 text-xs outline-none focus:border-indigo-300 bg-gray-50" />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {leads === null ? Array.from({length:6}).map((_,i) => (
              <div key={i} className="flex gap-2.5 px-3 py-3 border-b border-gray-50">
                <div className="w-8 h-8 rounded-full bg-gray-100 animate-pulse shrink-0" />
                <div className="flex-1 space-y-2 py-0.5"><div className="h-3 bg-gray-100 rounded animate-pulse w-3/4" /><div className="h-3 bg-gray-100 rounded animate-pulse w-1/2" /></div>
              </div>
            )) : filtered.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-gray-400">No leads found</div>
            ) : filtered.map(lead => (
              <button key={lead.id} onClick={() => openLead(lead)} className={`w-full text-left px-3 py-3 border-b border-gray-50 transition-colors ${selected?.id === lead.id ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}>
                <div className="flex gap-2.5">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${av(lead.id)}`}>{initials(lead)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-1">
                      <span className="text-xs font-semibold text-gray-900 truncate">{fullName(lead)}</span>
                      <span className="text-[11px] text-gray-400 shrink-0">{fmtDate(lead.first_replied_at)}</span>
                    </div>
                    <div className="text-[11px] text-gray-500 truncate mt-0.5">{lead.company_name || lead.email}</div>
                    <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                      {lead.campaign_name && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-[10px]">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.44A2 2 0 0 1 3.62 1.25h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 8a16 16 0 0 0 6.72 6.72l.95-.95a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                          {cleanCampaign(lead.campaign_name)}
                        </span>
                      )}
                      {lead.label && <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${badgeFor(lead.label, customLabels)}`}>{labelText(lead.label, customLabels)}</span>}
                      {lead.dispute_status === 'pending' && <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">Disputed</span>}
                      {lead.deal_value && <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-50 text-green-700">£{parseFloat(lead.deal_value).toLocaleString()}</span>}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ── Detail view ── */}
        {selected ? (
          <div className="flex flex-1 min-w-0">
            {/* Email thread */}
            <div className="flex flex-col flex-1 min-w-0 border-r border-gray-100">
              {/* Thread header */}
              <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100 shrink-0">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${av(selected.id)}`}>{initials(selected)}</div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-gray-900 truncate">{fullName(selected)}</h3>
                  <p className="text-xs text-gray-500 truncate">{selected.email}</p>
                </div>
                {/* Label dropdown */}
                <div className="relative" ref={dropRef}>
                  <button onClick={() => setLabelDrop(v => !v)} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${badgeFor(selected.label, customLabels)}`}>
                    <span className={`w-2 h-2 rounded-full ${dotFor(selected.label, customLabels)}`} />
                    {labelText(selected.label, customLabels)}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  {labelDrop && (
                    <div className="absolute right-0 top-full mt-1 w-52 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-20 max-h-72 overflow-y-auto">
                      <p className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">System Labels</p>
                      {SYS_LABELS.map(({ value, label, dot }) => (
                        <button key={value} onClick={() => handleLabelChange(selected.id, value)} className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dot}`} />{label}
                          {selected.label === value && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-auto text-indigo-500"><polyline points="20 6 9 17 4 12"/></svg>}
                        </button>
                      ))}
                      {customLabels.length > 0 && (
                        <>
                          <div className="border-t border-gray-100 my-1" />
                          <p className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Custom Labels</p>
                          {customLabels.map(cl => (
                            <button key={cl.id} onClick={() => handleLabelChange(selected.id, cl.name)} className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${COLOR_MAP[cl.color] ?? 'bg-purple-400'}`} />{cl.name}
                              {selected.label === cl.name && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-auto text-indigo-500"><polyline points="20 6 9 17 4 12"/></svg>}
                            </button>
                          ))}
                        </>
                      )}
                      <div className="border-t border-gray-100 mt-1 pt-1">
                        <button onClick={() => { setLabelDrop(false); setShowNewLabel(true) }} className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-indigo-600 hover:bg-indigo-50 transition-colors">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                          Create new label
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {selected.campaign_name && (
                <div className="px-5 py-2 bg-gray-50 border-b border-gray-100 shrink-0">
                  <span className="text-[11px] text-gray-500">{cleanCampaign(selected.campaign_name)}</span>
                </div>
              )}

              {/* Thread body */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                {/* Reply status */}
                {selected.first_replied_at && (
                  <div className="flex gap-3 px-5">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${av(selected.id)}`}>{initials(selected)}</div>
                    <div className="flex-1">
                      <div className="flex items-baseline gap-2 mb-1">
                        <span className="text-sm font-semibold text-gray-900">{fullName(selected)}</span>
                        <span className="text-xs text-gray-400">{fmtDateLong(selected.first_replied_at)}</span>
                      </div>
                      <div className="text-xs text-gray-500 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg">
                        Lead replied to your outreach
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Dispute banner */}
              {selected.dispute_status === 'pending' && (
                <div className="mx-5 mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 shrink-0">
                  <strong>Non-lead request pending review.</strong> Reason: {selected.dispute_reason}
                </div>
              )}
              {selected.dispute_status === 'denied' && (
                <div className="mx-5 mb-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 shrink-0">
                  <strong>Non-lead request denied.</strong>{selected.dispute_admin_note ? ` ${selected.dispute_admin_note}` : ''}
                </div>
              )}
              {selected.dispute_status === 'approved' && (
                <div className="mx-5 mb-2 px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-xs text-green-800 shrink-0">
                  <strong>Non-lead request approved.</strong> This lead has been removed.
                </div>
              )}

              {/* Reply composer */}
              <div className="border-t border-gray-100 px-4 py-3 shrink-0">
                <div className="rounded-xl border border-gray-200 overflow-hidden focus-within:border-indigo-300 focus-within:ring-1 focus-within:ring-indigo-200 transition-all">
                  <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
                    <span className="font-medium text-gray-700">Reply to:</span> {selected.email}
                  </div>
                  <textarea rows={3} placeholder={`Write your reply to ${selected.first_name ?? fullName(selected).split(' ')[0]}…`} value={replyText} onChange={e => setReplyText(e.target.value)} className="w-full px-3 py-2 text-sm text-gray-800 outline-none resize-none placeholder:text-gray-400" />
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-t border-gray-100">
                    <span className="text-xs text-gray-400">{replySent ? <span className="text-green-600 font-medium">Reply sent!</span> : 'via outreach@ottaly.co.uk'}</span>
                    <button onClick={handleReply} disabled={!replyText.trim() || replying} className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors">
                      {replying ? 'Sending…' : <><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>Send Reply</>}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Lead detail sidebar ── */}
            <div className="w-60 shrink-0 overflow-y-auto bg-gray-50 border-l border-gray-100">
              {/* Contact card */}
              <div className="px-4 py-4 bg-white border-b border-gray-200">
                <div className="flex flex-col items-center text-center">
                  <div className={`w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold mb-2 ${av(selected.id)}`}>{initials(selected)}</div>
                  <p className="text-sm font-semibold text-gray-900">{fullName(selected)}</p>
                  {selected.job_title && <p className="text-xs text-gray-500 mt-0.5">{selected.job_title}</p>}
                  {selected.company_name && <p className="text-xs text-indigo-600 mt-0.5 font-medium">{selected.company_name}</p>}
                </div>
              </div>

              {/* Deal value */}
              <div className="px-4 py-3 bg-white border-b border-gray-200 mt-2">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Deal Value</p>
                {dealEdit ? (
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">£</span>
                      <input type="number" min="0" step="100" placeholder="0" value={dealInput} onChange={e => setDealInput(e.target.value)} className="w-full pl-6 pr-2 py-1.5 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400" autoFocus />
                    </div>
                    <button onClick={handleSaveDeal} disabled={dealSaving} className="px-2.5 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded-lg disabled:opacity-60">Save</button>
                    <button onClick={() => setDealEdit(false)} className="text-gray-400 hover:text-gray-600 text-xs">✕</button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="text-lg font-bold text-gray-900">
                      {selected.deal_value ? `£${parseFloat(selected.deal_value).toLocaleString()}` : <span className="text-gray-400 text-sm font-normal">Not set</span>}
                    </span>
                    <button onClick={() => { setDealEdit(true); setDealInput(selected.deal_value ?? '') }} className="text-xs text-indigo-600 hover:text-indigo-800">
                      {selected.deal_value ? 'Edit' : '+ Add'}
                    </button>
                  </div>
                )}
              </div>

              {/* Status */}
              <div className="px-4 py-3 bg-white border-b border-gray-200 mt-2">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Status</p>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium ${badgeFor(selected.label, customLabels)}`}>
                  <span className={`w-2 h-2 rounded-full ${dotFor(selected.label, customLabels)}`} />
                  {labelText(selected.label, customLabels)}
                </span>
              </div>

              {/* Contact info */}
              <div className="px-4 py-3 bg-white border-b border-gray-200 mt-2">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Contact</p>
                <div className="space-y-2">
                  <DR icon="email" label="Email" value={selected.email} />
                  {selected.phone_number && <DR icon="phone" label="Phone" value={selected.phone_number} />}
                  {selected.linkedin_url && (
                    <div className="flex items-start gap-2">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 text-gray-400 shrink-0"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg>
                      <a href={selected.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 hover:underline">LinkedIn Profile</a>
                    </div>
                  )}
                </div>
              </div>

              {/* Company */}
              {(selected.company_name || selected.industry || selected.city) && (
                <div className="px-4 py-3 bg-white border-b border-gray-200 mt-2">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Company</p>
                  <div className="space-y-2">
                    {selected.company_name && <DR icon="building" label="Name" value={selected.company_name} />}
                    {selected.industry && <DR icon="tag" label="Industry" value={selected.industry} />}
                    {(selected.city || selected.country) && <DR icon="location" label="Location" value={[selected.city, selected.country].filter(Boolean).join(', ')} />}
                  </div>
                </div>
              )}

              {/* Not a lead */}
              <div className="px-4 py-3 bg-white mt-2">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Quality Control</p>
                {selected.dispute_status === 'pending' ? (
                  <div className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                    Non-lead request pending admin review
                  </div>
                ) : selected.dispute_status === 'approved' ? (
                  <div className="text-xs text-green-700 bg-green-50 rounded-lg px-3 py-2">
                    Approved — removed from leads
                  </div>
                ) : (
                  <button
                    onClick={() => setShowDispute(true)}
                    className="w-full px-3 py-2 border border-red-200 text-red-600 hover:bg-red-50 text-xs font-medium rounded-lg transition-colors"
                  >
                    Not a Lead?
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-gray-50">
            <p className="text-sm text-gray-400">Select a lead to view</p>
          </div>
        )}
      </div>

      {/* ── Dispute modal ── */}
      {showDispute && selected && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowDispute(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-gray-900 mb-1">Not a Lead?</h2>
            <p className="text-sm text-gray-500 mb-4">Tell us why <strong>{fullName(selected)}</strong> shouldn&apos;t count as a lead. We&apos;ll review and get back to you.</p>
            <textarea
              rows={4}
              placeholder="e.g. This person is a competitor, or the reply was out of office, etc."
              value={disputeReason}
              onChange={e => setDisputeReason(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 resize-none mb-4"
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowDispute(false); setDisputeReason('') }} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
              <button onClick={handleDisputeSubmit} disabled={!disputeReason.trim() || disputeSaving} className="px-5 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-xl disabled:opacity-60">
                {disputeSaving ? 'Submitting…' : 'Submit for Review'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create label modal ── */}
      {showNewLabel && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowNewLabel(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Create Custom Label</h2>
            <div className="mb-3">
              <label className="block text-xs text-gray-500 mb-1">Label name</label>
              <input
                type="text" placeholder="e.g. Hot Lead, Follow Up…" value={newLabelName}
                onChange={e => setNewLabelName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400"
                autoFocus
              />
            </div>
            <div className="mb-5">
              <label className="block text-xs text-gray-500 mb-2">Colour</label>
              <div className="flex gap-2 flex-wrap">
                {CUSTOM_COLORS.map(c => (
                  <button key={c.value} onClick={() => setNewLabelColor(c.value)} className={`w-7 h-7 rounded-full ${c.cls} transition-all ${newLabelColor === c.value ? 'ring-2 ring-offset-2 ring-indigo-500' : ''}`} />
                ))}
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowNewLabel(false); setNewLabelName('') }} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
              <button onClick={handleCreateLabel} disabled={!newLabelName.trim() || labelSaving} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg disabled:opacity-60">
                {labelSaving ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Detail row helper ─────────────────────────────────────────────────────
function DR({ icon, label, value }: { icon: string; label: string; value: string }) {
  const icons: Record<string, ReactNode> = {
    email:    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>,
    phone:    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.44A2 2 0 0 1 3.62 1.25h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 8a16 16 0 0 0 6.72 6.72l.95-.95a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>,
    building: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
    tag:      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
    location: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  }
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 text-gray-400 shrink-0">{icons[icon]}</span>
      <div className="min-w-0">
        <p className="text-[10px] text-gray-400">{label}</p>
        <p className="text-xs text-gray-800 break-all">{value}</p>
      </div>
    </div>
  )
}
