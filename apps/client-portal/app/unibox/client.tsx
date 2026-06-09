'use client'

import { useEffect, useRef, useState } from 'react'
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
}

// ── Label config ──────────────────────────────────────────────────────────
const LABEL_DOT: Record<string, string> = {
  INTERESTED:        'bg-green-400',
  MEETING_BOOKED:    'bg-blue-400',
  MEETING_COMPLETED: 'bg-teal-400',
  CLOSED:            'bg-red-400',
  NOT_INTERESTED:    'bg-gray-400',
  INFO:              'bg-yellow-400',
}
const LABEL_BADGE: Record<string, string> = {
  INTERESTED:        'bg-green-100 text-green-700',
  MEETING_BOOKED:    'bg-blue-100 text-blue-700',
  MEETING_COMPLETED: 'bg-teal-100 text-teal-700',
  CLOSED:            'bg-red-100 text-red-600',
  NOT_INTERESTED:    'bg-gray-100 text-gray-500',
  INFO:              'bg-yellow-100 text-yellow-700',
}
const ALL_LABELS = [
  { value: 'INTERESTED',        label: 'Lead' },
  { value: 'MEETING_BOOKED',    label: 'Meeting Booked' },
  { value: 'MEETING_COMPLETED', label: 'Meeting Completed' },
  { value: 'CLOSED',            label: 'Closed' },
  { value: 'NOT_INTERESTED',    label: 'Not Interested' },
  { value: 'INFO',              label: 'Info' },
]
function dotColor(l: string | null) { return LABEL_DOT[l ?? ''] ?? 'bg-indigo-400' }
function badgeClass(l: string | null) { return LABEL_BADGE[l ?? ''] ?? 'bg-indigo-100 text-indigo-700' }
function labelText(l: string | null) {
  return ALL_LABELS.find(x => x.value === l)?.label ?? (l ?? 'Lead')
}

