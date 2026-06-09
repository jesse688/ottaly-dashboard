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

const LABEL_COLOR: Record<string, string> = {
  INTERESTED:          'bg-blue-100 text-blue-700',
  MEETING_BOOKED:      'bg-green-100 text-green-700',
  MEETING_COMPLETED:   'bg-teal-100 text-teal-700',
  CLOSED:              'bg-red-100 text-red-600',
  NOT_INTERESTED:      'bg-gray-100 text-gray-500',
  INFO:                'bg-yellow-100 text-yellow-700',
}

const LABEL_DISPLAY: Record<string, string> = {
  INTERESTED:          'Lead',
  MEETING_BOOKED:      'Meeting Booked',
  MEETING_COMPLETED:   'Meeting Completed',
  CLOSED:              'Closed',
  NOT_INTERESTED:      'Not Interested',
  INFO:                'Info',
}

function labelColor(label: string | null) {
  return LABEL_COLOR[label ?? ''] ?? 'bg-indigo-100 text-indigo-700'
}
function labelDisplay(label: string | null) {
  return LABEL_DISPLAY[label ?? ''] ?? (label ?? 'Lead')
}

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
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function UniboxClient({ companyName }: { companyName: string }) {
  const [leads, setLeads] = useState<Lead[] | null>(null)
  const [selected, setSelected] = useState<Lead | null>(null)
  const [activeLabel, setActiveLabel] = useState<string>('all')
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

  // Build label tabs from actual data
  const allLabels = leads
    ? Array.from(new Set(leads.map(l => l.label).filter(Boolean) as string[]))
    : []

  const filtered = (leads ?? []).filter(l => {
    const matchLabel = activeLabel === 'all' || l.label === activeLabel
    const matchSearch = !search ||
      fullName(l).toLowerCase().includes(search.toLowerCase()) ||
      (l.company_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      l.email.toLowerCase().includes(search.toLowerCase())
    return matchLabel && matchSearch
  })

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST' })
    router.push('/login')
  }

  return (
    <div className="h-screen flex flex-col bg-white overflow-hidden">
      {/* Top bar */}
      <header className="h-12 bg-slate-900 flex items-center px-4 shrink-0 gap-3">
        <span className="text-white font-bold text-sm tracking-wide">Ottaly</span>
        <span className="text-slate-500 text-xs">|</span>
        <span className="text-slate-300 text-sm">{companyName}</span>
        <div className="ml-auto flex items-center gap-3">
          <button onClick={handleLogout} className="text-slate-400 hover:text-white text-xs transition-colors">
            Sign out
          </button>
          <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-semibold">
            {companyName.charAt(0).toUpperCase()}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — lead list */}
        <div className="w-80 border-r border-gray-100 flex flex-col shrink-0 bg-white">

          {/* Search */}
          <div className="px-3 pt-3 pb-2">
            <input
              type="text"
              placeholder="Search leads..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full px-3 py-1.5 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-300 bg-gray-50"
            />
          </div>

          {/* Label filter tabs */}
          <div className="px-3 pb-2 flex gap-1 flex-wrap">
            <button
              onClick={() => setActiveLabel('all')}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                activeLabel === 'all'
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              All {leads && `(${leads.length})`}
            </button>
            {allLabels.map(label => (
              <button
                key={label}
                onClick={() => setActiveLabel(label)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  activeLabel === label
                    ? 'bg-indigo-600 text-white'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {labelDisplay(label)} ({leads!.filter(l => l.label === label).length})
              </button>
            ))}
          </div>

          <div className="h-px bg-gray-100" />

          {/* Lead list */}
          <div className="flex-1 overflow-y-auto">
            {leads === null ? (
              Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex gap-3 px-3 py-3 border-b border-gray-50">
                  <div className="w-9 h-9 rounded-full bg-gray-100 animate-pulse shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-gray-100 rounded animate-pulse w-3/4" />
                    <div className="h-3 bg-gray-100 rounded animate-pulse w-1/2" />
                  </div>
                </div>
              ))
            ) : filtered.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-400">No leads found</div>
            ) : (
              filtered.map(lead => (
                <button
                  key={lead.id}
                  onClick={() => setSelected(lead)}
                  className={`w-full text-left flex gap-3 px-3 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                    selected?.id === lead.id ? 'bg-indigo-50 border-l-2 border-l-indigo-500' : 'border-l-2 border-l-transparent'
                  }`}
                >
                  <div className="w-9 h-9 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 text-xs font-semibold shrink-0">
                    {initials(lead)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-sm font-medium text-gray-900 truncate">{fullName(lead)}</span>
                      <span className="text-xs text-gray-400 shrink-0">{fmtDate(lead.first_replied_at)}</span>
                    </div>
                    <div className="text-xs text-gray-500 truncate mt-0.5">
                      {lead.company_name || lead.email}
                    </div>
                    {lead.label && (
                      <span className={`inline-flex mt-1 px-1.5 py-0.5 rounded text-xs font-medium ${labelColor(lead.label)}`}>
                        {labelDisplay(lead.label)}
                      </span>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right panel — detail */}
        <div className="flex-1 overflow-auto bg-white">
          {selected ? (
            <div className="p-6 max-w-xl">
              {/* Header */}
              <div className="flex items-start justify-between mb-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-semibold text-base">
                    {initials(selected)}
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">{fullName(selected)}</h2>
                    <p className="text-sm text-gray-500">{selected.email}</p>
                  </div>
                </div>
                {selected.label && (
                  <span className={`inline-flex px-2.5 py-1 rounded-full text-sm font-medium ${labelColor(selected.label)}`}>
                    {labelDisplay(selected.label)}
                  </span>
                )}
              </div>

              {/* Info cards */}
              <div className="grid grid-cols-2 gap-3 mb-6">
                {[
                  { label: 'Company',  value: selected.company_name },
                  { label: 'Email',    value: selected.email },
                  { label: 'Campaign', value: selected.campaign_name },
                  { label: 'Replied',  value: selected.first_replied_at
                    ? new Date(selected.first_replied_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
                    : null },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-gray-50 rounded-lg p-3">
                    <p className="text-xs text-gray-400 mb-0.5">{label}</p>
                    <p className="text-sm font-medium text-gray-900 break-all">{value || '—'}</p>
                  </div>
                ))}
              </div>

              {/* Replied indicator */}
              <div className="rounded-xl border border-gray-100 p-4">
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-500 shrink-0">
                    <polyline points="9 11 12 14 22 4"/>
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                  </svg>
                  <span>Replied to your campaign</span>
                  {selected.first_replied_at && (
                    <span className="text-gray-400">· {fmtDate(selected.first_replied_at)}</span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <p className="text-sm text-gray-400">Select a lead to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
