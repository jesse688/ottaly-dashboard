'use client'

import { useEffect, useState, useCallback, useRef } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Workspace {
  _id?: string
  id?: string
  workspace_id?: string
  name?: string
  workspace_name?: string
}

interface CopyTemplate {
  content_hash: string
  subject: string | null
  body_excerpt: string | null
  body: string | null
  campaigns: string[] | null
  campaign_statuses: string[] | null
  min_step: number | null
  max_step: number | null
  is_active: boolean
  first_seen: string | null
  sent: number
  replies: number
  leads: number
  bounces: number
  sent_7d: number
  replies_7d: number
  leads_7d: number
  bounces_7d: number
  last_positive_at: string | null
}

interface CopySubject {
  subject_hash: string
  subject: string | null
  template_count: number
  campaign_count: number
  sent: number
  replies: number
  leads: number
  bounces: number
  sent_7d: number
  replies_7d: number
  leads_7d: number
  bounces_7d: number
  campaign_statuses: string[] | null
  is_active: boolean
}

interface CopyStep {
  step: number
  sent: number
  replies: number
  leads: number
  bounces: number
}

interface StaleTemplate {
  content_hash: string
  subject: string | null
  body_excerpt: string | null
  campaigns: string[] | null
  step: number | null
  first_seen: string | null
  total_signal: number
  signal_14d: number
  last_signal_at: string | null
}

interface CopyTotals {
  total_sent: number
  total_replies: number
  total_leads: number
  total_bounces: number
  window_days: number
}

interface CopyAnalyticsData {
  templates: CopyTemplate[]
  subjects: CopySubject[]
  by_step: CopyStep[]
  stale: StaleTemplate[]
  totals: CopyTotals
}

interface DiagEventType {
  event_type: string
  total: string | number
  with_content_hash: string | number
  with_campaign_id: string | number
  with_step: string | number
  with_lead_email: string | number
  earliest: string | null
  latest: string | null
}

interface DiagAttribution {
  event_type: string
  strategy: string
  n: string | number
}

interface DiagSample {
  event_type: string
  content_hash: string | null
  campaign_id: string | null
  step: number | null
  lead_email: string | null
  event_at: string
  raw_keys: string[] | null
}

interface DiagnosticData {
  workspace_id: string
  campaign_templates_total: number
  campaign_templates_active: number
  events_by_type: DiagEventType[]
  attribution_breakdown: DiagAttribution[]
  recent_events_sample: DiagSample[]
}

type TabId = 'templates' | 'subjects' | 'steps' | 'stale' | 'diag'
type SortDir = 'asc' | 'desc'

interface SortState {
  key: string
  dir: SortDir
}

// ── Helper functions ──────────────────────────────────────────────────────────

function pct(num: number, den: number): string | null {
  if (!den || den < 20) return null
  return (num / den * 100).toFixed(1)
}

function rateClass(p: string | null): string {
  if (p === null) return 'low'
  const v = parseFloat(p)
  if (v >= 5) return 'good'
  if (v >= 2) return 'ok'
  if (v > 0) return 'warn'
  return 'bad'
}

function computeScore(r: { sent: number; replies: number; leads: number; bounces: number }): number | null {
  const sent    = Number(r.sent    || 0)
  const replies = Number(r.replies || 0)
  const leads   = Number(r.leads   || 0)
  const bounces = Number(r.bounces || 0)
  if (sent < 20) return null
  const rr = replies / sent
  const lr = leads   / sent
  const br = bounces / sent
  let s = 0
  if      (rr >= 0.05)  s += 40
  else if (rr >= 0.03)  s += 30
  else if (rr >= 0.015) s += 20
  else if (rr >= 0.005) s += 10
  else if (rr > 0)      s += 5
  if      (lr >= 0.005) s += 40
  else if (lr >= 0.002) s += 30
  else if (lr >= 0.001) s += 20
  else if (lr > 0)      s += 10
  if      (br >= 0.05)  s -= 30
  else if (br >= 0.03)  s -= 20
  else if (br >= 0.02)  s -= 10
  if      (sent >= 1000) s += 20
  else if (sent >= 500)  s += 15
  else if (sent >= 100)  s += 10
  else                   s += 5
  return Math.max(0, Math.min(100, s))
}

function scoreColor(s: number | null): string {
  if (s === null || s === undefined) return '#9CA3AF'
  if (s >= 70) return '#10B981'
  if (s >= 50) return '#1F6F78'
  if (s >= 30) return '#F59E0B'
  return '#EF4444'
}

interface ProfileFlag {
  cls: string
  label: string
}

function profileFlags(r: { sent: number; replies: number; leads: number; bounces: number }): ProfileFlag[] {
  const sent    = Number(r.sent    || 0)
  const replies = Number(r.replies || 0)
  const bounces = Number(r.bounces || 0)
  const leads   = Number(r.leads   || 0)
  const flags: ProfileFlag[] = []
  if (sent < 100) return flags
  const rr = replies / sent
  const br = bounces / sent
  if (sent >= 500 && rr < 0.005 && leads === 0) {
    flags.push({ cls: 'profiled', label: 'Profiled · avoid' })
  }
  if (br >= 0.03) {
    flags.push({ cls: 'bounced', label: `${(br * 100).toFixed(1)}% bounce · avoid` })
  }
  if (rr >= 0.04 && leads > 0 && sent >= 200) {
    flags.push({ cls: 'top', label: 'Top performer' })
  }
  return flags
}

function cleanCampName(s: string): string {
  if (!s) return ''
  let cleaned = String(s).replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
  if (!cleaned) cleaned = 'Apollo filter'
  return cleaned.length > 50 ? cleaned.slice(0, 48) + '…' : cleaned
}

function decodeHtml(s: string): string {
  if (!s) return ''
  // Replace common HTML entities
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function fmt(n: number | null | undefined): string {
  return n != null ? Number(n).toLocaleString() : '–'
}

function age(iso: string | null): string {
  if (!iso) return '–'
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (d === 0) return 'Today'
  if (d === 1) return '1 day ago'
  return `${d}d ago`
}

function rate(num: number, den: number): number {
  return Number(den) > 0 ? Number(num) / Number(den) : -1
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null || score === undefined) {
    return (
      <span
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 40, height: 40, borderRadius: '50%',
          background: '#E5E7EB', color: '#9CA3AF',
          fontSize: 11, fontWeight: 600,
        }}
      >–</span>
    )
  }
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 40, height: 40, borderRadius: '50%',
        background: scoreColor(score), color: '#fff',
        fontSize: 13, fontWeight: 800, letterSpacing: '-0.5px',
      }}
    >{score}</span>
  )
}

function FlagBadges({ r }: { r: { sent: number; replies: number; leads: number; bounces: number } }) {
  const flags = profileFlags(r)
  if (!flags.length) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
      {flags.map(f => (
        <span key={f.cls} className={`flag flag-${f.cls}`}>{f.label}</span>
      ))}
    </div>
  )
}