// ── Helpers ───────────────────────────────────────────────────────────────
function initials(lead: Lead) {
  const f = lead.first_name?.charAt(0) ?? ''
  const l = lead.last_name?.charAt(0) ?? ''
  return (f + l).toUpperCase() || lead.email.charAt(0).toUpperCase()
}
function fullName(lead: Lead) {
  return [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email
}
function fmtDate(d: string | null) {
  if (!d) return ''
  const date = new Date(d)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (days < 7) return date.toLocaleDateString('en-GB', { weekday: 'short' })
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
function fmtDateLong(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}
function cleanCampaign(name: string | null) {
  if (!name) return null
  const stripped = name.replace(/\s+https?:\/\/\S+/g, '').trim()
  const clean = stripped || name
  return clean.length > 36 ? clean.slice(0, 36) + '…' : clean
}

// ── Avatar colours ────────────────────────────────────────────────────────
const AV = [
  'bg-indigo-100 text-indigo-700', 'bg-pink-100 text-pink-700',
  'bg-amber-100 text-amber-700',   'bg-teal-100 text-teal-700',
  'bg-purple-100 text-purple-700', 'bg-blue-100 text-blue-700',
  'bg-green-100 text-green-700',   'bg-rose-100 text-rose-700',
]
function av(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) % AV.length
  return AV[h]
}

// ── Fake reply templates (deterministic by ID) ────────────────────────────
const REPLIES = [
  (n: string) => `Hi,\n\nThanks for reaching out — this is actually great timing. We've been looking at options for this and your approach sounds interesting.\n\nHappy to jump on a call. What does your availability look like next week?\n\nCheers,\n${n}`,
  (n: string) => `Hi there,\n\nAppreciate you getting in touch. Yes, I'd be open to learning more — can you send over some info first and then we can decide if a call makes sense?\n\nThanks,\n${n}`,
  (n: string) => `Hello,\n\nYes I'm interested. We've been struggling with lead generation and this could be a good fit.\n\nFeel free to book a slot or suggest a time.\n\nBest regards,\n${n}`,
  (n: string) => `Thanks for the email.\n\nWe're actually in the middle of a growth push right now so the timing is good. Would love to hear more — let's get a call scheduled.\n\n${n}`,
  (n: string) => `Hi,\n\nGood to hear from you. I'd definitely be interested in exploring this further — we're always open to solutions that can drive more qualified leads.\n\nWhen are you free for a quick chat?\n\nKind regards,\n${n}`,
]
function pickReply(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return REPLIES[h % REPLIES.length]
}

// ─────────────────────────────────────────────────────────────────────────
export function UniboxClient({ companyName }: { companyName: string }) {
  const [leads, setLeads]           = useState<Lead[] | null>(null)
  const [selected, setSelected]     = useState<Lead | null>(null)
  const [activeLabel, setActiveLabel] = useState<string | null>(null)
  const [search, setSearch]         = useState('')
  const [labelDropdown, setLabelDropdown] = useState(false)
  const [replyText, setReplyText]   = useState('')
  const [replySent, setReplySent]   = useState(false)
  const [replying, setReplying]     = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  useEffect(() => {
    fetch('/api/portal/leads/all')
      .then(r => r.json())
      .then((d: Lead[] | { error: string }) => {
        if (Array.isArray(d)) {
          setLeads(d)
          if (d.length > 0) setSelected(d[0])
        }
      })
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setLabelDropdown(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  const allLabels = leads
    ? Array.from(new Set(leads.map(l => l.label).filter(Boolean) as string[]))
    : []

  const filtered = (leads ?? []).filter(l => {
    const matchLabel = activeLabel === null || l.label === activeLabel
    const q = search.toLowerCase()
    const matchSearch = !q ||
      fullName(l).toLowerCase().includes(q) ||
      (l.company_name ?? '').toLowerCase().includes(q) ||
      l.email.toLowerCase().includes(q)
    return matchLabel && matchSearch
  })

  async function handleLabelChange(leadId: string, newLabel: string) {
    setLabelDropdown(false)
    // Optimistic update
    setLeads(prev => prev?.map(l => l.id === leadId ? { ...l, label: newLabel } : l) ?? null)
    setSelected(prev => prev?.id === leadId ? { ...prev, label: newLabel } : prev)
    await fetch(`/api/portal/leads/${leadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: newLabel }),
    })
  }

  async function handleReply() {
    if (!replyText.trim() || !selected) return
    setReplying(true)
    // Simulate send — wire to real email sending later
    await new Promise(r => setTimeout(r, 800))
    setReplying(false)
    setReplyText('')
    setReplySent(true)
    setTimeout(() => setReplySent(false), 3000)
  }

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST' })
    router.push('/login')
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-white" style={{ fontFamily: 'system-ui,-apple-system,sans-serif' }}>

      {/* ── Top bar ── */}
      <header className="h-12 bg-[#1a2332] flex items-center px-4 shrink-0 gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-white font-bold text-sm">Ottaly</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-slate-500"><polyline points="6 9 12 15 18 9"/></svg>
          <span className="text-slate-300 text-sm">{companyName}</span>
        </div>
        <div className="ml-auto">
          <button onClick={handleLogout} className="w-7 h-7 rounded-full bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-white text-xs font-semibold transition-colors">
            {companyName.charAt(0).toUpperCase()}
          </button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">

        {/* ── Sidebar ── */}
        <aside className="w-48 border-r border-gray-100 flex flex-col shrink-0 bg-white">
          {/* Inbox */}
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

          {allLabels.length > 0 && (
            <div className="mt-1">
              <p className="px-4 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Labels</p>
              {allLabels.map(label => (
                <div
                  key={label}
                  onClick={() => setActiveLabel(label)}
                  className={`flex items-center gap-2 px-4 py-2 cursor-pointer transition-colors border-l-2 text-sm ${
                    activeLabel === label ? 'border-indigo-500 bg-gray-50 text-gray-900' : 'border-transparent text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotColor(label)}`} />
                  <span className="truncate">{labelText(label)}</span>
                  {leads && <span className="ml-auto text-xs text-gray-400">{leads.filter(l => l.label === label).length}</span>}
                </div>
              ))}
            </div>
          )}

          <div className="flex-1" />
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 px-4 py-3 text-xs text-gray-400 hover:text-gray-600 border-t border-gray-100 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Sign out
          </button>
        </aside>

        {/* ── Lead list ── */}
        <div className="w-[268px] border-r border-gray-100 flex flex-col shrink-0">
          <div className="px-3 pt-3 pb-2 border-b border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-gray-900">
                Your Leads <span className="font-normal text-gray-400">({filtered.length})</span>
              </h2>
            </div>
            <div className="relative">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                type="text" placeholder="Search mail" value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 rounded-md border border-gray-200 text-xs outline-none focus:border-indigo-300 bg-gray-50"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {leads === null ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex gap-2.5 px-3 py-3 border-b border-gray-50">
                  <div className="w-8 h-8 rounded-full bg-gray-100 animate-pulse shrink-0" />
                  <div className="flex-1 space-y-2 py-0.5">
                    <div className="h-3 bg-gray-100 rounded animate-pulse w-3/4" />
                    <div className="h-3 bg-gray-100 rounded animate-pulse w-1/2" />
                  </div>
                </div>
              ))
            ) : filtered.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-gray-400">No leads found</div>
            ) : filtered.map(lead => (
              <button
                key={lead.id}
                onClick={() => { setSelected(lead); setReplySent(false); setReplyText('') }}
                className={`w-full text-left px-3 py-3 border-b border-gray-50 transition-colors ${
                  selected?.id === lead.id ? 'bg-indigo-50' : 'hover:bg-gray-50'
                }`}
              >
                <div className="flex gap-2.5">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${av(lead.id)}`}>
                    {initials(lead)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-1">
                      <span className="text-xs font-semibold text-gray-900 truncate">{fullName(lead)}</span>
                      <span className="text-[11px] text-gray-400 shrink-0">{fmtDate(lead.first_replied_at)}</span>
                    </div>
                    <div className="text-[11px] text-gray-500 truncate mt-0.5">
                      {lead.company_name || lead.email}
                    </div>
                    <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                      {lead.campaign_name && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-[10px]">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.44A2 2 0 0 1 3.62 1.25h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 8a16 16 0 0 0 6.72 6.72l.95-.95a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                          </svg>
                          {cleanCampaign(lead.campaign_name)}
                        </span>
                      )}
                      {lead.label && (
                        <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${badgeClass(lead.label)}`}>
                          {labelText(lead.label)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ── Email thread ── */}
        {selected ? (
          <div className="flex flex-1 min-w-0">
            {/* Thread + reply */}
            <div className="flex flex-col flex-1 min-w-0 border-r border-gray-100">
              {/* Thread header */}
              <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100 shrink-0">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${av(selected.id)}`}>
                  {initials(selected)}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-gray-900 truncate">{fullName(selected)}</h3>
                  <p className="text-xs text-gray-500 truncate">{selected.email}</p>
                </div>
                {/* Label dropdown */}
                <div className="relative" ref={dropdownRef}>
                  <button
                    onClick={() => setLabelDropdown(v => !v)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${badgeClass(selected.label)}`}
                  >
                    <span className={`w-2 h-2 rounded-full ${dotColor(selected.label)}`} />
                    {labelText(selected.label)}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  {labelDropdown && (
                    <div className="absolute right-0 top-full mt-1 w-48 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-20">
                      {ALL_LABELS.map(({ value, label }) => (
                        <button
                          key={value}
                          onClick={() => handleLabelChange(selected.id, value)}
                          className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                        >
                          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotColor(value)}`} />
                          {label}
                          {selected.label === value && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-auto text-indigo-500"><polyline points="20 6 9 17 4 12"/></svg>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Campaign tag */}
              {selected.campaign_name && (
                <div className="px-5 py-2 bg-gray-50 border-b border-gray-100 shrink-0">
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.44A2 2 0 0 1 3.62 1.25h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 8a16 16 0 0 0 6.72 6.72l.95-.95a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                    </svg>
                    {cleanCampaign(selected.campaign_name)}
                  </span>
                </div>
              )}

              {/* Thread */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                {/* Outreach email */}
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-xs font-semibold text-indigo-700 shrink-0">O</div>
                  <div className="flex-1">
                    <div className="flex items-baseline gap-2 mb-0.5">
                      <span className="text-sm font-semibold text-gray-900">Ottaly</span>
                      <span className="text-xs text-gray-400">outreach@ottaly.co.uk</span>
                    </div>
                    <div className="text-xs text-gray-500 mb-2">to: {selected.email}</div>
                    <div className="rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-700 bg-gray-50 space-y-2">
                      <p>Hi {selected.first_name ?? fullName(selected).split(' ')[0]},</p>
                      <p>I came across {selected.company_name ?? 'your company'} and wanted to reach out — we work with businesses like yours to help generate qualified leads through targeted outreach.</p>
                      <p>Would you be open to a quick 15-minute call this week to explore if there&apos;s a fit?</p>
                      <p>Best,<br />Ottaly Team</p>
                    </div>
                  </div>
                </div>

                {/* Lead reply */}
                <div className="flex gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${av(selected.id)}`}>
                    {initials(selected)}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-baseline gap-2 mb-0.5">
                      <span className="text-sm font-semibold text-gray-900">{fullName(selected)}</span>
                      {selected.first_replied_at && (
                        <span className="text-xs text-gray-400">{fmtDateLong(selected.first_replied_at)}</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mb-2">to: outreach@ottaly.co.uk</div>
                    <div className="rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-700 bg-white shadow-sm space-y-2">
                      {pickReply(selected.id)(selected.first_name ?? fullName(selected).split(' ')[0])
                        .split('\n')
                        .map((line, i) => line ? <p key={i}>{line}</p> : <br key={i} />)
                      }
                    </div>
                  </div>
                </div>
              </div>

              {/* Reply composer */}
              <div className="border-t border-gray-100 px-4 py-3 shrink-0">
                <div className="rounded-xl border border-gray-200 overflow-hidden focus-within:border-indigo-300 focus-within:ring-1 focus-within:ring-indigo-200 transition-all">
                  <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
                    <span className="font-medium text-gray-700">Reply to:</span> {selected.email}
                  </div>
                  <textarea
                    rows={4}
                    placeholder={`Write your reply to ${selected.first_name ?? fullName(selected).split(' ')[0]}…`}
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    className="w-full px-3 py-2 text-sm text-gray-800 outline-none resize-none placeholder:text-gray-400"
                  />
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-t border-gray-100">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M15.05 5A5 5 0 0 1 19 8.95M15.05 1A9 9 0 0 1 23 8.94m-1 7.98v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.44A2 2 0 0 1 3.62 1.25h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 8a16 16 0 0 0 6.72 6.72l.95-.95a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                      </svg>
                      {replySent ? <span className="text-green-600 font-medium">Reply sent!</span> : 'Replying via outreach@ottaly.co.uk'}
                    </div>
                    <button
                      onClick={handleReply}
                      disabled={!replyText.trim() || replying}
                      className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      {replying ? 'Sending…' : (
                        <>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                          Send Reply
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Lead detail sidebar ── */}
            <div className="w-64 shrink-0 overflow-y-auto bg-gray-50">
              {/* Contact card */}
              <div className="px-4 py-4 border-b border-gray-200 bg-white">
                <div className="flex flex-col items-center text-center">
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center text-base font-bold mb-2 ${av(selected.id)}`}>
                    {initials(selected)}
                  </div>
                  <p className="text-sm font-semibold text-gray-900">{fullName(selected)}</p>
                  {selected.job_title && <p className="text-xs text-gray-500 mt-0.5">{selected.job_title}</p>}
                  {selected.company_name && <p className="text-xs text-indigo-600 mt-0.5 font-medium">{selected.company_name}</p>}
                </div>
              </div>

              {/* Status */}
              <div className="px-4 py-3 border-b border-gray-200 bg-white mt-2">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Status</p>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium ${badgeClass(selected.label)}`}>
                  <span className={`w-2 h-2 rounded-full ${dotColor(selected.label)}`} />
                  {labelText(selected.label)}
                </span>
              </div>

              {/* Contact info */}
              <div className="px-4 py-3 border-b border-gray-200 bg-white mt-2">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Contact</p>
                <div className="space-y-2">
                  <DetailRow icon="email" label="Email" value={selected.email} />
                  {selected.phone_number && <DetailRow icon="phone" label="Phone" value={selected.phone_number} />}
                  {selected.linkedin_url && (
                    <div className="flex items-start gap-2">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 text-gray-400 shrink-0">
                        <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/>
                        <rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>
                      </svg>
                      <a
                        href={selected.linkedin_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-indigo-600 hover:underline truncate"
                      >
                        LinkedIn Profile
                      </a>
                    </div>
                  )}
                </div>
              </div>

              {/* Company info */}
              <div className="px-4 py-3 border-b border-gray-200 bg-white mt-2">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Company</p>
                <div className="space-y-2">
                  {selected.company_name && <DetailRow icon="building" label="Name" value={selected.company_name} />}
                  {selected.industry && <DetailRow icon="tag" label="Industry" value={selected.industry} />}
                  {(selected.city || selected.country) && (
                    <DetailRow icon="location" label="Location" value={[selected.city, selected.country].filter(Boolean).join(', ')} />
                  )}
                </div>
              </div>

              {/* Activity */}
              <div className="px-4 py-3 bg-white mt-2">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Activity</p>
                <div className="space-y-2">
                  {selected.campaign_name && (
                    <div className="flex items-start gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-1.5 shrink-0" />
                      <div>
                        <p className="text-xs text-gray-700">Replied to campaign</p>
                        <p className="text-[11px] text-gray-500">{cleanCampaign(selected.campaign_name)}</p>
                      </div>
                    </div>
                  )}
                  <div className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-400 mt-1.5 shrink-0" />
                    <div>
                      <p className="text-xs text-gray-700">Marked as {labelText(selected.label)}</p>
                      <p className="text-[11px] text-gray-500">{fmtDateLong(selected.first_replied_at)}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-gray-50">
            <div className="text-center">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-3 text-gray-200">
                <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
                <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
              </svg>
              <p className="text-sm text-gray-400">Select a lead to view</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Small icon row helper ─────────────────────────────────────────────────
function DetailRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  const icons: Record<string, React.ReactNode> = {
    email: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>,
    phone: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.44A2 2 0 0 1 3.62 1.25h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 8a16 16 0 0 0 6.72 6.72l.95-.95a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>,
    building: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
    tag: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
    location: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
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
