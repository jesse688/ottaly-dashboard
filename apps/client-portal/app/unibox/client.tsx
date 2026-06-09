'use client'

import { useEffect, useState } from 'react'
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
  INTERESTED:        'bg-green-50 text-green-700 border border-green-200',
  MEETING_BOOKED:    'bg-blue-50 text-blue-700 border border-blue-200',
  MEETING_COMPLETED: 'bg-teal-50 text-teal-700 border border-teal-200',
  CLOSED:            'bg-red-50 text-red-600 border border-red-200',
  NOT_INTERESTED:    'bg-gray-50 text-gray-500 border border-gray-200',
  INFO:              'bg-yellow-50 text-yellow-700 border border-yellow-200',
}
const LABEL_DISPLAY: Record<string, string> = {
  INTERESTED:        'Lead',
  MEETING_BOOKED:    'Meeting Booked',
  MEETING_COMPLETED: 'Meeting Completed',
  CLOSED:            'Closed',
  NOT_INTERESTED:    'Not Interested',
  INFO:              'Info',
}
function dotColor(l: string | null) { return LABEL_DOT[l ?? ''] ?? 'bg-indigo-400' }
function badgeClass(l: string | null) { return LABEL_BADGE[l ?? ''] ?? 'bg-indigo-50 text-indigo-700 border border-indigo-200' }
function labelText(l: string | null) { return LABEL_DISPLAY[l ?? ''] ?? (l ?? 'Lead') }

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
function cleanCampaignName(name: string | null) {
  if (!name) return null
  // Strip URL portion: "CampaignName https://app.apollo.io/..." → "CampaignName"
  const withoutUrl = name.replace(/\s+https?:\/\/\S+/g, '').trim()
  const clean = withoutUrl || name
  return clean.length > 40 ? clean.slice(0, 40) + '…' : clean
}

// ── Avatar colours (cycle through 8 colours) ─────────────────────────────
const AVATAR_COLORS = [
  'bg-indigo-100 text-indigo-700',
  'bg-pink-100 text-pink-700',
  'bg-amber-100 text-amber-700',
  'bg-teal-100 text-teal-700',
  'bg-purple-100 text-purple-700',
  'bg-blue-100 text-blue-700',
  'bg-green-100 text-green-700',
  'bg-rose-100 text-rose-700',
]
function avatarColor(id: string) {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i)) % AVATAR_COLORS.length
  return AVATAR_COLORS[hash]
}

