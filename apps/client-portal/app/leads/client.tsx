'use client'

import { useEffect, useRef, useState, type ReactNode, type ChangeEvent, type KeyboardEvent } from 'react'
import { Logo } from '@/app/components/Logo'
import { WarmupBar } from '@/app/components/WarmupBar'
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
  first_responded_at: string | null
  last_reply_at: string | null
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
  mobile_phone: string | null
  office_phone: string | null
  ch_company_number: string | null
  ch_company_status: string | null
  ch_company_type: string | null
  ch_incorporated_on: string | null
  ch_registered_address: string | null
  ch_sic_codes: string | null
  custom_fields: { label: string; value: string }[] | null
  deal_value: string | null
  deal_notes: string | null
  client_label: string | null
  dispute_status: string | null
  dispute_reason: string | null
  dispute_admin_note: string | null
  has_unread: boolean
  dispute_eligible: boolean
  archived: boolean
  has_sent: boolean
  has_outbound: boolean
  replied_off: boolean
  locked: boolean
  is_info: boolean   // near-lead shown to the client but NOT billed (label='INFO')
}
// A lead "needs reply" until our most recent response is NEWER than the prospect's
// most recent inbound. has_outbound is that time-aware signal (computed server-side:
// latest genuine OUT >= latest IN). We deliberately do NOT OR-in the sticky has_sent /
// replied_off flags here: those stay true forever once set, so a SECOND prospect reply
// after we'd answered would never re-surface the lead. has_outbound already counts a
// portal-sent reply, so a real response still clears "Needs reply".
const isReplied = (l: Lead) => l.has_outbound

// Pay-per-lead clients are billed per lead and never top up. Matches the Billing
// page + lib/balance.ts. Hardcoded to Bubble for now.
const PAY_PER_LEAD_WORKSPACES = new Set(['6a0e29d0d004be93be3f33f2']) // Bubble
const PAY_PER_LEAD_COMPANIES = new Set(['bubble'])

interface ThreadMsg {
  id: string
  direction: 'IN' | 'OUT'
  subject: string | null
  body_html: string | null
  body_html_safe: string | null   // server-sanitized HTML, safe to render
  body_text: string | null
  content_preview: string | null
  from_email: string | null
  to_email: string | null
  eaccount: string | null
  pv_label: string | null
  sent_via_portal: boolean
  timestamp_created: string | null
  attachments?: { id?: string; filename: string; size?: number; content_type?: string }[] | null
}

interface CustomLabel { id: string; name: string; color: string; prompts_value?: boolean }

const COLOR_MAP: Record<string, string> = {
  purple: 'bg-purple-400', pink: 'bg-pink-400', orange: 'bg-orange-400',
  cyan: 'bg-cyan-400', lime: 'bg-lime-400', rose: 'bg-rose-400',
  green: 'bg-green-400', blue: 'bg-blue-400', teal: 'bg-teal-400',
  red: 'bg-red-400', yellow: 'bg-yellow-400', indigo: 'bg-indigo-400',
  amber: 'bg-amber-400', sky: 'bg-sky-400', violet: 'bg-violet-400',
  fuchsia: 'bg-fuchsia-400', emerald: 'bg-emerald-400', gray: 'bg-gray-400',
}
const COLOR_BADGE: Record<string, string> = {
  purple: 'bg-purple-100 text-purple-700', pink: 'bg-pink-100 text-pink-700',
  orange: 'bg-orange-100 text-orange-700', cyan: 'bg-cyan-100 text-cyan-700',
  lime: 'bg-lime-100 text-lime-700', rose: 'bg-rose-100 text-rose-700',
  green: 'bg-green-100 text-green-700', blue: 'bg-blue-100 text-blue-700',
  teal: 'bg-teal-100 text-teal-700', red: 'bg-red-100 text-red-700',
  yellow: 'bg-yellow-100 text-yellow-700', indigo: 'bg-indigo-100 text-indigo-700',
  amber: 'bg-amber-100 text-amber-700', sky: 'bg-sky-100 text-sky-700',
  violet: 'bg-violet-100 text-violet-700', fuchsia: 'bg-fuchsia-100 text-fuchsia-700',
  emerald: 'bg-emerald-100 text-emerald-700', gray: 'bg-gray-100 text-gray-700',
}
const CUSTOM_COLORS = Object.keys(COLOR_BADGE)

const NONLEAD_CATEGORIES = ['No response after follow-ups', 'Out of office / auto-reply only', 'Not interested', 'Wrong contact / left company', 'Spam or invalid']
const ICP_CATEGORIES = ['Wrong industry', 'Wrong job role / seniority', 'Wrong location', 'Wrong company size', 'Not our target market']
const AV = ['bg-brand-100 text-brand-700','bg-pink-100 text-pink-700','bg-amber-100 text-amber-700','bg-teal-100 text-teal-700','bg-purple-100 text-purple-700','bg-blue-100 text-blue-700','bg-green-100 text-green-700','bg-rose-100 text-rose-700']

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

// Escape one value for CSV: wrap in quotes and double any internal quotes, so
// commas/newlines/quotes inside a field never break the columns. Excel/Sheets-safe.
function csvCell(v: string | null | undefined): string {
  const s = (v ?? '').toString().replace(/\r?\n/g, ' ').trim()
  return `"${s.replace(/"/g, '""')}"`
}

// Build a CSV from the leads the client can see and trigger a download. Locked
// leads (delivered while out of credit) are EXCLUDED — they're not paid for, so
// their details never leave in the export. Columns mirror the lead detail panel:
// contact + company + Companies House + deal stage/value.
function downloadLeadsCsv(leads: Lead[], companyName: string) {
  const exportable = leads.filter(l => !l.locked)
  // Name fallback: some leads arrive with no first/last name (only the email).
  // Derive a readable name from the email local-part so no row is blank.
  const nameFromEmail = (l: Lead): { first: string; last: string } => {
    const local = (l.email ?? '').split('@')[0] ?? ''
    const parts = local.split(/[._-]+/).filter(Boolean)
      .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    return { first: parts[0] ?? '', last: parts.slice(1).join(' ') }
  }
  const firstName = (l: Lead) => (l.first_name?.trim() || nameFromEmail(l).first) || null
  const lastName  = (l: Lead) => (l.last_name?.trim()  || nameFromEmail(l).last)  || null
  // The lead's contact address only when it DIFFERS from the CH registered
  // address (CH enrichment copies the registered address into address_line, so
  // showing both just duplicated the column).
  const contactAddress = (l: Lead) => {
    const a = (l.address_line ?? '').trim()
    if (!a || a === (l.ch_registered_address ?? '').trim()) return null
    return a
  }
  const columns: { header: string; get: (l: Lead) => string | null }[] = [
    { header: 'First name', get: firstName },
    { header: 'Last name', get: lastName },
    { header: 'Email', get: l => l.email },
    { header: 'Mobile', get: l => l.mobile_phone ?? l.phone_number },
    { header: 'Office', get: l => l.office_phone },
    { header: 'Job title', get: l => l.job_title },
    { header: 'Company', get: l => l.company_name },
    { header: 'Website', get: l => l.company_website },
    { header: 'LinkedIn', get: l => l.linkedin_url },
    { header: 'Company LinkedIn', get: l => l.linkedin_company_url },
    { header: 'Industry', get: l => l.industry },
    { header: 'City', get: l => l.city },
    { header: 'Country', get: l => l.country },
    { header: 'Contact address', get: contactAddress },
    { header: 'CH company number', get: l => l.ch_company_number },
    { header: 'CH status', get: l => l.ch_company_status },
    { header: 'CH type', get: l => l.ch_company_type },
    { header: 'CH incorporated', get: l => l.ch_incorporated_on },
    { header: 'CH registered address', get: l => l.ch_registered_address },
    { header: 'CH SIC codes', get: l => l.ch_sic_codes },
    { header: 'Stage', get: l => l.client_label },
    { header: 'Deal value', get: l => l.deal_value },
    { header: 'Campaign', get: l => l.campaign_name },
    { header: 'First replied', get: l => l.first_replied_at },
  ]
  const header = columns.map(c => csvCell(c.header)).join(',')
  const rows = exportable.map(l => columns.map(c => csvCell(c.get(l))).join(','))
  // Prepend a BOM so Excel opens UTF-8 (accents, £) correctly.
  const csv = '﻿' + [header, ...rows].join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const date = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `${(companyName || 'leads').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-leads-${date}.csv`
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}