function RateCell({ num, den }: { num: number; den: number }) {
  const p = pct(num, den)
  if (p === null) {
    return <span className="rate low" title="Fewer than 20 sends — rate not shown">–</span>
  }
  return (
    <>
      <span className={`rate ${rateClass(p)}`}>{p}%</span>
      <div className="rate-sub">{num}/{den}</div>
    </>
  )
}

function RateCellTrend({ num, den, num7, den7 }: { num: number; den: number; num7: number; den7: number }) {
  const lifetime = pct(num, den)
  const recent   = pct(num7, den7)

  const lifeEl = lifetime === null
    ? <span className="rate low" title="Fewer than 20 sends — rate not shown">–</span>
    : <span className={`rate ${rateClass(lifetime)}`}>{lifetime}%</span>

  let trendEl: React.ReactNode = null
  if (den7 && den7 >= 20 && recent !== null) {
    const lifeNum = lifetime === null ? null : parseFloat(lifetime)
    const recNum  = parseFloat(recent)
    let arrow = '→', col = 'var(--muted-color)'
    if (lifeNum !== null) {
      if (recNum < lifeNum * 0.5)       { arrow = '↓↓'; col = '#EF4444' }
      else if (recNum < lifeNum * 0.8)  { arrow = '↓';  col = '#F59E0B' }
      else if (recNum > lifeNum * 1.25) { arrow = '↑';  col = '#10B981' }
    }
    trendEl = <div className="rate-sub" style={{ fontWeight: 600, color: col }} title={`Last 7 days: ${num7}/${den7}`}>{arrow} {recent}% 7d</div>
  } else if (den7 && den7 > 0) {
    trendEl = <div className="rate-sub" title={`Last 7 days: ${num7}/${den7} (low volume)`}>— 7d: {num7}/{den7}</div>
  } else {
    trendEl = <div className="rate-sub" style={{ color: '#6B7280' }}>— no 7d data</div>
  }

  return (
    <>
      {lifeEl}
      {lifetime !== null && <div className="rate-sub">{num}/{den} lifetime</div>}
      {trendEl}
    </>
  )
}

function CampaignStatusBadge({ t }: { t: { is_active: boolean; campaign_statuses: string[] | null } }) {
  const statuses = Array.isArray(t.campaign_statuses) ? t.campaign_statuses : []
  const colours: Record<string, string> = {
    active: '#10B981', running: '#10B981', started: '#10B981',
    paused: '#F59E0B', draft: '#9CA3AF', completed: '#6B7280', archived: '#6B7280',
  }
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const Dot = ({ color }: { color: string }) => (
    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6, verticalAlign: 'middle', background: color }} />
  )

  if (t.is_active) return <><Dot color="#10B981" />Active</>

  const nonActive = statuses.filter(s => s !== 'active' && s !== 'running' && s !== 'started')
  if (nonActive.length) {
    const s = nonActive[0]
    return <><Dot color={colours[s] || '#6B7280'} />{cap(s)}</>
  }
  return <><Dot color="#9CA3AF" />Inactive</>
}

// ── Sorting ───────────────────────────────────────────────────────────────────

type SortableTemplate = CopyTemplate
type SortableSubject  = CopySubject

function sortTemplates(rows: SortableTemplate[], key: string, dir: SortDir): SortableTemplate[] {
  const mul = dir === 'asc' ? 1 : -1
  const get = (r: SortableTemplate): number | string => {
    switch (key) {
      case 'sent':        return Number(r.sent    || 0)
      case 'replies':     return Number(r.replies || 0)
      case 'leads':       return Number(r.leads   || 0)
      case 'bounces':     return Number(r.bounces || 0)
      case 'reply_rate':  return rate(r.replies, r.sent)
      case 'lead_rate':   return rate(r.leads,   r.sent)
      case 'bounce_rate': return rate(r.bounces,  r.sent)
      case 'subject':     return String(r.subject || '').toLowerCase()
      case 'score': {
        const s = computeScore(r); return s === null ? -1 : s
      }
      case 'step':   return Number(r.min_step || 99)
      case 'status': {
        const flags = profileFlags(r).map(f => f.cls)
        if (flags.includes('top'))      return 5
        if (flags.includes('profiled')) return 0
        if (flags.includes('bounced'))  return 1
        if (r.is_active === false)      return 2
        const ss = Array.isArray(r.campaign_statuses) ? r.campaign_statuses : []
        if (ss.includes('active') || ss.includes('running')) return 4
        if (ss.includes('paused')) return 3
        if (ss.length) return 2
        return r.is_active ? 4 : 2
      }
      default: return 0
    }
  }
  return rows.slice().sort((a, b) => {
    const va = get(a), vb = get(b)
    if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * mul
    return ((va as number) - (vb as number)) * mul
  })
}

function sortSubjects(rows: SortableSubject[], key: string, dir: SortDir): SortableSubject[] {
  const mul = dir === 'asc' ? 1 : -1
  const get = (r: SortableSubject): number | string => {
    switch (key) {
      case 'sent':           return Number(r.sent           || 0)
      case 'replies':        return Number(r.replies        || 0)
      case 'leads':          return Number(r.leads          || 0)
      case 'reply_rate':     return rate(r.replies, r.sent)
      case 'lead_rate':      return rate(r.leads,   r.sent)
      case 'campaign_count': return Number(r.campaign_count || 0)
      case 'subject':        return String(r.subject        || '').toLowerCase()
      case 'score': {
        const s = computeScore(r); return s === null ? -1 : s
      }
      case 'status': {
        const flags = profileFlags(r).map(f => f.cls)
        if (flags.includes('top'))      return 5
        if (flags.includes('profiled')) return 0
        if (flags.includes('bounced'))  return 1
        return r.is_active ? 4 : 2
      }
      default: return 0
    }
  }
  return rows.slice().sort((a, b) => {
    const va = get(a), vb = get(b)
    if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * mul
    return ((va as number) - (vb as number)) * mul
  })
}

// ── Email preview modal ───────────────────────────────────────────────────────

interface EmailModalProps {
  open: boolean
  onClose: () => void
  subject: string | null
  body: string | null
  campaigns: string[]
  sent: number
  replies: number
  leads: number
  bounces: number
  step?: string
}