// ── Deterministic fake reply content ─────────────────────────────────────
const REPLIES = [
  (name: string) => `Hi,\n\nThanks for reaching out — this is actually great timing. We've been looking at options for this and your approach sounds interesting.\n\nHappy to jump on a call. What does your availability look like next week?\n\nCheers,\n${name}`,
  (name: string) => `Hi there,\n\nAppreciate you getting in touch. Yes, I'd be open to learning more about what you offer — can you send over some info first and then we can decide if a call makes sense?\n\nThanks,\n${name}`,
  (name: string) => `Hello,\n\nYes I'm interested. We've been struggling with lead generation and this could be a good fit.\n\nFeel free to book a slot on my calendar or suggest a time.\n\nBest regards,\n${name}`,
  (name: string) => `Thanks for the email.\n\nWe're actually in the middle of a growth push right now so the timing is good. Would love to hear more — let's get a call scheduled.\n\n${name}`,
  (name: string) => `Hi,\n\nGood to hear from you. I'd definitely be interested in exploring this further. We're always open to solutions that can drive more qualified leads.\n\nWhen are you available for a 15-minute chat?\n\nKind regards,\n${name}`,
]
function pickReply(id: string) {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return REPLIES[hash % REPLIES.length]
}
function ReplyContent({ lead }: { lead: Lead }) {
  const text = pickReply(lead.id)(lead.first_name ?? fullName(lead).split(' ')[0])
  return (
    <>
      {text.split('\n').map((line, i) =>
        line ? <p key={i} className="mb-2 last:mb-0">{line}</p> : <br key={i} />
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────
export function UniboxClient({ companyName }: { companyName: string }) {
  const [leads, setLeads] = useState<Lead[] | null>(null)
  const [selected, setSelected] = useState<Lead | null>(null)
  const [activeLabel, setActiveLabel] = useState<string | null>(null) // null = inbox (all)
  const [search, setSearch] = useState('')
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

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST' })
    router.push('/login')
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* ── Top bar ── */}
      <header className="h-12 bg-[#1a2332] flex items-center px-4 shrink-0 gap-3 z-10">
        <div className="flex items-center gap-2">
          <span className="text-white font-bold text-sm tracking-wide">Ottaly</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-400">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <span className="text-slate-300 text-sm">{companyName}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={handleLogout} className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-white text-xs font-semibold hover:bg-slate-600 transition-colors">
            {companyName.charAt(0).toUpperCase()}
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">

        {/* ── Sidebar ── */}
        <aside className="w-52 bg-white border-r border-gray-100 flex flex-col shrink-0 overflow-y-auto">
          {/* Inbox */}
          <div className={`flex items-center gap-2.5 px-4 py-2.5 cursor-pointer transition-colors ${activeLabel === null ? 'border-l-2 border-l-indigo-500 bg-gray-50 text-gray-900' : 'border-l-2 border-l-transparent text-gray-600 hover:bg-gray-50'}`}
            onClick={() => setActiveLabel(null)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={activeLabel === null ? 'text-indigo-500' : 'text-gray-400'}>
              <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
              <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
            </svg>
            <span className="text-sm font-medium">Inbox</span>
            {leads && (
              <span className="ml-auto text-xs text-gray-400">{leads.length}</span>
            )}
          </div>

          {/* Labels section */}
          {allLabels.length > 0 && (
            <div className="mt-2">
              <div className="px-4 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Labels</div>
              {allLabels.map(label => (
                <div
                  key={label}
                  onClick={() => setActiveLabel(label)}
                  className={`flex items-center gap-2.5 px-4 py-2 cursor-pointer transition-colors text-sm ${
                    activeLabel === label
                      ? 'border-l-2 border-l-indigo-500 bg-gray-50 text-gray-900'
                      : 'border-l-2 border-l-transparent text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotColor(label)}`} />
                  <span className="truncate">{labelText(label)}</span>
                  {leads && (
                    <span className="ml-auto text-xs text-gray-400">
                      {leads.filter(l => l.label === label).length}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex-1" />

          {/* Sign out */}
          <button
            onClick={handleLogout}
            className="flex items-center gap-2.5 px-4 py-3 text-sm text-gray-400 hover:text-gray-600 border-t border-gray-100 transition-colors"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Sign out
          </button>
        </aside>

        {/* ── Lead list ── */}
        <div className="w-72 border-r border-gray-100 flex flex-col shrink-0 bg-white">
          {/* Header */}
          <div className="px-4 pt-4 pb-2 border-b border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900">
                Your Leads
                <span className="ml-1.5 text-gray-400 font-normal">({filtered.length})</span>
              </h2>
            </div>
            <div className="relative">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                type="text"
                placeholder="Search mail"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 rounded-md border border-gray-200 text-sm outline-none focus:border-indigo-300 bg-gray-50"
              />
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {leads === null ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex gap-3 px-4 py-3 border-b border-gray-50">
                  <div className="w-9 h-9 rounded-full bg-gray-100 animate-pulse shrink-0" />
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-3 bg-gray-100 rounded animate-pulse w-3/4" />
                    <div className="h-3 bg-gray-100 rounded animate-pulse w-1/2" />
                  </div>
                </div>
              ))
            ) : filtered.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-gray-400">No leads found</div>
            ) : (
              filtered.map(lead => (
                <button
                  key={lead.id}
                  onClick={() => setSelected(lead)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                    selected?.id === lead.id ? 'bg-blue-50' : ''
                  }`}
                >
                  <div className="flex gap-3">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${avatarColor(lead.id)}`}>
                      {initials(lead)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-1">
                        <span className="text-sm font-semibold text-gray-900 truncate leading-tight">{fullName(lead)}</span>
                        <span className="text-xs text-gray-400 shrink-0 mt-0.5">{fmtDate(lead.first_replied_at)}</span>
                      </div>
                      <div className="text-xs text-gray-500 truncate mt-0.5">
                        {lead.company_name || lead.email}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        {lead.campaign_name && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-xs">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.44A2 2 0 0 1 3.62 1.25h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 8a16 16 0 0 0 6.72 6.72l.95-.95a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                            </svg>
                            {cleanCampaignName(lead.campaign_name)}
                          </span>
                        )}
                        {lead.label && (
                          <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${badgeClass(lead.label)}`}>
                            {labelText(lead.label)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* ── Detail panel ── */}
        <div className="flex-1 overflow-auto bg-white">
          {selected ? (
            <div className="h-full flex flex-col">
              {/* Detail header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${avatarColor(selected.id)}`}>
                    {initials(selected)}
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">{fullName(selected)}</h3>
                    <p className="text-xs text-gray-500">{selected.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {selected.label && (
                    <span className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium ${badgeClass(selected.label)}`}>
                      <span className={`w-2 h-2 rounded-full ${dotColor(selected.label)}`} />
                      {labelText(selected.label)}
                    </span>
                  )}
                </div>
              </div>

              {/* Campaign tag */}
              {selected.campaign_name && (
                <div className="px-6 py-2 border-b border-gray-50 bg-gray-50">
                  <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.44A2 2 0 0 1 3.62 1.25h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 8a16 16 0 0 0 6.72 6.72l.95-.95a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                    </svg>
                    {cleanCampaignName(selected.campaign_name)}
                  </span>
                </div>
              )}

              {/* Detail body */}
              <div className="flex-1 px-6 py-5 overflow-y-auto">
                <div className="max-w-lg space-y-5">
                  {/* Original outreach (collapsed / preview) */}
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-xs font-semibold text-indigo-700 shrink-0">
                      O
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-gray-900">Ottaly</span>
                        <span className="text-xs text-gray-400">outreach@ottaly.co.uk</span>
                      </div>
                      <div className="text-xs text-gray-500 mb-2">
                        to: {selected.email}
                      </div>
                      <div className="bg-gray-50 rounded-lg px-4 py-3 text-sm text-gray-600 border border-gray-100">
                        <p>Hi {selected.first_name ?? fullName(selected).split(' ')[0]},</p>
                        <p className="mt-2">I came across {selected.company_name ?? 'your company'} and wanted to reach out — we work with businesses like yours to help generate qualified leads through targeted outreach.</p>
                        <p className="mt-2">Would you be open to a quick 15-minute call this week to explore if there&apos;s a fit?</p>
                        <p className="mt-2">Best,<br />Ottaly Team</p>
                      </div>
                    </div>
                  </div>

                  {/* Lead reply */}
                  <div className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${avatarColor(selected.id)}`}>
                      {initials(selected)}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-gray-900">{fullName(selected)}</span>
                        {selected.first_replied_at && (
                          <span className="text-xs text-gray-400">
                            {new Date(selected.first_replied_at).toLocaleDateString('en-GB', {
                              day: 'numeric', month: 'short', year: 'numeric',
                            })}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 mb-2">to: outreach@ottaly.co.uk</div>
                      <div className="bg-white rounded-lg px-4 py-3 text-sm text-gray-700 border border-gray-200 shadow-sm">
                        <ReplyContent lead={selected} />
                      </div>
                    </div>
                  </div>

                  {/* Lead details */}
                  <div className="border-t border-gray-100 pt-4">
                    <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Lead Details</h4>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                      {[
                        { label: 'Full Name',  value: fullName(selected) },
                        { label: 'Email',      value: selected.email },
                        { label: 'Company',    value: selected.company_name },
                        { label: 'Replied',    value: selected.first_replied_at
                          ? new Date(selected.first_replied_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
                          : null },
                      ].map(({ label, value }) => (
                        <div key={label}>
                          <p className="text-xs text-gray-400 mb-0.5">{label}</p>
                          <p className="text-sm text-gray-900 font-medium break-all">{value || '—'}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-3 text-gray-200">
                  <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
                  <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
                </svg>
                <p className="text-sm text-gray-400">Select a lead to view details</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