// Download ONE lead — richer than the bulk export (every field), written as a
// Field,Value sheet so it's readable for a single record.
function downloadLeadCsv(l: Lead) {
  const emailLocal = (l.email ?? '').split('@')[0] ?? ''
  const guessFirst = emailLocal.split(/[._-]+/).filter(Boolean).map(p => p.charAt(0).toUpperCase() + p.slice(1))[0] ?? ''
  const fields: [string, string | null][] = [
    ['First name', l.first_name?.trim() || guessFirst || null],
    ['Last name', l.last_name],
    ['Email', l.email],
    ['Mobile', l.mobile_phone ?? l.phone_number],
    ['Office', l.office_phone],
    ['Job title', l.job_title],
    ['Department', l.department],
    ['Company', l.company_name],
    ['Website', l.company_website],
    ['LinkedIn', l.linkedin_url],
    ['Company LinkedIn', l.linkedin_company_url],
    ['Industry', l.industry],
    ['City', l.city],
    ['State', l.state],
    ['Country', l.country],
    ['Address', l.address_line],
    ['CH company number', l.ch_company_number],
    ['CH status', l.ch_company_status],
    ['CH type', l.ch_company_type],
    ['CH incorporated', l.ch_incorporated_on],
    ['CH registered address', l.ch_registered_address],
    ['CH SIC codes', l.ch_sic_codes],
    ['Stage', l.client_label],
    ['Deal value', l.deal_value],
    ['Deal notes', l.deal_notes],
    ['Campaign', l.campaign_name],
    ['First replied', l.first_replied_at],
    ['Last reply', l.last_reply_at],
  ]
  const csv = '﻿' + [['Field', 'Value'], ...fields.map(([k, v]) => [k, v])].map(r => r.map(csvCell).join(',')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const who = (l.first_name && l.last_name) ? `${l.first_name}-${l.last_name}` : (l.email?.split('@')[0] ?? 'lead')
  a.href = url
  a.download = `lead-${who.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}
// Split an email body into the new reply vs the quoted history below it, so the
// client reads the actual reply and our earlier email tucks into a fold.
// Some messages (esp. received mail) arrive with ONLY an HTML body and no
// plain-text part. Strip the HTML to readable text so they don't show as
// "(no content)". Best-effort — good enough for display.
function htmlToText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function splitQuote(text: string): { main: string; quoted: string } {
  if (!text) return { main: '', quoted: '' }
  const patterns = [
    /\n\s*-{2,}\s*Original Message\s*-{2,}/i,
    /\n\s*>?\s*On\b[\s\S]{0,200}?\bwrote:\s*/,   // "On <date> <name> wrote:" (optional > prefix)
    /\n\s*>/,                                     // first Gmail-style quoted line
    /\n_{5,}/,
    /\n\s*From:\s.+\n\s*(Sent|Date):\s/i,
  ]
  let idx = -1
  for (const re of patterns) {
    const m = text.match(re)
    if (m && m.index !== undefined && (idx === -1 || m.index < idx)) idx = m.index
  }
  if (idx === -1) return { main: text.trim(), quoted: '' }
  // Strip leading "> " quote markers from the folded history for readability.
  const quoted = text.slice(idx).replace(/^[ \t]*>+[ \t]?/gm, '').trim()
  return { main: text.slice(0, idx).trim(), quoted }
}

export function UniboxClient({ companyName, clientName, clientEmail = '', workspaces = [], activeWorkspaceId }: { companyName: string; clientName: string; clientEmail?: string; workspaces?: Array<{ clientId: string; workspaceId: string; companyName: string }>; activeWorkspaceId?: string }) {
  async function switchWorkspace(workspaceId: string) {
    if (!workspaceId || workspaceId === activeWorkspaceId) return
    try {
      const r = await fetch('/api/portal/switch-workspace', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      })
      if (r.ok) window.location.reload()
    } catch { /* ignore — stay on current workspace */ }
  }
  // First name for the greeting; falls back to the company/account name.
  const greetingName = (clientName || companyName || '').trim().split(/\s+/)[0] || 'there'
  // Pay-per-lead clients (e.g. Bubble) are billed per lead and never top up, so
  // never show the "Top Up Now" button. Matches the Billing page logic.
  const payPerLead =
    PAY_PER_LEAD_WORKSPACES.has((activeWorkspaceId ?? '').trim().toLowerCase()) ||
    PAY_PER_LEAD_COMPANIES.has((companyName ?? '').trim().toLowerCase())
  const [leads, setLeads] = useState<Lead[] | null>(null)
  const [selected, setSelected] = useState<Lead | null>(null)
  const [thread, setThread] = useState<ThreadMsg[] | null>(null)
  const [customLabels, setCustomLabels] = useState<CustomLabel[]>([])
  const [activeLabel, setActiveLabel] = useState<string | null>(null)
  const [view, setView] = useState<'inbox' | 'unread' | 'sent' | 'archived'>('unread')
  const [search, setSearch] = useState('')
  const [balance, setBalance] = useState<{ balance: number; currency: string; lowThreshold: number } | null>(null)
  // Unpaid-invoice nudge shown under the header; dismissible per session.
  const [hasUnpaidInvoice, setHasUnpaidInvoice] = useState(false)
  const [invoiceBannerDismissed, setInvoiceBannerDismissed] = useState(false)
  // Friendly greeting — shown ONCE per browser session (on login / first load),
  // not every time the user navigates back to Leads from Billing/Account.
  const [showWelcome, setShowWelcome] = useState(false)
  // Mobile drawers: left sidebar (views/stages) and right contact panel.
  const [showSidebar, setShowSidebar] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  // Forward: seeds the composer with quoted content + an empty recipient.
  const [forwardSeed, setForwardSeed] = useState<{ id: number; html: string } | null>(null)

  const [labelDrop, setLabelDrop] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)

  const [replying, setReplying] = useState(false)
  const [replyMsg, setReplyMsg] = useState('')

  // Client's private notes on the selected lead (persisted via PATCH …/data).
  const [notes, setNotes] = useState('')
  const [notesSavedAt, setNotesSavedAt] = useState<number | null>(null)
  const [notesSaving, setNotesSaving] = useState(false)
  const notesLoadedFor = useRef<string | null>(null)


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
  // Separate drag state for REORDERING stages (distinct from dragging a lead).
  const [dragStageId, setDragStageId] = useState<string | null>(null)
  const [stageDropTarget, setStageDropTarget] = useState<string | null>(null)

  const [showNewLabel, setShowNewLabel] = useState(false)
  const [newLabelName, setNewLabelName] = useState('')
  const [newLabelColor, setNewLabelColor] = useState('purple')

  const router = useRouter()

  useEffect(() => {
    loadLeads()
    fetch('/api/portal/labels').then(r => r.json()).then((d) => Array.isArray(d) && setCustomLabels(d)).catch(() => {})
    fetch('/api/portal/balance').then(r => r.json()).then((d) => !d.error && setBalance(d)).catch(() => {})
    fetch('/api/portal/invoices').then(r => r.json()).then((d) => {
      if (Array.isArray(d?.invoices)) setHasUnpaidInvoice(d.invoices.some((i: { status: string }) => i.status === 'unpaid'))
    }).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function h(e: MouseEvent) { if (dropRef.current && !dropRef.current.contains(e.target as Node)) setLabelDrop(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  // Show the welcome greeting ONCE per browser session, then auto-dismiss it.
  // Navigating Leads ↔ Billing ↔ Account won't replay it; a fresh login does.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (sessionStorage.getItem('ottaly_welcomed')) return
    sessionStorage.setItem('ottaly_welcomed', '1')
    setShowWelcome(true)
    const t = setTimeout(() => setShowWelcome(false), 3900)
    return () => clearTimeout(t)
  }, [])

  // Show the unread (not-yet-replied) count in the browser tab.
  useEffect(() => {
    const n = (leads ?? []).filter(l => !l.archived && !l.locked && !isReplied(l)).length
    document.title = n > 0 ? `(${n}) Unread · Ottaly` : 'Ottaly Portal'
  }, [leads])

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
    setReplyMsg('')
    setShowDispute(false); setThread(null); setShowDetails(false)
    // Load this lead's saved notes (current value from the server, not the list's
    // possibly-suppressed copy). Reset saved-state for the new lead.
    setNotes(''); setNotesSavedAt(null); notesLoadedFor.current = null
    if (!lead.locked) {
      fetch(`/api/portal/leads/${lead.id}/data`).then(r => r.json()).then((d: { notes?: string | null }) => {
        notesLoadedFor.current = lead.id
        setNotes(d?.notes ?? '')
      }).catch(() => { notesLoadedFor.current = lead.id })
    }
    // Locked leads never load their conversation.
    if (lead.locked) { setThread([]); return }
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
  }

  // Drag a lead row onto a stage in the sidebar to assign it.
  async function dropOnStage(name: string | null) {
    const leadId = dragLeadId
    setDragOver(null); setDragLeadId(null)
    if (!leadId) return
    setLeads(prev => prev?.map(l => l.id === leadId ? { ...l, client_label: name } : l) ?? null)
    setSelected(prev => prev?.id === leadId ? { ...prev, client_label: name } : prev)
    await fetch(`/api/portal/leads/${leadId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: name }) })
  }

  async function toggleArchive(lead: Lead) {
    const archived = !lead.archived
    setLeads(prev => prev?.map(l => l.id === lead.id ? { ...l, archived } : l) ?? null)
    setSelected(prev => prev?.id === lead.id ? { ...prev, archived } : prev)
    await fetch(`/api/portal/leads/${lead.id}/data`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived }) })
  }

  function handleForward(m: ThreadMsg) {
    const orig = (m.body_text || m.content_preview || '').trim()
    const header = `---------- Forwarded message ----------\nFrom: ${m.from_email ?? (selected ? fullName(selected) : '')}\nSubject: ${m.subject ?? ''}\n\n`
    const html = `<p></p><p>${(header + orig).replace(/\n/g, '<br/>')}</p>`
    setForwardSeed({ id: Date.now(), html })
  }

  async function handleReply(text: string, html: string, to: string, cc: string, files: File[] = []) {
    if (!text.trim() || !selected) return
    setReplying(true); setReplyMsg('')
    let res: Response
    if (files.length > 0) {
      const fd = new FormData()
      fd.append('body', text)
      fd.append('bodyHtml', html)
      fd.append('to', to)
      fd.append('cc', cc)
      // Send filenames explicitly (a parallel array) — the multipart filename can
      // be dropped/regenerated by the parser, so don't rely on it.
      for (const f of files) {
        fd.append('files', f, f.name)
        fd.append('fileNames', f.name)
      }
      res = await fetch(`/api/portal/leads/${selected.id}/reply`, { method: 'POST', body: fd })
    } else {
      res = await fetch(`/api/portal/leads/${selected.id}/reply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text, bodyHtml: html, to, cc }),
      })
    }
    const d = await res.json().catch(() => ({})) as { ok?: boolean; sentLive?: boolean }
    setReplying(false)
    if (d.ok) {
      setReplyMsg(d.sentLive ? 'Reply sent.' : 'Reply received — our team will send it shortly.')
      // Replying on the dashboard moves the lead out of Unread.
      // Set has_outbound too (that's what isReplied reads now) so the lead leaves
      // "Needs reply" immediately; has_sent kept for the Sent view filter.
      setLeads(prev => prev?.map(l => l.id === selected.id ? { ...l, has_sent: true, has_outbound: true } : l) ?? null)
      setSelected(prev => prev ? { ...prev, has_sent: true, has_outbound: true } : prev)
      // OPTIMISTIC INSERT: show the just-sent message in the thread IMMEDIATELY,
      // instead of blanking the thread and waiting on the /thread refetch (which is
      // slow for attachment sends — base64 + a 30s-timeout PlusVibe call). The
      // server already persisted this row, and the thread route content-dedups, so
      // the next refetch won't duplicate it. This fixes "I clicked send but can't
      // see my sent email with attachment".
      const optimistic: ThreadMsg = {
        id: `optimistic-${Date.now()}`,
        direction: 'OUT',
        subject: null,
        body_html: html, body_html_safe: html,
        body_text: text, content_preview: text.slice(0, 200),
        from_email: null, to_email: to, eaccount: null, pv_label: null,
        sent_via_portal: true,
        timestamp_created: new Date().toISOString(),
        attachments: files.length ? files.map(f => ({ filename: f.name, size: f.size, content_type: f.type })) : null,
      }
      setThread(prev => [...(prev ?? []), optimistic])
      // Reconcile with the server copy shortly after (replaces the optimistic row
      // with the real persisted one, incl. attachment download ids).
      setTimeout(() => { if (selected) openLead({ ...selected, has_sent: true, has_outbound: true }) }, 1200)
      setTimeout(() => setReplyMsg(''), 4000)
    } else {
      setReplyMsg('Could not send. Please try again.')
    }
  }

  // Save the client's notes for the selected lead (on blur). Best-effort; shows
  // a brief "Saved" state. Guards against firing before the lead's notes loaded.
  async function saveNotes() {
    if (!selected || notesLoadedFor.current !== selected.id) return
    setNotesSaving(true)
    try {
      await fetch(`/api/portal/leads/${selected.id}/data`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes }),
      })
      setNotesSavedAt(Date.now())
    } catch { /* leave unsaved; user can retry by editing again */ }
    finally { setNotesSaving(false) }
  }

  async function toggleRepliedOff(lead: Lead) {
    const replied_off = !lead.replied_off
    // replied_off stamps first_responded_at server-side; mirror into has_outbound so it
    // leaves "Needs reply" now (and a later prospect reply re-surfaces it on reload).
    setLeads(prev => prev?.map(l => l.id === lead.id ? { ...l, replied_off, has_outbound: replied_off } : l) ?? null)
    setSelected(prev => prev?.id === lead.id ? { ...prev, replied_off, has_outbound: replied_off } : prev)
    await fetch(`/api/portal/leads/${lead.id}/data`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replied_off }) })
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newLabelName.trim(), color: newLabelColor }),
    })
    const created = await res.json() as CustomLabel
    setCustomLabels(prev => [...prev, created])
    setNewLabelName(''); setNewLabelColor('purple'); setShowNewLabel(false)
  }

  async function deleteStage(id: string, name: string) {
    if (!confirm(`Delete the "${name}" stage? Leads in it will just lose this stage (they’re not deleted).`)) return
    setCustomLabels(prev => prev.filter(c => c.id !== id))
    if (activeLabel === name) setActiveLabel(null)
    await fetch(`/api/portal/labels/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  // Reorder: move the dragged stage to before the target stage, persist order.
  async function reorderStages(draggedId: string, targetId: string) {
    if (draggedId === targetId) return
    const ids = clientStages.map(s => s.id)
    const from = ids.indexOf(draggedId), to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    // Reflect new order locally (stable: reorder customLabels by the new id order).
    setCustomLabels(prev => {
      const byId = new Map(prev.map(s => [s.id, s]))
      const reordered = ids.map(i => byId.get(i)!).filter(Boolean)
      const rest = prev.filter(s => !ids.includes(s.id))
      return [...reordered, ...rest]
    })
    await fetch('/api/portal/labels/reorder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: ids }),
    }).catch(() => {})
  }

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST' }); router.push('/login')
  }

  const counts: Record<string, number> = {}
  for (const l of leads ?? []) if (l.client_label) counts[l.client_label] = (counts[l.client_label] ?? 0) + 1

  // Stages clients see: hide internal/dev stages like "test".
  const clientStages = customLabels.filter(cl => cl.name.trim().toLowerCase() !== 'test')

  // Unread = a new lead not yet replied to (on or off the dashboard).
  const inView = (l: Lead) =>
    view === 'archived' ? l.archived
    : l.archived ? false
    : view === 'unread' ? !isReplied(l)
    : view === 'sent' ? l.has_sent
    : true
  const viewCounts = {
    inbox: (leads ?? []).filter(l => !l.archived).length,
    unread: (leads ?? []).filter(l => !l.archived && !l.locked && !isReplied(l)).length,
    sent: (leads ?? []).filter(l => !l.archived && l.has_sent).length,
    archived: (leads ?? []).filter(l => l.archived).length,
  }

  const filtered = (leads ?? []).filter(l => {
    const matchLabel = activeLabel === null || l.client_label === activeLabel
    const q = search.toLowerCase()
    return inView(l) && matchLabel && (!q || fullName(l).toLowerCase().includes(q) || (l.company_name ?? '').toLowerCase().includes(q) || (l.email ?? '').toLowerCase().includes(q))
  })

  const labelMeta = (name: string | null) => customLabels.find(c => c.name === name)

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[#f7f8fc]" style={{ fontFamily: 'var(--font-inter), system-ui, sans-serif' }}>
      {/* Welcome splash — full-screen brand blue on every load, auto-dismisses */}
      {showWelcome && (
        <button
          onClick={() => setShowWelcome(false)}
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#224388] text-white cursor-default animate-out fade-out duration-700 [animation-delay:3.2s] [animation-fill-mode:forwards]">
          <span className="mb-6 [&_img]:h-12 [&_img]:w-auto [&_img]:brightness-0 [&_img]:invert animate-in fade-in zoom-in-95 duration-500"><Logo onDark /></span>
          <p className="text-white/60 text-sm tracking-wide uppercase animate-in fade-in slide-in-from-bottom-2 duration-700">Welcome back</p>
          <h1 className="font-heading text-5xl sm:text-6xl font-semibold tracking-tight mt-2 animate-in fade-in slide-in-from-bottom-3 duration-700">{greetingName}</h1>
        </button>
      )}
      {/* Top bar */}
      <header className="h-14 bg-[#224388] flex items-center px-3 md:px-5 shrink-0 gap-2 md:gap-3">
        <button onClick={() => setShowSidebar(true)} className="md:hidden text-white/80 hover:text-white p-1 -ml-1" aria-label="Menu">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <span className="flex items-center [&_img]:brightness-0 [&_img]:invert"><Logo onDark /></span>
        <span className="hidden sm:inline text-white/30">|</span>
        {workspaces.length > 1 ? (
          <select
            value={activeWorkspaceId}
            onChange={(e) => switchWorkspace(e.target.value)}
            title="Switch workspace"
            className="hidden sm:inline-block bg-white/10 text-white text-sm font-medium rounded-md px-2 py-1 border border-white/20 max-w-[180px] cursor-pointer focus:outline-none"
          >
            {workspaces.map((w) => (
              <option key={w.workspaceId} value={w.workspaceId} className="text-black">{w.companyName}</option>
            ))}
          </select>
        ) : (
          <span className="hidden sm:inline text-white/90 text-sm font-medium truncate max-w-[140px]">{companyName}</span>
        )}
        <nav className="hidden md:flex items-center gap-1 ml-4">
          <span className="px-3 py-1.5 text-white bg-white/15 text-sm font-medium rounded-lg inline-flex items-center gap-1.5">
            Leads
            {viewCounts.unread > 0 && <span className="min-w-[18px] text-center text-[11px] font-semibold px-1.5 py-0.5 rounded-full bg-[#ffb700] text-[#050c29]">{viewCounts.unread}</span>}
          </span>
          <a href="/invoices" className="px-3 py-1.5 text-white/70 hover:text-white text-sm rounded-lg">Billing</a>
          <a href="/account" className="px-3 py-1.5 text-white/70 hover:text-white text-sm rounded-lg">Account</a>
        </nav>
        <div className="ml-auto flex items-center gap-2 md:gap-4">
          {!payPerLead && balance && (
            balance.balance <= 0 ? (
              // Out of leads → red "Top Up Now"
              <a href="/invoices" className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500 text-white text-sm font-semibold hover:bg-red-600 shadow-sm animate-pulse">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                Top Up Now
              </a>
            ) : balance.balance <= balance.lowThreshold ? (
              // Running low → brand yellow warning
              <a href="/invoices" className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#ffb700] text-[#050c29] text-sm font-semibold hover:brightness-95">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Low on leads · {balance.balance} left
              </a>
            ) : (
              <a href="/invoices" className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20">
                <span className="text-xs text-white/70">Leads left</span>
                <span className="text-sm font-semibold text-white">{balance.balance.toLocaleString()}</span>
              </a>
            )
          )}
          <button onClick={handleLogout} className="hidden md:block text-white/70 hover:text-white text-sm">Sign out</button>
        </div>
      </header>

      <WarmupBar />

      {hasUnpaidInvoice && !invoiceBannerDismissed && (
        <div className="flex items-center gap-3 px-4 md:px-5 py-2 bg-red-50 border-b border-red-200 text-red-800 text-sm shrink-0">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span className="flex-1">You have an unpaid invoice — <a href="/invoices" className="font-semibold underline hover:no-underline">view</a></span>
          <button onClick={() => setInvoiceBannerDismissed(true)} aria-label="Dismiss" className="text-red-400 hover:text-red-700 shrink-0">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative">
        {/* Mobile backdrop for the sidebar drawer */}
        {showSidebar && <div className="md:hidden fixed inset-0 top-14 bg-black/30 z-30" onClick={() => setShowSidebar(false)} />}
        {/* Column 1 — sidebar (drawer on mobile) */}
        <aside className={`${showSidebar ? 'flex' : 'hidden'} md:flex fixed md:static top-14 md:top-auto bottom-0 left-0 z-40 w-64 md:w-56 bg-white border-r border-gray-200 flex-col shrink-0 shadow-xl md:shadow-none`}>
          <div className="p-3 space-y-0.5">
            {([
              { key: 'inbox', label: 'All leads', icon: <path d="M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/> },
              { key: 'unread', label: 'Needs reply', icon: <><path d="M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><circle cx="18" cy="6" r="3" fill="currentColor" stroke="none"/></> },
              { key: 'sent', label: 'Sent', icon: <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/> },
              { key: 'archived', label: 'Archived', icon: <><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/></> },
            ] as { key: 'inbox'|'unread'|'sent'|'archived'; label: string; icon: ReactNode }[]).map(v => (
              <button key={v.key}
                onClick={() => { setView(v.key); setShowSidebar(false) }}
                onDragOver={v.key === 'inbox' ? e => { if (dragLeadId) { e.preventDefault(); setDragOver('__inbox') } } : undefined}
                onDragLeave={v.key === 'inbox' ? () => setDragOver(d => d === '__inbox' ? null : d) : undefined}
                onDrop={v.key === 'archived' ? e => { e.preventDefault(); if (dragLeadId) { const l=(leads??[]).find(x=>x.id===dragLeadId); if(l) toggleArchive({...l, archived:false}); setDragLeadId(null); setDragOver(null) } } : v.key === 'inbox' ? e => { e.preventDefault(); dropOnStage(null) } : undefined}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium ${dragOver === '__inbox' && v.key==='inbox' ? 'ring-2 ring-brand-400 bg-brand-50' : view === v.key ? 'bg-brand-50 text-brand-700' : 'text-gray-700 hover:bg-gray-50'}`}>
                <span className="flex items-center gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{v.icon}</svg>
                  {v.label}
                </span>
                {v.key === 'unread'
                  ? (viewCounts.unread > 0 && <span className="min-w-[18px] text-center text-[11px] font-semibold px-1.5 py-0.5 rounded-full bg-[#ffb700] text-[#050c29]">{viewCounts.unread}</span>)
                  : <span className="text-xs text-gray-400">{viewCounts[v.key]}</span>}
              </button>
            ))}
          </div>
          <div className="px-3 flex items-center justify-between">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Deal stages</span>
            <button onClick={() => setShowNewLabel(true)} title="Add a deal stage" className="text-gray-400 hover:text-brand-600 text-lg leading-none px-1 -my-1">+</button>
          </div>
          <div className="px-3 mt-1 flex-1 overflow-y-auto">
            {clientStages.map(cl => (
              <div key={cl.id}
                // Whole row is draggable to REORDER stages. (Leads are dragged
                // separately via dragLeadId; we branch on which drag is active.)
                draggable
                onDragStart={() => setDragStageId(cl.id)}
                onDragEnd={() => { setDragStageId(null); setStageDropTarget(null) }}
                onClick={() => setActiveLabel(activeLabel === cl.name ? null : cl.name)}
                onDragOver={e => {
                  if (dragLeadId) { e.preventDefault(); setDragOver(cl.id) }
                  else if (dragStageId && dragStageId !== cl.id) { e.preventDefault(); setStageDropTarget(cl.id) }
                }}
                onDragLeave={() => { setDragOver(d => d === cl.id ? null : d); setStageDropTarget(t => t === cl.id ? null : t) }}
                onDrop={e => {
                  e.preventDefault()
                  if (dragLeadId) dropOnStage(cl.name)
                  else if (dragStageId) { reorderStages(dragStageId, cl.id); setDragStageId(null); setStageDropTarget(null) }
                }}
                className={`group flex items-center justify-between px-3 py-1.5 rounded-lg text-sm cursor-pointer ${dragOver === cl.id ? 'ring-2 ring-brand-400 bg-brand-50' : stageDropTarget === cl.id ? 'ring-2 ring-brand-300 border-t-2 border-brand-400' : activeLabel === cl.name ? 'bg-gray-100' : 'hover:bg-gray-50'} ${dragStageId === cl.id ? 'opacity-40' : ''}`}>
                <span className="flex items-center gap-2 text-gray-700 min-w-0">
                  <span title="Drag to reorder" className="shrink-0 cursor-grab"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-300"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg></span>
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${COLOR_MAP[cl.color] ?? 'bg-purple-400'}`} /><span className="truncate">{cl.name}</span>
                </span>
                <span className="flex items-center gap-1.5 shrink-0">
                  <span className="text-xs text-gray-400">{counts[cl.name] ?? 0}</span>
                  <button onClick={e => { e.stopPropagation(); deleteStage(cl.id, cl.name) }} title="Delete stage" className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-opacity">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </span>
              </div>
            ))}
          </div>
          {/* Mobile-only nav (desktop has these in the top bar) */}
          <div className="md:hidden border-t border-gray-100 p-3 space-y-0.5">
            <a href="/invoices" className="block px-3 py-2 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50">Billing</a>
            <a href="/account" className="block px-3 py-2 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50">Account</a>
            <button onClick={handleLogout} className="block w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-50">Sign out</button>
          </div>
        </aside>

        {/* Column 2 — lead list (full width on mobile; hidden once a lead is open) */}
        <section className={`${selected ? 'hidden md:flex' : 'flex'} w-full md:w-[380px] bg-white border-r border-gray-200 flex-col shrink-0`}>
          <div className="px-4 py-3 border-b border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-[#050c29]">Your Leads <span className="text-gray-400 font-normal">({filtered.length})</span></h2>
              {/* Download all visible (unlocked) leads as a CSV the client can open
                  in Excel/Google Sheets — replaces the "save as spreadsheet" they
                  had in their old system. */}
              <button
                onClick={() => downloadLeadsCsv(leads ?? [], companyName)}
                disabled={!leads || leads.filter(l => !l.locked).length === 0}
                title="Download your leads as a CSV spreadsheet"
                className="flex items-center gap-1.5 text-xs font-medium text-[#224388] hover:text-[#050c29] disabled:opacity-40"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Download
              </button>
            </div>
            <div className="relative">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-2.5 top-2.5 text-gray-400"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input placeholder="Search leads" value={search} onChange={e => setSearch(e.target.value)} className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-gray-200 text-sm outline-none focus:border-brand-300 bg-gray-50" />
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
                  className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${dragLeadId === l.id ? 'opacity-50' : ''} ${selected?.id === l.id ? 'bg-brand-50/60' : ''}`}>
                  <div className="flex gap-3">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${l.locked ? 'bg-[#fff4d6] text-[#b8860b]' : av(l.id)}`}>
                      {l.locked ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> : initials(l)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-sm truncate ${l.has_unread ? 'font-bold text-[#050c29]' : 'font-medium text-gray-800'}`}>{l.locked ? `New lead${l.first_name ? ` from ${l.first_name}` : ''}` : fullName(l)}</span>
                        <span className="text-[11px] text-gray-400 shrink-0">{fmtDate(l.last_reply_at ?? l.first_replied_at ?? l.created_at)}</span>
                      </div>
                      {l.locked
                        ? <p className="text-xs text-[#b8860b] font-medium truncate">🔒 Top up to unlock</p>
                        : <p className="text-xs text-gray-500 truncate">{l.company_name ?? l.email}</p>}
                      {(cl || l.dispute_status === 'pending' || isReplied(l) || l.is_info) && !l.locked && (
                        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        {l.is_info && <span className="inline-flex text-[10px] font-medium bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded" title="Shared for info — not charged as a lead">Info · not billed</span>}
                        {cl && <span className={`inline-flex text-[10px] font-medium px-1.5 py-0.5 rounded ${COLOR_BADGE[cl.color] ?? 'bg-purple-100 text-purple-700'}`}>{cl.name}</span>}
                        {isReplied(l) && <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-green-100 text-green-700 px-1.5 py-0.5 rounded"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>Replied</span>}
                        {l.dispute_status === 'pending' && <span className="inline-flex text-[10px] font-medium bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Dispute</span>}
                      </div>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        {/* Column 3 — thread (full screen on mobile when a lead is open) */}
        <section className={`${selected ? 'flex' : 'hidden md:flex'} flex-1 flex-col min-w-0 bg-white`}>
          {!selected ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 text-gray-300"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>
              <p className="text-sm">Select a lead to read</p>
            </div>
          ) : selected.locked ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-8 bg-[#fafbfd] relative">
              <button onClick={() => { setSelected(null); setThread(null) }} className="md:hidden absolute top-3 left-3 text-gray-500 hover:text-gray-800 p-1" aria-label="Back to leads">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <div className="w-16 h-16 rounded-full bg-[#fff4d6] text-[#b8860b] flex items-center justify-center mb-5">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              </div>
              <h2 className="font-heading text-xl font-semibold text-[#050c29] mb-1">A new lead is waiting{selected.first_name ? `, from ${selected.first_name}` : ''}</h2>
              <p className="text-sm text-gray-500 max-w-sm mb-6">You&apos;ve used all your leads, so this one is locked. Top up and once it&apos;s confirmed, the contact details and conversation unlock straight away.</p>
              <a href="/invoices" className="px-5 py-2.5 bg-[#ffb700] text-[#050c29] text-sm font-semibold rounded-lg hover:brightness-95 shadow-sm">Top up to unlock</a>
            </div>
          ) : (
            <>
              {/* thread header */}
              <div className="px-3 md:px-5 py-3 border-b border-gray-100 flex items-center gap-2 md:gap-3 shrink-0">
                <button onClick={() => { setSelected(null); setThread(null) }} className="md:hidden text-gray-500 hover:text-gray-800 p-1 -ml-1" aria-label="Back to leads">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${av(selected.id)}`}>{initials(selected)}</div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-heading text-base font-semibold text-[#050c29] truncate tracking-tight">{fullName(selected)}</p>
                    {selected.is_info && <span className="inline-flex text-[10px] font-medium bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded shrink-0" title="Shared for info — not charged as a lead">Info · not billed</span>}
                  </div>
                  {selected.email && <p className="text-xs text-gray-500 truncate">{selected.email}</p>}
                </div>
                {/* Replied off-dashboard: moves a new lead out of Unread */}
                {selected.has_sent || selected.has_outbound ? (
                  <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-green-600"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>Replied</span>
                ) : selected.replied_off ? (
                  <button onClick={() => toggleRepliedOff(selected)} title="Mark as not replied" className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-green-600 hover:text-gray-500"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>Replied off-dashboard</button>
                ) : (
                  <button onClick={() => toggleRepliedOff(selected)} title="I've replied to this lead outside the dashboard" className="ml-auto inline-flex items-center px-3.5 py-1.5 rounded-lg text-xs font-semibold text-white bg-[#1F6F78] hover:bg-[#195a61] shadow-sm">
                    Mark as replied
                  </button>
                )}
                <button onClick={() => downloadLeadCsv(selected)} title="Download this lead as a CSV" className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-50">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Download
                </button>
                <button onClick={() => toggleArchive(selected)} title={selected.archived ? 'Unarchive' : 'Archive'} className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-50">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/></svg>
                  {selected.archived ? 'Unarchive' : 'Archive'}
                </button>
                {/* deal-stage dropdown */}
                <div className="relative" ref={dropRef}>
                  <button onClick={() => setLabelDrop(v => !v)} className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50">
                    {selected.client_label ? <><span className={`w-2 h-2 rounded-full ${COLOR_MAP[labelMeta(selected.client_label)?.color ?? 'purple']}`} />{selected.client_label}</> : <span className="text-gray-500">Set stage</span>}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  {labelDrop && (
                    <div className="absolute right-0 top-full mt-1 w-52 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-20 max-h-72 overflow-y-auto">
                      <button onClick={() => setClientLabel(selected.id, null)} className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-500 hover:bg-gray-50">Not set</button>
                      {clientStages.map(cl => (
                        <button key={cl.id} onClick={() => setClientLabel(selected.id, cl.name)} className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                          <span className={`w-2.5 h-2.5 rounded-full ${COLOR_MAP[cl.color]}`} />{cl.name}
                          {selected.client_label === cl.name && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-auto text-brand-500"><polyline points="20 6 9 17 4 12"/></svg>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* Contact details toggle (drawer below lg) */}
                <button onClick={() => setShowDetails(true)} className="lg:hidden inline-flex items-center px-2 py-1.5 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50" aria-label="Lead details">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                </button>
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
                ) : [...thread].sort((a, b) => {
                  // Newest first. Sort on the actual timestamp (don't trust the
                  // API order); fall back to 0 for missing dates so they sink.
                  const ta = a.timestamp_created ? new Date(a.timestamp_created).getTime() : 0
                  const tb = b.timestamp_created ? new Date(b.timestamp_created).getTime() : 0
                  return tb - ta
                }).map(m => {
                  const out = m.direction === 'OUT'
                  // Prefer plain text; fall back to preview, then to HTML stripped
                  // to text (received mail often has only an HTML body).
                  const bodySource = (m.body_text && m.body_text.trim())
                    || (m.content_preview && m.content_preview.trim())
                    || (m.body_html ? htmlToText(m.body_html) : '')
                  const { main, quoted } = splitQuote(bodySource)
                  return (
                    <div key={m.id} className={`rounded-xl border overflow-hidden shadow-sm ${out ? 'border-brand-200' : 'border-gray-200'}`}>
                      {/* header strip — indigo = us, grey = the lead */}
                      <div className={`flex items-center gap-2.5 px-4 py-2.5 ${out ? 'bg-brand-50' : 'bg-gray-50'}`}>
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 ${out ? 'bg-brand-600 text-white' : av(selected.id)}`}>{out ? 'O' : initials(selected)}</div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-[#050c29] leading-tight truncate">{out ? (m.sent_via_portal ? `${companyName} (you)` : 'Ottaly') : fullName(selected)}</p>
                          <p className="text-[11px] text-gray-500 truncate">{out ? `to: ${selected.email}` : (m.from_email ?? selected.email)}</p>
                        </div>
                        <div className="ml-auto flex items-center gap-2 shrink-0">
                          {m.pv_label && m.pv_label !== 'INTERESTED' && <span className="text-[10px] bg-white border border-gray-200 text-gray-500 px-1.5 py-0.5 rounded capitalize">{m.pv_label.replace(/_/g,' ').toLowerCase()}</span>}
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${out ? 'bg-brand-100 text-brand-700' : 'bg-gray-200 text-gray-600'}`}>{out ? 'Sent' : 'Received'}</span>
                          <button onClick={() => handleForward(m)} title="Forward this email to someone else" className="flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-brand-600 border border-gray-200 hover:border-brand-300 rounded px-1.5 py-0.5">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>
                            Forward
                          </button>
                          <span className="text-[11px] text-gray-400 hidden sm:inline">{fmtFull(m.timestamp_created)}</span>
                        </div>
                      </div>
                      {/* body */}
                      <div className={`px-5 py-4 ${out ? 'bg-brand-50/40' : 'bg-white'}`}>
                        {m.subject && <p className="text-xs font-medium text-gray-500 mb-3">{m.subject}</p>}
                        {m.body_html_safe ? (
                          // Server-sanitized HTML — renders the lead's full signature
                          // (logos, photos, contact table) for inbound mail and our own
                          // composed HTML for outbound. Remote images in inbound mail are
                          // neutralized server-side (data-blocked-src) to stop trackers.
                          <div className="text-sm text-gray-800 break-words leading-[1.55] max-w-[68ch] [&_p]:my-2 [&_a]:text-brand-600 [&_a]:underline [&_img]:max-w-full [&_img]:rounded [&_table]:border-collapse [&_td]:align-top" dangerouslySetInnerHTML={{ __html: m.body_html_safe }} />
                        ) : (
                          // No HTML body — plain/derived text. Collapse runs of blank
                          // lines so it doesn't show huge gaps; readable column.
                          <div className="text-sm text-[#1a2332] whitespace-pre-wrap break-words leading-[1.55] max-w-[68ch]">{(main || '(no content)').replace(/\n{3,}/g, '\n\n').trim()}</div>
                        )}
                        {m.attachments && m.attachments.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-3">
                            {m.attachments.map((a, i) => {
                              const sizeLabel = a.size != null
                                ? (a.size > 1024 * 1024 ? `${(a.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`)
                                : null
                              const chipInner = (
                                <>
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                                  <span className="max-w-[200px] truncate">{a.filename}</span>
                                  {sizeLabel && <span className="text-gray-400">{sizeLabel}</span>}
                                </>
                              )
                              // Clickable when we have a stored id → opens an inline preview in a new tab.
                              return a.id ? (
                                <a key={`${a.filename}-${i}`} href={`/api/portal/attachments/${a.id}`} target="_blank" rel="noreferrer"
                                  title="Open attachment"
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-gray-200 rounded-lg text-xs text-gray-700 hover:border-brand-300 hover:text-brand-700 transition-colors">
                                  {chipInner}
                                </a>
                              ) : (
                                <span key={`${a.filename}-${i}`} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-gray-200 rounded-lg text-xs text-gray-700">
                                  {chipInner}
                                </span>
                              )
                            })}
                          </div>
                        )}
                        {quoted && !m.sent_via_portal && !m.body_html_safe && (
                          <details className="mt-3 border-t border-dashed border-gray-200 pt-2">
                            <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 select-none flex items-center gap-1.5 w-fit">
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
                              Show earlier email (our outreach)
                            </summary>
                            <div className="mt-2 pl-3 border-l-2 border-gray-200 text-xs text-gray-400 whitespace-pre-wrap break-words">{quoted}</div>
                          </details>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* reply composer — Gmail-style rich editor */}
              <div className="border-t border-gray-100 px-4 py-3 shrink-0">
                <RichReply
                  key={selected.id}
                  toEmail={selected.email ?? ''}
                  ccEmail={clientEmail}
                  placeholderName={selected.first_name ?? fullName(selected).split(' ')[0]}
                  sending={replying}
                  statusMsg={replyMsg}
                  seed={forwardSeed}
                  onSend={handleReply}
                />
              </div>
            </>
          )}
        </section>

        {/* Mobile/tablet backdrop for the details drawer */}
        {showDetails && selected && !selected.locked && <div className="lg:hidden fixed inset-0 top-14 bg-black/30 z-30" onClick={() => setShowDetails(false)} />}
        {/* Column 4 — lead details (inline at lg+, drawer below; hidden while locked) */}
        {selected && !selected.locked && (
          <aside className={`${showDetails ? 'flex' : 'hidden'} lg:flex fixed lg:static top-14 lg:top-auto bottom-0 right-0 z-40 w-80 lg:w-72 bg-white border-l border-gray-200 flex-col shrink-0 overflow-y-auto shadow-xl lg:shadow-none`}>
            <button onClick={() => setShowDetails(false)} className="lg:hidden absolute top-3 right-3 text-gray-400 hover:text-gray-700 p-1" aria-label="Close details">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <div className="p-5 text-center border-b border-gray-100">
              <div className={`w-16 h-16 rounded-full mx-auto flex items-center justify-center text-lg font-semibold mb-2 ${av(selected.id)}`}>{initials(selected)}</div>
              <p className="text-sm font-semibold text-[#050c29]">{fullName(selected)}</p>
              {selected.job_title && <p className="text-xs text-gray-500 mt-0.5">{selected.job_title}</p>}
              {selected.company_name && <p className="text-xs text-brand-600 mt-0.5">{selected.company_name}</p>}
            </div>


            <Section title="Status">
              {selected.client_label && <span className={`inline-flex ml-1.5 text-xs font-medium px-2 py-1 rounded-full ${COLOR_BADGE[labelMeta(selected.client_label)?.color ?? 'purple'] ?? 'bg-purple-100 text-purple-700'}`}>{selected.client_label}</span>}
            </Section>

            {(selected.email || selected.mobile_phone || selected.office_phone || selected.phone_number || selected.linkedin_url) && (
              <Section title="Contact">
                {selected.email && <Row icon="mail" label={selected.email} />}
                {/* Mobile and office shown separately + labelled. Fall back to the
                    legacy single phone_number as a mobile when the split isn't set. */}
                {(selected.mobile_phone || selected.phone_number) && <Row icon="phone" label={`Mobile: ${selected.mobile_phone ?? selected.phone_number}`} />}
                {selected.office_phone && <Row icon="phone" label={`Office: ${selected.office_phone}`} />}
                {selected.linkedin_url && <Row icon="link" label="LinkedIn profile" href={selected.linkedin_url} />}
              </Section>
            )}

            {(selected.company_name || selected.industry || selected.city || selected.company_website || selected.department || selected.address_line || selected.job_title) && (
              <Section title="Company & role">
                {selected.company_name && <Row icon="building" label={selected.company_name} />}
                {selected.company_website && <Row icon="globe" label={selected.company_website.replace(/^https?:\/\//,'')} href={selected.company_website} />}
                {selected.job_title && <Row icon="badge" label={selected.job_title} />}
                {selected.department && <Row icon="badge" label={selected.department} />}
                {selected.industry && <Row icon="tag" label={selected.industry} />}
                {selected.address_line && <Row icon="pin" label={selected.address_line} />}
                {(selected.city || selected.state || selected.country) && <Row icon="pin" label={[selected.city, selected.state, selected.country].filter(Boolean).join(', ')} />}
                {selected.linkedin_company_url && <Row icon="link" label="Company LinkedIn" href={selected.linkedin_company_url} />}
              </Section>
            )}

            {Array.isArray(selected.custom_fields) && selected.custom_fields.some(c => c?.label && c?.value) && (
              <Section title="More details">
                {selected.custom_fields.filter(c => c?.label && c?.value).map((c, i) => (
                  <div key={`cf-${i}`} className="flex items-start gap-2 mb-1.5">
                    <span className="text-[10px] uppercase tracking-wide text-gray-400 shrink-0 mt-0.5 min-w-[80px]">{c.label}</span>
                    <span className="text-sm text-gray-700 break-words">{c.value}</span>
                  </div>
                ))}
              </Section>
            )}

            {/* Your notes — private to the client, persisted on blur */}
            <Section title="Your notes">
              <textarea
                value={notes}
                onChange={e => { setNotes(e.target.value); setNotesSavedAt(null) }}
                onBlur={saveNotes}
                rows={4}
                placeholder="Add private notes about this lead…"
                className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-brand-400 resize-y leading-[1.5] text-gray-800"
              />
              <p className="text-[11px] text-gray-400 mt-1 h-4">
                {notesSaving ? 'Saving…' : notesSavedAt ? 'Saved' : 'Notes save when you click away'}
              </p>
            </Section>

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
          <select value={disputeCategory} onChange={e => setDisputeCategory(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-brand-400 bg-white mb-3">
            <option value="">Choose a reason…</option>
            {(disputeType === 'icp_mismatch' ? ICP_CATEGORIES : NONLEAD_CATEGORIES).map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          <div className="flex items-baseline justify-between mb-1">
            <label className="block text-xs text-gray-500">Details <span className="text-gray-400">(at least 10 characters)</span></label>
            <span className={`text-[11px] font-medium ${disputeReason.trim().length < 10 ? 'text-[#ea6b25]' : 'text-green-600'}`}>{Math.min(disputeReason.trim().length, 10)}/10</span>
          </div>
          <textarea rows={3} value={disputeReason} onChange={e => setDisputeReason(e.target.value)}
            placeholder={disputeType === 'icp_mismatch' ? 'e.g. They’re a sole trader; we only serve 50+ staff companies.' : 'e.g. Replied twice over 2 weeks, sent a follow-up, no response at all.'}
            className={`w-full px-3 py-2 rounded-lg border text-sm outline-none mb-1 ${disputeReason.length > 0 && disputeReason.trim().length < 10 ? 'border-[#ea6b25] focus:border-[#ea6b25]' : 'border-gray-200 focus:border-brand-400'}`} />
          <p className="text-[11px] text-gray-400 mb-3">{disputeReason.trim().length < 10 ? `Please add ${10 - disputeReason.trim().length} more character${10 - disputeReason.trim().length === 1 ? '' : 's'} so we can review this properly.` : 'Looks good — ready to submit.'}</p>

          {disputeType === 'non_lead' && (
            <label className="flex items-start gap-2 mb-3 cursor-pointer">
              <input type="checkbox" checked={disputeAck} onChange={e => setDisputeAck(e.target.checked)} className="mt-0.5" />
              <span className="text-xs text-gray-600">I&apos;ve replied to this lead and genuinely followed up.</span>
            </label>
          )}

          {disputeError && <p className="text-xs text-red-600 mb-3">{disputeError}</p>}

          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowDispute(false)} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
            <button onClick={handleDisputeSubmit} disabled={disputeSaving || !disputeCategory || disputeReason.trim().length < 10 || (disputeType === 'non_lead' && !disputeAck)} className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg disabled:opacity-50">{disputeSaving ? 'Submitting…' : 'Submit for review'}</button>
          </div>
        </Modal>
      )}

      {/* new label modal */}
      {showNewLabel && (
        <Modal onClose={() => setShowNewLabel(false)} title="Create deal stage">
          <input value={newLabelName} onChange={e => setNewLabelName(e.target.value)} placeholder="e.g. Meeting Booked, Quote Sent, Won" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-brand-400 mb-3" />
          <div className="flex gap-2 mb-4">
            {CUSTOM_COLORS.map(c => <button key={c} onClick={() => setNewLabelColor(c)} className={`w-7 h-7 rounded-full ${COLOR_MAP[c]} ${newLabelColor === c ? 'ring-2 ring-offset-2 ring-gray-400' : ''}`} />)}
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowNewLabel(false)} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
            <button onClick={handleCreateLabel} disabled={!newLabelName.trim()} className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg disabled:opacity-50">Create</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// Gmail-style recipient field: each address becomes a chip on space/comma/enter.
function RecipientInput({ value, onChange, placeholder }: {
  value: string[]; onChange: (v: string[]) => void; placeholder: string
}) {
  const [draft, setDraft] = useState('')
  const isValid = (a: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)
  function commit(s: string) {
    const parts = s.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean)
    if (parts.length) onChange([...value, ...parts])
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === ' ') && draft.trim()) {
      e.preventDefault(); commit(draft); setDraft('')
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1))
    }
  }
  return (
    <div className="flex-1 flex flex-wrap items-center gap-1">
      {value.map((a, i) => (
        <span key={i} className={`inline-flex items-center gap-1 text-xs pl-2 pr-1 py-0.5 rounded-full ${isValid(a) ? 'bg-brand-50 text-brand-700' : 'bg-red-50 text-red-600'}`} title={isValid(a) ? '' : 'This doesn’t look like a valid email'}>
          {a}
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-black/10">×</button>
        </span>
      ))}
      <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown}
        onBlur={() => { if (draft.trim()) { commit(draft); setDraft('') } }}
        placeholder={value.length ? '' : placeholder}
        className="flex-1 min-w-[120px] text-sm outline-none bg-transparent text-gray-800 placeholder:text-gray-400 py-1" />
    </div>
  )
}

// Gmail-style rich text reply: editable To, Cc, bold/italic/underline, font,
// size, link, image — and a forward seed that prefills quoted content.
function RichReply({ toEmail, ccEmail = '', placeholderName, sending, statusMsg, seed, onSend }: {
  toEmail: string; ccEmail?: string; placeholderName: string; sending: boolean; statusMsg: string
  seed: { id: number; html: string } | null
  onSend: (text: string, html: string, to: string, cc: string, files: File[]) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const attachRef = useRef<HTMLInputElement>(null)
  const appliedSeedId = useRef<number | null>(null)
  const [attachedFiles, setAttachedFiles] = useState<File[]>([])
  const [empty, setEmpty] = useState(true)
  const [chars, setChars] = useState(0)
  const [to, setTo] = useState<string[]>(toEmail ? [toEmail] : [])
  // Pre-fill Cc with the client's own profile email so they get a copy — shown openly
  // in the Cc field so they can remove it if they don't want it (not hidden/forced).
  const [showCc, setShowCc] = useState(!!ccEmail)
  const [cc, setCc] = useState<string[]>(ccEmail ? [ccEmail] : [])
  // Collapsed by default — a slim bar that reclaims reading space. Clicking it
  // (or a forward seed arriving) expands the full composer and focuses it.
  const [expanded, setExpanded] = useState(false)
  function expand() {
    setExpanded(true)
    setTimeout(() => ref.current?.focus(), 0)
  }

  // Forward seed, step 1: when a forward arrives, EXPAND the composer and clear
  // the recipient. The editor only mounts when expanded, so we can't touch
  // ref.current here — that happens in step 2 once it's in the DOM.
  useEffect(() => {
    if (!seed) return
    setExpanded(true)
    setTo([])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.id])

  // Forward seed, step 2: once the editor is mounted (expanded === true),
  // prefill it with the quoted content — exactly once per seed, so a later
  // collapse/expand can't wipe what the client has typed.
  useEffect(() => {
    if (seed && expanded && ref.current && appliedSeedId.current !== seed.id) {
      appliedSeedId.current = seed.id
      ref.current.innerHTML = seed.html
      syncState()
      ref.current.focus()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.id, expanded])

  function syncState() {
    // Drop zero-width spaces seeded for empty-editor list commands so they don't
    // count as content or pad the character counter.
    const t = (ref.current?.innerText ?? '').replace(/​/g, '').trim()
    setEmpty(t.length === 0)
    setChars(t.length)
  }
  function exec(cmd: string, value?: string) {
    const el = ref.current
    if (!el) return
    // List/format commands act on the current selection INSIDE the editable, so
    // it must be focused with a real range that lives in the box. Focus first.
    el.focus()
    // An empty contentEditable has no block for insertUnorderedList /
    // insertOrderedList to wrap, so they silently no-op. Seed a zero-width text
    // node so there's a text node (and an implicit block) for the command to act
    // on; the ZWSP is invisible and trimmed out of the sent text by syncState.
    if (el.textContent === '') {
      el.appendChild(document.createTextNode('​'))
    }
    // Ensure the selection is actually inside the editor before running the
    // command — if the user clicked a toolbar button without clicking into the
    // box first, drop the caret at the end of the content.
    const sel = window.getSelection()
    const inEditor = sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)
    if (!inEditor) {
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    document.execCommand(cmd, false, value)
    syncState()
  }
  // Insert a list reliably WITHOUT execCommand (the insertUnorderedList/
  // insertOrderedList commands are deprecated and silently no-op in several
  // browsers). We build the <ul>/<ol> ourselves at the caret: if the user has
  // selected text, each line becomes an <li>; otherwise we drop an empty <li>
  // and place the caret inside it so they can start typing.
  function insertList(ordered: boolean) {
    const el = ref.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    let range: Range
    if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0)
    } else {
      range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
    }
    const list = document.createElement(ordered ? 'ol' : 'ul')
    list.style.paddingLeft = '1.4em'
    list.style.margin = '0.25em 0'
    list.style.listStyleType = ordered ? 'decimal' : 'disc'

    const selectedText = range.toString()
    if (selectedText.trim()) {
      for (const line of selectedText.split('\n')) {
        const li = document.createElement('li')
        li.textContent = line || '​'
        list.appendChild(li)
      }
      range.deleteContents()
      range.insertNode(list)
    } else {
      const li = document.createElement('li')
      li.appendChild(document.createElement('br'))
      list.appendChild(li)
      range.insertNode(list)
      // Caret into the empty <li>.
      const caret = document.createRange()
      caret.setStart(li, 0)
      caret.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(caret)
    }
    syncState()
  }
  function onInput() { syncState() }
  function addLink() {
    const url = prompt('Link URL (https://…)')
    if (url) exec('createLink', url)
  }
  function onPickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => { exec('insertImage', String(reader.result)) }
    reader.readAsDataURL(file)
    e.target.value = ''
  }
  function onPickAttachment(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    if (!picked.length) return

    const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25MB
    const oversized = picked.filter(f => f.size > MAX_FILE_SIZE)
    if (oversized.length > 0) {
      const names = oversized.map(f => f.name).join(', ')
      alert(`File too large: ${names}\n\nLimit: 25MB per file`)
      e.target.value = ''
      return
    }

    setAttachedFiles(prev => [...prev, ...picked])
    e.target.value = ''
  }
  function removeAttachment(name: string) {
    setAttachedFiles(prev => prev.filter(f => f.name !== name))
  }

  function send() {
    const el = ref.current
    if (!el) return
    const text = el.innerText.replace(/​/g, '').trim()
    if (!text || !to.length) return
    onSend(text, el.innerHTML, to.join(', '), cc.join(', '), attachedFiles)
    el.innerHTML = ''
    setEmpty(true); setChars(0); setCc(ccEmail ? [ccEmail] : []); setShowCc(!!ccEmail); setTo(toEmail ? [toEmail] : []); setExpanded(false); setAttachedFiles([])
  }

  const Btn = ({ cmd, val, title, children }: { cmd?: string; val?: string; title: string; children: ReactNode }) => (
    <button type="button" title={title}
      onMouseDown={e => { e.preventDefault(); if (cmd) exec(cmd, val) }}
      className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-600 text-[15px]">
      {children}
    </button>
  )

  // Collapsed: a slim click-to-expand bar, so reading gets the space.
  if (!expanded) {
    return (
      <button type="button" onClick={expand}
        className="w-full flex items-center gap-3 rounded-xl border border-gray-200 shadow-sm bg-white px-4 py-3 text-left hover:border-brand-300 hover:bg-gray-50/60 transition-colors">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-brand-600 shrink-0"><path d="M3 21l1.9-5.7a8.5 8.5 0 1 1 3.8 3.8z"/></svg>
        <span className="text-sm text-gray-500 flex-1">Reply to {placeholderName}…</span>
        <span className="text-xs font-medium text-brand-600">Write reply →</span>
      </button>
    )
  }

  return (
    <div className="rounded-xl border border-gray-200 shadow-sm bg-white overflow-hidden focus-within:border-brand-300 focus-within:ring-1 focus-within:ring-brand-200">
      {/* To row — label doubles as the "Reply message" header, collapse button on right */}
      <div className="px-3 py-1.5 border-b border-gray-100 flex items-center gap-2">
        <span className="text-xs font-medium text-gray-500 w-7 shrink-0">To:</span>
        <RecipientInput value={to} onChange={setTo} placeholder="add recipients…" />
        {!showCc && <button type="button" onClick={() => setShowCc(true)} className="text-xs font-medium text-brand-600 hover:text-brand-800 shrink-0">Cc</button>}
        <button type="button" onClick={() => setExpanded(false)} title="Collapse" className="text-gray-400 hover:text-gray-600 text-sm leading-none shrink-0 ml-1">▾</button>
      </div>
      {showCc && (
        <div className="px-3 py-1.5 border-b border-gray-100 flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500 w-7 shrink-0">Cc:</span>
          <RecipientInput value={cc} onChange={setCc} placeholder="add cc…" />
        </div>
      )}

      {/* toolbar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-100 bg-gray-50/60 flex-wrap">
        <select onMouseDown={e => e.stopPropagation()} onChange={e => exec('fontName', e.target.value)} defaultValue="" title="Font"
          className="h-8 text-xs border border-gray-200 rounded-md px-2 mr-1 outline-none bg-white text-gray-600">
          <option value="" disabled>Font</option>
          <option value="Arial">Sans</option>
          <option value="Georgia">Serif</option>
          <option value="Courier New">Mono</option>
        </select>
        <select onMouseDown={e => e.stopPropagation()} onChange={e => exec('fontSize', e.target.value)} defaultValue="" title="Size"
          className="h-8 text-xs border border-gray-200 rounded-md px-2 mr-1 outline-none bg-white text-gray-600">
          <option value="" disabled>Size</option>
          <option value="2">Small</option>
          <option value="3">Normal</option>
          <option value="5">Large</option>
          <option value="6">Huge</option>
        </select>
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <Btn cmd="bold" title="Bold"><strong>B</strong></Btn>
        <Btn cmd="italic" title="Italic"><em>I</em></Btn>
        <Btn cmd="underline" title="Underline"><u>U</u></Btn>
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <button type="button" title="Bulleted list" onMouseDown={e => { e.preventDefault(); insertList(false) }} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-600 text-[15px]">•</button>
        <button type="button" title="Numbered list" onMouseDown={e => { e.preventDefault(); insertList(true) }} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-600"><span className="text-xs font-semibold">1.</span></button>
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <button type="button" title="Add link" onMouseDown={e => { e.preventDefault(); addLink() }} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-600">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </button>
        <button type="button" title="Add image" onMouseDown={e => { e.preventDefault(); fileRef.current?.click() }} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-600">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
        </button>
        <button type="button" title="Attach file" onMouseDown={e => { e.preventDefault(); attachRef.current?.click() }} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-600">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <input ref={fileRef} type="file" accept="image/*" onChange={onPickImage} className="hidden" />
        <input ref={attachRef} type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.png,.jpg,.jpeg,.gif,.webp,.mp4,.mp3" onChange={onPickAttachment} className="hidden" />
      </div>

      {/* editable area — larger, roomier like PV. Cap height to a fraction of the
          viewport (not a fixed 380px) so on short windows the editor scrolls INTERNALLY
          and the footer/Send button below is always visible (long emails were pushing
          Send off-screen). */}
      <div className="relative">
        {empty && <span className="pointer-events-none absolute left-4 top-3 text-sm text-gray-400">Write your reply to {placeholderName}…</span>}
        <div ref={ref} contentEditable suppressContentEditableWarning onInput={onInput}
          className="min-h-[140px] max-h-[clamp(140px,32vh,380px)] overflow-y-auto px-4 py-3 text-sm leading-[1.55] text-gray-800 outline-none [&_a]:text-brand-600 [&_a]:underline [&_img]:max-w-full [&_img]:rounded" />
      </div>

      {/* attachment chips */}
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 py-2 border-t border-gray-100 bg-gray-50/40">
          {attachedFiles.map(f => (
            <span key={f.name} className="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-gray-200 rounded-full text-xs text-gray-700">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              {f.name}
              <button type="button" onClick={() => removeAttachment(f.name)} className="ml-0.5 text-gray-400 hover:text-red-500">×</button>
            </span>
          ))}
        </div>
      )}

      {/* footer */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-t border-gray-100">
        <div className="flex items-center gap-3">
          <button onClick={send} disabled={empty || sending || !to.length} className="inline-flex items-center gap-1.5 px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white disabled:bg-gray-300 disabled:text-gray-500 text-sm font-semibold rounded-lg">
            {sending ? 'Sending…' : <><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>Send</>}
          </button>
          <span className="text-xs">{statusMsg ? <span className="text-green-600 font-medium">{statusMsg}</span> : <span className="text-gray-400">{attachedFiles.length > 0 ? `${attachedFiles.length} file${attachedFiles.length === 1 ? '' : 's'} attached` : 'Sent via your campaign mailbox'}</span>}</span>
        </div>
        <span className="text-xs text-gray-400">{chars > 0 ? `${chars} character${chars === 1 ? '' : 's'}` : ''}</span>
      </div>
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
      {href ? <a href={href} target="_blank" rel="noreferrer" className="text-sm text-brand-600 hover:underline break-words">{label}</a> : inner}
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
        <h3 className="text-base font-semibold text-[#050c29] mb-3">{title}</h3>
        {children}
      </div>
    </div>
  )
}