function EmailModal({ open, onClose, subject, body, campaigns, sent, replies, leads, bounces, step }: EmailModalProps) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const decoded = decodeHtml(body || '')
  const isHtml = /<[a-z][\s\S]*>/i.test(decoded)

  return (
    <div
      className="o-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="o-modal"
        onClick={e => e.stopPropagation()}
      >
        <div className="o-modal-header">
          <div className="o-modal-title">Email preview</div>
          <button className="o-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="o-modal-body" style={{ overflowY: 'auto' }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#050C29', marginBottom: 8 }}>{subject || '(no subject)'}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20, fontSize: 11, color: '#6B7280' }}>
            {sent    != null && <span><strong style={{ color: '#050C29' }}>{Number(sent).toLocaleString()}</strong> sent</span>}
            {replies != null && <span><strong style={{ color: '#050C29' }}>{Number(replies).toLocaleString()}</strong> replies</span>}
            {leads   != null && <span><strong style={{ color: '#050C29' }}>{Number(leads).toLocaleString()}</strong> leads</span>}
            {bounces != null && <span><strong style={{ color: '#050C29' }}>{Number(bounces).toLocaleString()}</strong> bounces</span>}
            {step    != null && <span>Step <strong style={{ color: '#050C29' }}>{step}</strong></span>}
          </div>
          {isHtml ? (
            <div
              style={{ fontSize: 13, lineHeight: 1.6, color: '#1F2937', background: '#F9FAFB', padding: 16, borderRadius: 8, border: '1px solid #E2E6F0' }}
              dangerouslySetInnerHTML={{ __html: decoded }}
            />
          ) : (
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6, fontFamily: 'Inter, sans-serif', color: '#1F2937', background: '#F9FAFB', padding: 16, borderRadius: 8, border: '1px solid #E2E6F0' }}>
              {decoded}
            </pre>
          )}
          {campaigns.length > 0 && (
            <div style={{ marginTop: 16, border: '1px solid #E2E6F0', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '8px 12px', background: '#F3F4F6', fontSize: 10, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid #E2E6F0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Campaigns using this template</span>
                <span>{campaigns.length}</span>
              </div>
              <div style={{ maxHeight: 180, overflowY: 'auto', background: '#fff' }}>
                {campaigns.map((c, i) => {
                  const cleaned = cleanCampName(c) || 'Apollo filter'
                  return (
                    <div key={i} style={{ padding: '8px 12px', fontSize: 12, color: '#050C29', borderBottom: '1px solid #F3F4F6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c}>
                      {cleaned}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CopyPage() {
  const [workspaces, setWorkspaces]     = useState<Workspace[]>([])
  const [wsId, setWsId]                 = useState<string>('')
  const [loading, setLoading]           = useState(false)
  const [loadMsg, setLoadMsg]           = useState('Select a workspace to load copy data')
  const [error, setError]               = useState<string | null>(null)
  const [data, setData]                 = useState<CopyAnalyticsData | null>(null)
  const [activeTab, setActiveTab]       = useState<TabId>('templates')
  const [refreshing, setRefreshing]     = useState(false)
  const [refreshLabel, setRefreshLabel] = useState('Refresh templates')

  // Sort state
  const [tplSort, setTplSort] = useState<SortState>({ key: 'score', dir: 'desc' })
  const [subSort, setSubSort] = useState<SortState>({ key: 'score', dir: 'desc' })

  // Suppress in-progress set (content_hash → true)
  const [suppressing, setSuppressing] = useState<Record<string, boolean>>({})

  // Diagnostic data
  const [diagData, setDiagData]    = useState<DiagnosticData | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [diagError, setDiagError]  = useState<string | null>(null)

  // Email modal
  const [modal, setModal] = useState<EmailModalProps & { open: boolean }>({
    open: false, subject: null, body: null, campaigns: [],
    sent: 0, replies: 0, leads: 0, bounces: 0, step: undefined,
    onClose: () => {},
  })

  // Load workspaces on mount
  useEffect(() => {
    async function load() {
      try {
        const r = await fetch('/api/pv/workspaces')
        const d = await r.json() as { workspaces?: Workspace[]; list?: Workspace[] } | Workspace[]
        const list: Workspace[] = Array.isArray(d) ? d : (d as { workspaces?: Workspace[]; list?: Workspace[] }).workspaces || (d as { list?: Workspace[] }).list || []
        setWorkspaces(list)
        const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('copy_ws') : null
        if (saved) {
          const match = list.find(w => (w._id || w.id || w.workspace_id) === saved)
          if (match) {
            setWsId(saved)
            loadData(saved)
          }
        }
      } catch (e) {
        console.warn('workspaces:', e)
      }
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadData = useCallback(async (id: string) => {
    setLoading(true)
    setLoadMsg('Loading copy data…')
    setError(null)
    setData(null)
    try {
      const r = await fetch(`/api/copy/analytics?workspace_id=${encodeURIComponent(id)}`)
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json() as CopyAnalyticsData
      setData(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const handleWsChange = useCallback((id: string) => {
    setWsId(id)
    if (!id) return
    localStorage.setItem('copy_ws', id)
    loadData(id)
  }, [loadData])

  const handleRefresh = useCallback(async () => {
    if (!wsId) return
    setRefreshing(true)
    const orig = 'Refresh templates'
    setRefreshLabel('Syncing…')
    try {
      const r = await fetch(`/api/copy/refresh-templates?workspace_id=${encodeURIComponent(wsId)}`, { method: 'POST' })
      const d = await r.json() as { captured?: number; error?: string }
      if (!r.ok) throw new Error(d.error || 'refresh failed')
      setRefreshLabel(`Synced ${d.captured || 0} templates`)
      loadData(wsId)
    } catch (e) {
      setRefreshLabel('Error: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setTimeout(() => { setRefreshLabel(orig); setRefreshing(false) }, 3500)
    }
  }, [wsId, loadData])

  const handleSuppress = useCallback(async (contentHash: string) => {
    if (!wsId || !contentHash) return
    setSuppressing(prev => ({ ...prev, [contentHash]: true }))
    try {
      const r = await fetch('/api/copy/suppress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: wsId, content_hash: contentHash }),
      })
      const d = await r.json() as { errors?: unknown[] }
      if (d.errors && Array.isArray(d.errors) && d.errors.length) console.warn('[suppress] PV errors:', d.errors)
      loadData(wsId)
    } catch {
      // noop
    } finally {
      setSuppressing(prev => { const n = { ...prev }; delete n[contentHash]; return n })
    }
  }, [wsId, loadData])

  const openModal = useCallback((props: Omit<EmailModalProps, 'open' | 'onClose'>) => {
    setModal({ ...props, open: true, onClose: () => setModal(m => ({ ...m, open: false })) })
  }, [])

  // Load diagnostic when tab switches
  const loadDiagnostic = useCallback(async (id: string) => {
    setDiagLoading(true)
    setDiagError(null)
    setDiagData(null)
    try {
      const r = await fetch(`/api/copy/diagnostic?workspace_id=${encodeURIComponent(id)}`)
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json() as DiagnosticData
      setDiagData(d)
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : String(e))
    } finally {
      setDiagLoading(false)
    }
  }, [])

  const handleTabChange = useCallback((tab: TabId) => {
    setActiveTab(tab)
    if (tab === 'diag' && wsId) loadDiagnostic(wsId)
  }, [wsId, loadDiagnostic])

  // ── Sort header click ──
  function handleTplSort(key: string) {
    setTplSort(prev => ({
      key,
      dir: prev.key === key ? (prev.dir === 'asc' ? 'desc' : 'asc') : (key === 'subject' ? 'asc' : 'desc'),
    }))
  }
  function handleSubSort(key: string) {
    setSubSort(prev => ({
      key,
      dir: prev.key === key ? (prev.dir === 'asc' ? 'desc' : 'asc') : (key === 'subject' ? 'asc' : 'desc'),
    }))
  }

  // ── Derived data ──
  const templates  = data ? sortTemplates(data.templates || [], tplSort.key, tplSort.dir) : []
  const subjects   = data ? sortSubjects(data.subjects   || [], subSort.key, subSort.dir) : []
  const steps      = data?.by_step || []
  const stale      = data?.stale   || []
  const totals     = data?.totals

  const staleCount  = stale.length
  const totalSent   = Number(totals?.total_sent    || 0)
  const totalReplies= Number(totals?.total_replies || 0)
  const totalLeads  = Number(totals?.total_leads   || 0)
  const replyRate   = totalSent ? (totalReplies / totalSent * 100).toFixed(1) + '%' : '–'
  const proven      = (data?.templates || []).filter(r => Number(r.replies || 0) > 0 || Number(r.leads || 0) > 0).length

  const wsList = workspaces.map(w => ({
    id:   w._id || w.id || w.workspace_id || '',
    name: w.name || w.workspace_name || '',
  }))

  // ── Sort indicator helper ──
  function sortCaret(key: string, state: SortState) {
    if (state.key !== key) return null
    return state.dir === 'asc'
      ? <span style={{ marginLeft: 6, display: 'inline-block', width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderBottom: '5px solid currentColor' }} />
      : <span style={{ marginLeft: 6, display: 'inline-block', width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: '5px solid currentColor' }} />
  }

  // ── Template row click ──
  function handleTplRowClick(t: CopyTemplate) {
    const stepRange = t.min_step === t.max_step
      ? String(t.min_step ?? '?')
      : `${t.min_step}–${t.max_step}`
    openModal({
      subject: t.subject, body: t.body || t.body_excerpt,
      campaigns: t.campaigns || [],
      sent: t.sent, replies: t.replies, leads: t.leads, bounces: t.bounces,
      step: stepRange,
    })
  }

  // ── Subject row click ──
  function handleSubRowClick(s: CopySubject) {
    const matchTpl = (data?.templates || []).find(t => t.subject === s.subject)
    openModal({
      subject: s.subject, body: matchTpl?.body || matchTpl?.body_excerpt || null,
      campaigns: matchTpl?.campaigns || [],
      sent: s.sent, replies: s.replies, leads: s.leads, bounces: s.bounces,
    })
  }

  // ── Steps rendering ──
  const maxReplies = steps.length ? Math.max(...steps.map(r => Number(r.replies || 0)), 1) : 1
  const maxLeads   = steps.length ? Math.max(...steps.map(r => Number(r.leads   || 0)), 1) : 1

  return (
    <>
      <style>{`
        :root {
          --muted-color: #6B7280;
        }
        .rate { font-family: 'Genos', system-ui, sans-serif; font-size: 1.1rem; font-weight: 700; }
        .rate.good  { color: #059669; }
        .rate.ok    { color: #1F6F78; }
        .rate.warn  { color: #D97706; }
        .rate.low   { color: #6B7280; }
        .rate.bad   { color: #DC2626; }
        .rate-sub   { font-size: 10px; color: #6B7280; font-weight: 400; }
        .count      { font-family: 'Genos', system-ui, sans-serif; font-size: 1.1rem; font-weight: 700; color: #050C29; }
        .count.zero { color: #D1D5DB; }
        .flag { display: inline-block; font-size: 9px; font-weight: 700; padding: 3px 7px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.3px; white-space: nowrap; margin-top: 2px; }
        .flag-profiled { background: #FEE2E2; color: #B91C1C; border: 1px solid #FCA5A5; }
        .flag-bounced  { background: #FEF3C7; color: #92400E; border: 1px solid #FDE68A; }
        .flag-top      { background: #D1FAE5; color: #065F46; border: 1px solid #6EE7B7; }
        .step-badge { display: inline-block; font-size: 10px; font-weight: 700; background: #F3F4F6; color: #6B7280; padding: 2px 8px; border-radius: 4px; }
        .stale-badge { font-size: 10px; font-weight: 700; background: #FEF3C7; color: #D97706; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
      `}</style>

      <div className="o-page">
        {/* Page header */}
        <div className="o-page-header">
          <div>
            <div className="o-page-title">Copy Analytics</div>
            <div className="o-page-sub">Template and subject line performance across workspaces</div>
          </div>
          <div className="o-page-actions">
            <button
              onClick={handleRefresh}
              disabled={refreshing || !wsId}
              className="o-btn o-btn-ghost o-btn-sm"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
              </svg>
              <span>{refreshLabel}</span>
            </button>
            <select
              value={wsId}
              onChange={e => handleWsChange(e.target.value)}
              className="o-select"
              style={{ minWidth: 200 }}
            >
              <option value="">Select workspace…</option>
              {wsList.map(w => (
                <option key={w.id} value={w.id}>{w.name || w.id}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Loading / Error state */}
        {!data && (
          <div className="o-empty" style={{ paddingTop: 48, paddingBottom: 48 }}>
            {error ? (
              <span style={{ color: '#DC2626' }}>Error: {error}</span>
            ) : loading ? (
              <><span className="o-spin" style={{ marginRight: 8 }} />{loadMsg}</>
            ) : (
              <span>{loadMsg}</span>
            )}
          </div>
        )}

        {/* Dashboard */}
        {data && (
          <>
            {/* Stats row */}
            <div className="o-metrics o-metrics-4" style={{ marginBottom: 28 }}>
              <div className="o-metric" style={{ borderTopColor: '#1F6F78' }}>
                <div className="o-metric-label">Total Sent</div>
                <div className="o-metric-val" style={{ color: '#224388' }}>{totalSent.toLocaleString()}</div>
                <div className="o-metric-sub">all-time from PlusVibe</div>
              </div>
              <div className="o-metric" style={{ borderTopColor: '#16A34A' }}>
                <div className="o-metric-label">Total Replies</div>
                <div className="o-metric-val" style={{ color: '#16A34A' }}>{totalReplies.toLocaleString()}</div>
                <div className="o-metric-sub">{replyRate} reply rate · all-time</div>
              </div>
              <div className="o-metric" style={{ borderTopColor: '#1F6F78' }}>
                <div className="o-metric-label">Leads Generated</div>
                <div className="o-metric-val" style={{ color: '#224388' }}>{totalLeads.toLocaleString()}</div>
                <div className="o-metric-sub">{proven} templates with positive signal</div>
              </div>
              <div className="o-metric" style={{ borderTopColor: staleCount > 0 ? '#D97706' : '#16A34A' }}>
                <div className="o-metric-label">Stale Templates</div>
                <div className="o-metric-val" style={{ color: staleCount > 0 ? '#D97706' : '#224388' }}>{staleCount}</div>
                <div className="o-metric-sub">active, 20+ sends, zero response</div>
              </div>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: '#fff', padding: 4, borderRadius: 12, border: '1px solid #E2E6F0', width: 'fit-content' }}>
              {(['templates', 'subjects', 'steps', 'stale', 'diag'] as TabId[]).map(tab => (
                <button
                  key={tab}
                  onClick={() => handleTabChange(tab)}
                  style={{
                    padding: '8px 20px',
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    border: 'none',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    background: activeTab === tab ? '#050C29' : 'transparent',
                    color: activeTab === tab ? '#fff' : '#6B7280',
                  }}
                >
                  {tab === 'templates' ? 'Templates' :
                   tab === 'subjects'  ? 'Subject Lines' :
                   tab === 'steps'     ? 'By Step' :
                   tab === 'stale'     ? 'Decaying Copy' :
                   'Diagnostic'}
                </button>
              ))}
            </div>

            {/* Templates tab */}
            {activeTab === 'templates' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
                  <div className="o-section-h" style={{ margin: 0 }}>Template Performance</div>
                  <span style={{ fontSize: 11, fontWeight: 700, background: '#1F6F78', color: '#fff', borderRadius: 999, padding: '2px 12px', whiteSpace: 'nowrap' }}>{(data.templates || []).length} templates</span>
                  <div style={{ flex: 1, height: 1, background: '#E2E6F0' }} />
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6B7280', background: '#F3F4F6', padding: '6px 12px', borderRadius: 8, marginBottom: 16 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  Reply rate and lead rate shown only for templates with 20+ sends — below that the numbers aren't meaningful.
                </div>
                <div className="o-card" style={{ marginBottom: 28, padding: 0, overflow: 'hidden' }}>
                  <div className="o-table-wrap" style={{ margin: 0 }}>
                    <table className="o-table">
                      <thead>
                        <tr>
                          {([
                            { key: 'subject',      label: 'Subject / Body preview', num: false },
                            { key: 'score',        label: 'Score',       num: true },
                            { key: 'sent',         label: 'Sent',        num: true },
                            { key: 'replies',      label: 'Replies',     num: true },
                            { key: 'reply_rate',   label: 'Reply rate',  num: true },
                            { key: 'leads',        label: 'Leads',       num: true },
                            { key: 'lead_rate',    label: 'Lead rate',   num: true },
                            { key: 'bounce_rate',  label: 'Bounce rate', num: true },
                            { key: 'step',         label: 'Step',        num: false },
                            { key: 'status',       label: 'Status',      num: false },
                          ] as { key: string; label: string; num: boolean }[]).map(col => (
                            <th
                              key={col.key}
                              onClick={() => handleTplSort(col.key)}
                              style={{
                                background: '#050C29', color: 'rgba(255,255,255,0.7)',
                                fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
                                padding: '10px 14px', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
                                textAlign: col.num ? 'right' : 'left',
                              }}
                            >
                              {col.label}{sortCaret(col.key, tplSort)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {templates.length === 0 ? (
                          <tr><td colSpan={10}><div className="o-empty">No template data yet for this workspace.</div></td></tr>
                        ) : templates.map(t => {
                          const stepRange = t.min_step === t.max_step
                            ? `Step ${t.min_step ?? '?'}`
                            : `Steps ${t.min_step}–${t.max_step}`
                          const camps = (t.campaigns || []).slice(0, 3)
                          const score = computeScore(t)
                          return (
                            <tr
                              key={t.content_hash}
                              onClick={() => handleTplRowClick(t)}
                              style={{ cursor: 'pointer' }}
                            >
                              <td style={{ padding: '12px 14px', fontSize: 13, verticalAlign: 'top', maxWidth: 380 }}>
                                <div style={{ fontWeight: 600, color: '#050C29', marginBottom: 2, fontSize: 13 }}>
                                  {decodeHtml(t.subject || '') || '(no subject)'}
                                </div>
                                <div style={{ fontSize: 11, color: '#6B7280', lineHeight: 1.45 }}>
                                  {decodeHtml(t.body_excerpt || '').slice(0, 160)}
                                </div>
                                {camps.length > 0 && (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                                    {camps.map((c, i) => {
                                      const n = cleanCampName(c)
                                      return n ? (
                                        <span key={i} style={{ fontSize: 10, fontWeight: 600, background: '#EEF2FF', color: '#4338CA', padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap' }} title={c}>{n}</span>
                                      ) : null
                                    })}
                                    {(t.campaigns?.length ?? 0) > 3 && (
                                      <span style={{ fontSize: 10, fontWeight: 600, background: '#EEF2FF', color: '#4338CA', padding: '2px 6px', borderRadius: 4 }}>+{(t.campaigns?.length ?? 0) - 3} more</span>
                                    )}
                                  </div>
                                )}
                                <FlagBadges r={t} />
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top' }}><ScoreBadge score={score} /></td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <span className={`count ${t.sent === 0 ? 'zero' : ''}`}>{fmt(t.sent)}</span>
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <span className={`count ${t.replies === 0 ? 'zero' : ''}`}>{fmt(t.replies)}</span>
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <RateCellTrend num={t.replies} den={t.sent} num7={t.replies_7d} den7={t.sent_7d} />
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <span className={`count ${t.leads === 0 ? 'zero' : ''}`}>{fmt(t.leads)}</span>
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <RateCell num={t.leads} den={t.sent} />
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <RateCell num={t.bounces} den={t.sent} />
                              </td>
                              <td style={{ padding: '12px 14px', verticalAlign: 'top' }}>
                                <span className="step-badge">{stepRange}</span>
                              </td>
                              <td style={{ padding: '12px 14px', fontSize: 13, verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                                <CampaignStatusBadge t={t} />
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ fontSize: 11, color: '#6B7280', padding: '10px 14px', background: '#F9FAFB', borderTop: '1px solid #E2E6F0', borderRadius: '0 0 8px 8px' }}>
                    Click any column to sort. <strong style={{ color: '#050C29' }}>All-time stats from PlusVibe</strong> — workspace totals above are all-time from PlusVibe. <strong style={{ color: '#050C29' }}>Score</strong> 0–100 weighs reply rate, lead rate, bounce rate and volume. <strong style={{ color: '#050C29' }}>Profiled</strong> = high-volume copy with collapsed responses — stop using it.
                  </div>
                </div>
              </div>
            )}

            {/* Subjects tab */}
            {activeTab === 'subjects' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
                  <div className="o-section-h" style={{ margin: 0 }}>Subject Line Performance</div>
                  <span style={{ fontSize: 11, fontWeight: 700, background: '#1F6F78', color: '#fff', borderRadius: 999, padding: '2px 12px', whiteSpace: 'nowrap' }}>{(data.subjects || []).length} subjects</span>
                  <div style={{ flex: 1, height: 1, background: '#E2E6F0' }} />
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6B7280', background: '#F3F4F6', padding: '6px 12px', borderRadius: 8, marginBottom: 16 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  Same subject used across different bodies or campaigns is pooled. Rates shown for 20+ sends only.
                </div>
                <div className="o-card" style={{ marginBottom: 28, padding: 0, overflow: 'hidden' }}>
                  <div className="o-table-wrap" style={{ margin: 0 }}>
                    <table className="o-table">
                      <thead>
                        <tr>
                          {([
                            { key: 'subject',        label: 'Subject line', num: false },
                            { key: 'score',          label: 'Score',        num: true },
                            { key: 'campaign_count', label: 'Campaigns',    num: true },
                            { key: 'sent',           label: 'Sent',         num: true },
                            { key: 'replies',        label: 'Replies',      num: true },
                            { key: 'reply_rate',     label: 'Reply rate',   num: true },
                            { key: 'leads',          label: 'Leads',        num: true },
                            { key: 'lead_rate',      label: 'Lead rate',    num: true },
                            { key: 'status',         label: 'Status',       num: false },
                          ] as { key: string; label: string; num: boolean }[]).map(col => (
                            <th
                              key={col.key}
                              onClick={() => handleSubSort(col.key)}
                              style={{
                                background: '#050C29', color: 'rgba(255,255,255,0.7)',
                                fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
                                padding: '10px 14px', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
                                textAlign: col.num ? 'right' : 'left',
                              }}
                            >
                              {col.label}{sortCaret(col.key, subSort)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {subjects.length === 0 ? (
                          <tr><td colSpan={9}><div className="o-empty">No subject data yet.</div></td></tr>
                        ) : subjects.map(s => {
                          const score = computeScore(s)
                          const flags = profileFlags(s)
                          const statusEl = flags.length
                            ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{flags.map(f => <span key={f.cls} className={`flag flag-${f.cls}`}>{f.label}</span>)}</div>
                            : null
                          return (
                            <tr
                              key={s.subject_hash}
                              onClick={() => handleSubRowClick(s)}
                              style={{ cursor: 'pointer' }}
                            >
                              <td style={{ padding: '12px 14px', fontSize: 13, verticalAlign: 'top' }}>
                                <div style={{ fontWeight: 600, color: '#050C29', marginBottom: 2 }}>{s.subject || '(blank)'}</div>
                                <div style={{ fontSize: 11, color: '#6B7280' }}>
                                  {s.template_count > 1 ? `${s.template_count} body variants` : '1 body variant'}
                                </div>
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top' }}><ScoreBadge score={score} /></td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <span className="count">{fmt(s.campaign_count)}</span>
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <span className="count">{fmt(s.sent)}</span>
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <span className={`count ${s.replies === 0 ? 'zero' : ''}`}>{fmt(s.replies)}</span>
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <RateCellTrend num={s.replies} den={s.sent} num7={s.replies_7d} den7={s.sent_7d} />
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <span className={`count ${s.leads === 0 ? 'zero' : ''}`}>{fmt(s.leads)}</span>
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <RateCell num={s.leads} den={s.sent} />
                              </td>
                              <td style={{ padding: '12px 14px', fontSize: 13, verticalAlign: 'top' }}>
                                {statusEl}
                                <span style={{ fontSize: 11 }}><CampaignStatusBadge t={s} /></span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ fontSize: 11, color: '#6B7280', padding: '10px 14px', background: '#F9FAFB', borderTop: '1px solid #E2E6F0', borderRadius: '0 0 8px 8px' }}>
                    Click any column to sort. <strong style={{ color: '#050C29' }}>All-time stats from PlusVibe</strong> — workspace totals above are all-time from PlusVibe. <strong style={{ color: '#050C29' }}>Score</strong> 0–100. <strong style={{ color: '#050C29' }}>Profiled</strong> = burnt copy — stop using it.
                  </div>
                </div>
              </div>
            )}

            {/* Steps tab */}
            {activeTab === 'steps' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
                  <div className="o-section-h" style={{ margin: 0 }}>Performance by Step</div>
                  <div style={{ flex: 1, height: 1, background: '#E2E6F0' }} />
                </div>
                <div className="o-card" style={{ marginBottom: 28 }}>
                  <div className="o-card-body">
                    {steps.length === 0 ? (
                      <div className="o-empty">No step data yet.</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        {steps.map(r => {
                          const step    = r.step ?? '?'
                          const sent    = Number(r.sent    || 0)
                          const replies = Number(r.replies || 0)
                          const leads   = Number(r.leads   || 0)
                          const rBar    = Math.round(replies / maxReplies * 100)
                          const lBar    = Math.round(leads   / maxLeads   * 100)
                          const replyRateTxt = sent >= 20 ? (replies / sent * 100).toFixed(1) + '%' : '–'
                          const leadRateTxt  = sent >= 20 ? (leads   / sent * 100).toFixed(1) + '%' : '–'
                          return (
                            <div key={step} style={{ display: 'grid', alignItems: 'center', gap: 16, gridTemplateColumns: '80px 1fr 90px' }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Step {step}</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <div style={{ flex: 1, height: 8, background: '#F3F4F6', borderRadius: 99, overflow: 'hidden' }}>
                                    <div style={{ width: `${rBar}%`, height: '100%', borderRadius: 99, background: '#1F6F78', transition: 'width 0.5s' }} />
                                  </div>
                                  <div style={{ fontSize: 10, color: '#6B7280', width: 140, textAlign: 'right', whiteSpace: 'nowrap' }}>{fmt(replies)} replies ({replyRateTxt})</div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <div style={{ flex: 1, height: 8, background: '#F3F4F6', borderRadius: 99, overflow: 'hidden' }}>
                                    <div style={{ width: `${lBar}%`, height: '100%', borderRadius: 99, background: '#059669', transition: 'width 0.5s' }} />
                                  </div>
                                  <div style={{ fontSize: 10, color: '#6B7280', width: 140, textAlign: 'right', whiteSpace: 'nowrap' }}>{fmt(leads)} leads ({leadRateTxt})</div>
                                </div>
                              </div>
                              <div style={{ textAlign: 'right' }}>
                                <div style={{ fontFamily: "'Genos', sans-serif", fontSize: '1.1rem', fontWeight: 700, color: '#050C29' }}>{fmt(sent)}</div>
                                <div style={{ fontSize: 10, color: '#6B7280' }}>sent</div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: '#6B7280', padding: '10px 14px', background: '#fff', border: '1px solid #E2E6F0', borderRadius: 8, marginBottom: 28 }}>
                  <strong style={{ color: '#050C29' }}>All-time stats from PlusVibe</strong> (sent, replies, bounces per step), plus lead counts from webhook events. Workspace totals above are last-N-days from webhooks. Bars are relative to the best-performing step.
                </div>
              </div>
            )}

            {/* Decaying Copy tab */}
            {activeTab === 'stale' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
                  <div className="o-section-h" style={{ margin: 0 }}>Decaying Copy</div>
                  <span style={{ fontSize: 11, fontWeight: 700, background: '#D97706', color: '#fff', borderRadius: 999, padding: '2px 12px', whiteSpace: 'nowrap' }}>{stale.length} flagged</span>
                  <div style={{ flex: 1, height: 1, background: '#E2E6F0' }} />
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6B7280', background: '#F3F4F6', padding: '6px 12px', borderRadius: 8, marginBottom: 16 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  Active templates flagged as <strong style={{ margin: '0 2px' }}>profiled · avoid</strong>, high bounce, or gone quiet. Remove to hide from all copy views.
                </div>
                <div className="o-card" style={{ marginBottom: 28, padding: 0, overflow: 'hidden' }}>
                  <div className="o-table-wrap" style={{ margin: 0 }}>
                    <table className="o-table">
                      <thead>
                        <tr>
                          <th style={{ background: '#050C29', color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', padding: '10px 14px', textAlign: 'left' }}>Subject / Body preview</th>
                          <th style={{ background: '#050C29', color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', padding: '10px 14px', textAlign: 'right' }}>All-time signal</th>
                          <th style={{ background: '#050C29', color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', padding: '10px 14px', textAlign: 'right' }}>Last 14d signal</th>
                          <th style={{ background: '#050C29', color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', padding: '10px 14px', textAlign: 'right' }}>Last signal</th>
                          <th style={{ background: '#050C29', color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', padding: '10px 14px', textAlign: 'left' }}>Campaigns</th>
                          <th style={{ background: '#050C29', color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', padding: '10px 14px', textAlign: 'left' }}>Step</th>
                          <th style={{ background: '#050C29', color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', padding: '10px 14px', textAlign: 'left' }}>Running since</th>
                          <th style={{ background: '#050C29', color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', padding: '10px 14px' }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {stale.length === 0 ? (
                          <tr>
                            <td colSpan={8}>
                              <div className="o-empty">
                                <strong style={{ color: '#050C29', display: 'block', marginBottom: 4 }}>No flagged templates</strong>
                                No active templates match the profiled, high-bounce, or gone-quiet criteria.
                              </div>
                            </td>
                          </tr>
                        ) : stale.map(t => {
                          const camps      = (t.campaigns || []).slice(0, 3)
                          const totalSig   = Number(t.total_signal)  || 0
                          const sig14d     = Number(t.signal_14d)    || 0
                          const isSuppressing = !!suppressing[t.content_hash]
                          return (
                            <tr key={t.content_hash}>
                              <td style={{ padding: '12px 14px', verticalAlign: 'top' }}>
                                <span className="stale-badge">Avoid</span>
                                <div style={{ fontWeight: 600, color: '#050C29', fontSize: 13, marginTop: 4 }}>{t.subject || '(no subject)'}</div>
                                <div style={{ fontSize: 11, color: '#6B7280' }}>{decodeHtml(t.body_excerpt || '')}</div>
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <span className="count">{fmt(totalSig)}</span>
                              </td>
                              <td style={{ padding: '12px 14px', textAlign: 'right', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' }}>
                                <span className={`count ${sig14d === 0 ? 'zero' : ''}`}>{fmt(sig14d)}</span>
                              </td>
                              <td style={{ padding: '12px 14px', fontSize: 12, color: '#6B7280', verticalAlign: 'top' }}>{age(t.last_signal_at)}</td>
                              <td style={{ padding: '12px 14px', verticalAlign: 'top' }}>
                                {camps.length > 0 ? (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                    {camps.map((c, i) => {
                                      const n = cleanCampName(c)
                                      return n ? <span key={i} style={{ fontSize: 10, fontWeight: 600, background: '#EEF2FF', color: '#4338CA', padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap' }} title={c}>{n}</span> : null
                                    })}
                                    {(t.campaigns?.length ?? 0) > 3 && (
                                      <span style={{ fontSize: 10, fontWeight: 600, background: '#EEF2FF', color: '#4338CA', padding: '2px 6px', borderRadius: 4 }}>+{(t.campaigns?.length ?? 0) - 3}</span>
                                    )}
                                  </div>
                                ) : '–'}
                              </td>
                              <td style={{ padding: '12px 14px', verticalAlign: 'top' }}>
                                <span className="step-badge">Step {t.step ?? '?'}</span>
                              </td>
                              <td style={{ padding: '12px 14px', fontSize: 12, color: '#6B7280', verticalAlign: 'top' }}>{age(t.first_seen)}</td>
                              <td style={{ padding: '12px 14px', verticalAlign: 'top' }}>
                                <button
                                  onClick={() => handleSuppress(t.content_hash)}
                                  disabled={isSuppressing}
                                  className="o-btn o-btn-danger o-btn-sm"
                                >
                                  {isSuppressing ? 'Disabling…' : 'Disable'}
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ fontSize: 11, color: '#6B7280', padding: '10px 14px', background: '#F9FAFB', borderTop: '1px solid #E2E6F0', borderRadius: '0 0 8px 8px' }}>
                    <strong style={{ color: '#050C29' }}>Signal</strong> = replies + leads. <strong style={{ color: '#050C29' }}>Disable</strong> pauses the variant in PlusVibe and hides it from copy analytics.
                  </div>
                </div>
              </div>
            )}

            {/* Diagnostic tab */}
            {activeTab === 'diag' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
                  <div className="o-section-h" style={{ margin: 0 }}>Data Diagnostic</div>
                  {diagData && (
                    <span style={{ fontSize: 11, fontWeight: 700, background: '#1F6F78', color: '#fff', borderRadius: 999, padding: '2px 12px', whiteSpace: 'nowrap' }}>
                      {diagData.campaign_templates_total} templates · {(diagData.events_by_type || []).reduce((s, r) => s + Number(r.total || 0), 0).toLocaleString()} events
                    </span>
                  )}
                  <div style={{ flex: 1, height: 1, background: '#E2E6F0' }} />
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6B7280', background: '#F3F4F6', padding: '6px 12px', borderRadius: 8, marginBottom: 16 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  Raw event field population — shows what PlusVibe is sending us and which attribution strategy each event uses.
                </div>

                {diagLoading && (
                  <div className="o-empty" style={{ paddingTop: 32, paddingBottom: 32 }}>
                    <span className="o-spin" style={{ marginRight: 8 }} />Loading…
                  </div>
                )}
                {diagError && <p style={{ padding: '16px 0', fontSize: 14, color: '#DC2626' }}>Error: {diagError}</p>}

                {diagData && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingTop: 8 }}>
                    {/* Workspace info */}
                    <div>
                      <div className="o-section-h">Workspace</div>
                      <div className="o-card">
                        <div className="o-card-body" style={{ fontSize: 13 }}>
                          <div><strong>Workspace ID:</strong> {diagData.workspace_id}</div>
                          <div><strong>Campaign templates captured:</strong> {diagData.campaign_templates_total} ({diagData.campaign_templates_active} active)</div>
                        </div>
                      </div>
                    </div>

                    {/* Field population */}
                    <div>
                      <div className="o-section-h">Field population by event type</div>
                      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
                        {diagData.events_by_type.length === 0 ? (
                          <div style={{ color: '#6B7280', fontSize: 14 }}>No events</div>
                        ) : diagData.events_by_type.map(r => {
                          const total = Number(r.total) || 1
                          const ch = Number(r.with_content_hash || 0)
                          const ci = Number(r.with_campaign_id  || 0)
                          const st = Number(r.with_step         || 0)
                          const le = Number(r.with_lead_email   || 0)
                          const PctBar = ({ n, color }: { n: number; color: string }) => {
                            const p = (n / total * 100).toFixed(0)
                            return (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 4 }}>
                                <span style={{ width: 110, color: '#6B7280' }}>{n.toLocaleString()} ({p}%)</span>
                                <div style={{ flex: 1, height: 6, background: '#E5E7EB', borderRadius: 99, overflow: 'hidden' }}>
                                  <div style={{ width: `${p}%`, height: '100%', background: color }} />
                                </div>
                              </div>
                            )
                          }
                          return (
                            <div key={r.event_type} className="o-card">
                              <div className="o-card-body">
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                                  <div style={{ fontWeight: 700, fontSize: 14, color: '#050C29' }}>{r.event_type}</div>
                                  <div style={{ fontSize: 12, color: '#6B7280' }}>{Number(r.total).toLocaleString()} events</div>
                                </div>
                                <div>
                                  <div style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', fontWeight: 700 }}>content_hash populated</div>
                                  <PctBar n={ch} color="#10B981" />
                                </div>
                                <div style={{ marginTop: 6 }}>
                                  <div style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', fontWeight: 700 }}>campaign_id populated</div>
                                  <PctBar n={ci} color="#3B82F6" />
                                </div>
                                <div style={{ marginTop: 6 }}>
                                  <div style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', fontWeight: 700 }}>step populated</div>
                                  <PctBar n={st} color="#8B5CF6" />
                                </div>
                                <div style={{ marginTop: 6 }}>
                                  <div style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', fontWeight: 700 }}>lead_email populated</div>
                                  <PctBar n={le} color="#F59E0B" />
                                </div>
                                <div style={{ marginTop: 10, fontSize: 11, color: '#6B7280' }}>
                                  Range: {r.earliest ? new Date(r.earliest).toLocaleString() : '?'} → {r.latest ? new Date(r.latest).toLocaleString() : '?'}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>

                    {/* Attribution breakdown */}
                    <div>
                      <div className="o-section-h">Attribution strategy breakdown</div>
                      <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 8 }}>Each event is attributed to a template via the strongest available signal. Unmatched events have no template attribution.</p>
                      {(() => {
                        const attrByType: Record<string, DiagAttribution[]> = {}
                        diagData.attribution_breakdown.forEach(r => {
                          if (!attrByType[r.event_type]) attrByType[r.event_type] = []
                          attrByType[r.event_type].push(r)
                        })
                        return Object.keys(attrByType).length === 0
                          ? <div style={{ color: '#6B7280', fontSize: 14 }}>No data</div>
                          : Object.entries(attrByType).map(([et, rows]) => {
                            const totalN = rows.reduce((s, r) => s + Number(r.n || 0), 0) || 1
                            const stratColors: Record<string, string> = {
                              unmatched: '#EF4444', direct_hash: '#10B981', lead_email: '#F59E0B'
                            }
                            return (
                              <div key={et} className="o-card" style={{ marginTop: 8 }}>
                                <div className="o-card-body">
                                  <div style={{ fontWeight: 700, fontSize: 14, color: '#050C29', marginBottom: 8 }}>{et}</div>
                                  {rows.map(r => {
                                    const p = (Number(r.n) / totalN * 100).toFixed(0)
                                    const color = stratColors[r.strategy] || '#3B82F6'
                                    return (
                                      <div key={r.strategy} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 4 }}>
                                        <span style={{ width: 120, fontWeight: 600, color: '#050C29' }}>{r.strategy}</span>
                                        <span style={{ width: 90, color: '#6B7280' }}>{Number(r.n).toLocaleString()} ({p}%)</span>
                                        <div style={{ flex: 1, height: 6, background: '#E5E7EB', borderRadius: 99, overflow: 'hidden' }}>
                                          <div style={{ width: `${p}%`, height: '100%', background: color }} />
                                        </div>
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            )
                          })
                      })()}
                    </div>

                    {/* Recent events sample */}
                    <div>
                      <div className="o-section-h">Recent events sample</div>
                      {diagData.recent_events_sample.length === 0 ? (
                        <div style={{ color: '#6B7280', fontSize: 14 }}>No events</div>
                      ) : diagData.recent_events_sample.map((r, i) => (
                        <div key={i} style={{ background: '#fff', padding: 12, borderRadius: 8, border: '1px solid #E2E6F0', marginTop: 6, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6 }}>
                          <div><strong>{r.event_type}</strong> @ {r.event_at}</div>
                          <div style={{ color: '#6B7280' }}>content_hash: <span style={{ color: r.content_hash ? '#10B981' : '#EF4444' }}>{r.content_hash || 'NULL'}</span></div>
                          <div style={{ color: '#6B7280' }}>campaign_id: <span style={{ color: r.campaign_id ? '#10B981' : '#EF4444' }}>{r.campaign_id || 'NULL'}</span></div>
                          <div style={{ color: '#6B7280' }}>step: <span style={{ color: r.step != null ? '#10B981' : '#EF4444' }}>{r.step != null ? r.step : 'NULL'}</span></div>
                          <div style={{ color: '#6B7280' }}>lead_email: <span style={{ color: r.lead_email ? '#10B981' : '#EF4444' }}>{r.lead_email || 'NULL'}</span></div>
                          <div style={{ color: '#6B7280' }}>raw keys: {(r.raw_keys || []).join(', ')}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Email preview modal */}
      <EmailModal {...modal} />
    </>
  )
}
