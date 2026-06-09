'use client'

import { useEffect, useState, useCallback, useRef } from 'react'

// ── Constants ────────────────────────────────────────────────────────────────

const REFRESH_MS = 3 * 60 * 1000
const STORE_KEY = 'ottaly_perf_v2'
const HIDDEN_KEY = 'ottaly_hidden_ws'
const LEADS_CSV_URL =
  'https://docs.google.com/spreadsheets/d/1F6UQJ_om6ZeAdEs9IMy_GQOY_daysUeuBeiOMnwzb9k/export?format=csv&gid=0'

const THR = {
  bounceMax: 5,
  replyDropPct: 15,
  capacityHour: 16,
  capacityMin: 80,
}

// ── Types ────────────────────────────────────────────────────────────────────

interface Workspace {
  id: string
  name: string
  _id?: string
}

interface ClientStatusRow {
  workspace_id: string
  workspace_name: string
  client_status: 'active' | 'inactive'
  restart_date: string | null
}

interface PvEmailStatsRow {
  total_sent_count: number
  total_reply_count: number
  total_ooo_reply_count: number
  total_pos_reply_count: number
  total_bounce_count: number
  total_contacted_count: number
}

interface PvEmailStatsResponse {
  header?: PvEmailStatsRow
  chart?: PvEmailStatsRow[]
}

interface PvAccount {
  _id: string
  email: string
  status: string
  warmup_status: string
  provider: string
  payload: { daily_limit: number } | null
}

interface PvAccountsResponse {
  accounts?: PvAccount[]
  data?: PvAccount[]
}

interface PvWarmupEmailAcc {
  inbox_percent: string
  spam_percent: string
  promotion_percent: string
  google_percent: string
  microsoft_percent: string
  total_warmup_sent: number
  total_inboxes: number
  total_domains: number
  email_domain_detail: Record<string, number>
}

interface PvWarmupResponse {
  emailAcc?: PvWarmupEmailAcc
  data?: PvWarmupEmailAcc
}

interface PvCampaignStat {
  camp_id: string
  camp_name: string
  status: string
  sent_count: number
  replied_count: number
  ooo_reply_count: number
  positive_reply_count: number
  bounced_count: number
  lead_contacted_count: number
}

interface PvLeadStatusCount {
  status: string
  count: number
}

interface Mailbox {
  email: string
  provider: string
  status: string
  warmup_status: string
  workspace_id: string | null
  workspace_name: string | null
  billing_start_date: string | null
  billing_day: number | null
  payload: { daily_limit: number } | null
}

interface MailboxesApiResponse {
  mailboxes: Mailbox[]
}

interface HistorySnapshot {
  ts: number
  replyRate: number
  bounceRate: number
  sent: number
}

interface AggStats {
  sent: number
  replies: number
  oooReplies: number
  posReplies: number
  bounces: number
  contacted: number
}

interface ClientHealthResult {
  ws: Workspace
  todayAgg: AggStats
  agg3d: AggStats
  capPct: number | null
  totalCap: number
  replyToday: number
  replyTodayEx: number
  reply3d: number
  reply3dEx: number
  bounceToday: number
  lastLeadDate: Date | null
  lastLeadDays: number | null
  flags: Array<{ type: string; label: string; color: 'red' | 'amber' }>
  color: 'red' | 'amber' | 'green'
  sortKey: number
}

// ── Utility functions ────────────────────────────────────────────────────────

function isWeekend(ts: number): boolean {
  const day = new Date(ts).getDay()
  return day === 0 || day === 6
}

function workdaysAgo(n: number): Date {
  const d = new Date()
  let count = 0
  while (count < n) {
    d.setDate(d.getDate() - 1)
    const day = d.getDay()
    if (day !== 0 && day !== 6) count++
  }
  return d
}

function ds(date: Date): string {
  return (
    date.getFullYear() +
    '-' +
    String(date.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getDate()).padStart(2, '0')
  )
}

function pct(num: number, denom: number): number {
  return denom > 0 ? (num / denom) * 100 : 0
}

function fmtPct(n: number, d = 1): string {
  return n.toFixed(d) + '%'
}

function fmtN(n: number): string {
  return Number(n).toLocaleString('en-GB')
}

function aggEmailStats(stats: PvEmailStatsResponse | PvEmailStatsRow[] | null): AggStats {
  if (!stats) return { sent: 0, replies: 0, oooReplies: 0, posReplies: 0, bounces: 0, contacted: 0 }
  const resp = stats as PvEmailStatsResponse
  const rows: PvEmailStatsRow[] = resp.header
    ? [resp.header]
    : Array.isArray(stats)
    ? (stats as PvEmailStatsRow[])
    : resp.chart || []
  return rows.reduce(
    (a, r) => ({
      sent: a.sent + (r.total_sent_count || 0),
      replies: a.replies + (r.total_reply_count || 0),
      oooReplies: a.oooReplies + (r.total_ooo_reply_count || 0),
      posReplies: a.posReplies + (r.total_pos_reply_count || 0),
      bounces: a.bounces + (r.total_bounce_count || 0),
      contacted: a.contacted + (r.total_contacted_count || r.total_sent_count || 0),
    }),
    { sent: 0, replies: 0, oooReplies: 0, posReplies: 0, bounces: 0, contacted: 0 }
  )
}

function replyWithOOO(a: AggStats): number {
  return pct((a.replies || 0) + (a.oooReplies || 0), a.contacted || a.sent)
}

function humanReplyRate(a: AggStats): number {
  return pct(a.replies, a.contacted || a.sent)
}

function loadHistory(): HistorySnapshot[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '[]') as HistorySnapshot[]
  } catch {
    return []
  }
}

function saveSnapshot(snap: HistorySnapshot): void {
  if (typeof window === 'undefined') return
  if (isWeekend(snap.ts)) return
  const h = loadHistory()
  h.push(snap)
  const cutoff = Date.now() - 32 * 86400000
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify(h.filter((s) => s.ts > cutoff).slice(-2000))
  )
}

function avgField(history: HistorySnapshot[], field: keyof HistorySnapshot, days: number): number | null {
  const cutoff = Date.now() - days * 86400000
  const items = history.filter(
    (s) => s.ts > cutoff && s[field] != null && !isWeekend(s.ts)
  )
  if (!items.length) return null
  return items.reduce((a, s) => a + (s[field] as number), 0) / items.length
}

function loadHidden(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]') as string[])
  } catch {
    return new Set()
  }
}

function saveHidden(set: Set<string>): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set]))
}

function shortName(name: string): string {
  return (name || 'Unnamed').split(' - ')[0].replace(/https?:\/\/\S+/g, '').trim().substring(0, 45)
}

function pctCls(v: number, higherGood: boolean): string {
  if (higherGood) {
    if (v >= 3) return 'pct-good'
    if (v >= 1.5) return 'pct-warn'
    return 'pct-bad'
  } else {
    if (v <= 2) return 'pct-good'
    if (v <= 5) return 'pct-warn'
    return 'pct-bad'
  }
}

async function pvGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api/actions${path}`)
  if (!res.ok) throw new Error(`API error: ${res.status} ${path}`)
  return res.json() as Promise<T>
}

// ── Sub-components ───────────────────────────────────────────────────────────

function Badge({ status }: { status: string }) {
  const s = (status || '').toUpperCase()
  const statusClass =
    s === 'ACTIVE'
      ? 'o-status o-status-active'
      : s === 'PAUSED'
      ? 'o-status o-status-warning'
      : 'o-status o-status-inactive'
  return (
    <span className={statusClass}>
      {status || '—'}
    </span>
  )
}

function LoadingRow({ cols, msg = 'Loading…' }: { cols: number; msg?: string }) {
  return (
    <tr>
      <td colSpan={cols} style={{ textAlign: 'center', color: '#9CA3AF', padding: '2rem', fontSize: 13 }}>
        {msg}
      </td>
    </tr>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function ActionsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [inactiveIds, setInactiveIds] = useState<Set<string>>(new Set())
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  const [activeWS, setActiveWS] = useState<Workspace | null>(null)
  const [initError, setInitError] = useState<string | null>(null)
  const [manageOpen, setManageOpen] = useState(false)

  // Client view data
  const [loadingClient, setLoadingClient] = useState(false)
  const [clientError, setClientError] = useState<string | null>(null)
  const [todayAgg, setTodayAgg] = useState<AggStats | null>(null)
  const [accounts, setAccounts] = useState<PvAccount[]>([])
  const [warmup, setWarmup] = useState<PvWarmupResponse | null>(null)
  const [monthCampaigns, setMonthCampaigns] = useState<PvCampaignStat[]>([])
  const [leads, setLeads] = useState<PvLeadStatusCount[]>([])
  const [mailboxData, setMailboxData] = useState<Mailbox[]>([])
  const [lastUpdate, setLastUpdate] = useState<string>('')
  const [secsLeft, setSecsLeft] = useState(REFRESH_MS / 1000)
  const [history, setHistory] = useState<HistorySnapshot[]>([])

  // Health scan
  const [scanRunning, setScanRunning] = useState(false)
  const [scanResults, setScanResults] = useState<ClientHealthResult[] | null>(null)
  const [scanProgress, setScanProgress] = useState(0)
  const [scanStatus, setScanStatus] = useState('')

  const scanRunningRef = useRef(false)
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Derived ──────────────────────────────────────────────────────────────

  const activeWorkspaces = workspaces.filter(
    (ws) => !hiddenIds.has(ws.id) && !inactiveIds.has(ws.id)
  )

  // ── Init ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    setHiddenIds(loadHidden())
    setHistory(loadHistory())

    async function init() {
      try {
        const [wsData, statusData] = await Promise.all([
          pvGet<Workspace[]>('/workspaces'),
          fetch('/api/actions/client-status')
            .then((r) => r.json())
            .catch((): ClientStatusRow[] => []),
        ])
        const ws = wsData as Workspace[]
        const status = statusData as ClientStatusRow[]
        setWorkspaces(ws)
        const inactive = new Set(
          status.filter((c) => c.client_status === 'inactive').map((c) => c.workspace_id)
        )
        setInactiveIds(inactive)
        const hidden = loadHidden()
        const first = ws.find((w) => !inactive.has(w.id) && !hidden.has(w.id)) || ws[0]
        setActiveWS(first || null)
      } catch (e) {
        setInitError(e instanceof Error ? e.message : 'Failed to load clients')
      }
    }

    init()
  }, [])

  // Run refresh and scan when activeWS is ready
  useEffect(() => {
    if (!activeWS) return
    refresh(activeWS)
    runHealthScan()

    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    refreshTimerRef.current = setInterval(() => {
      if (activeWS) refresh(activeWS)
      runHealthScan()
    }, REFRESH_MS)

    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    }
  }, [activeWS]) // eslint-disable-line react-hooks/exhaustive-deps

  // Countdown timer
  useEffect(() => {
    const t = setInterval(() => {
      setSecsLeft((s) => Math.max(0, s - 1))
    }, 1000)
    return () => clearInterval(t)
  }, [])

  // ── Data fetch ───────────────────────────────────────────────────────────

  const refresh = useCallback(async (ws: Workspace) => {
    setLoadingClient(true)
    setClientError(null)
    setSecsLeft(REFRESH_MS / 1000)
    try {
      const today = ds(new Date())
      const monthStart = ds(new Date(new Date().getFullYear(), new Date().getMonth(), 1))

      const [todayStats, campaigns, accs, warmupData, leadsData, mailboxes] = await Promise.all([
        pvGet<PvEmailStatsResponse>(`/pv-stats?workspace_id=${ws.id}&start_date=${today}&end_date=${today}`),
        pvGet<PvCampaignStat[]>(`/pv-campaigns?workspace_id=${ws.id}&start_date=${monthStart}&end_date=${today}`),
        pvGet<PvAccountsResponse | PvAccount[]>(`/pv-accounts?workspace_id=${ws.id}`),
        pvGet<PvWarmupResponse>(`/pv-warmup?workspace_id=${ws.id}&start_date=${today}&end_date=${today}`),
        pvGet<PvLeadStatusCount[]>(`/pv-lead-count?workspace_id=${ws.id}`),
        fetch('/api/actions/mailboxes')
          .then((r) => r.json())
          .catch((): MailboxesApiResponse => ({ mailboxes: [] })),
      ])

      const agg = aggEmailStats(todayStats as PvEmailStatsResponse)
      setTodayAgg(agg)

      const accArr: PvAccount[] = Array.isArray(accs)
        ? (accs as PvAccount[])
        : ((accs as PvAccountsResponse).accounts || (accs as PvAccountsResponse).data || [])
      setAccounts(accArr)
      setWarmup(warmupData as PvWarmupResponse)
      setMonthCampaigns(Array.isArray(campaigns) ? campaigns : [])
      setLeads(Array.isArray(leadsData) ? leadsData : [])
      setMailboxData((mailboxes as MailboxesApiResponse).mailboxes || [])

      if (agg.sent > 0) {
        const snap: HistorySnapshot = {
          ts: Date.now(),
          replyRate: humanReplyRate(agg),
          bounceRate: pct(agg.bounces, agg.sent),
          sent: agg.sent,
        }
        saveSnapshot(snap)
        setHistory(loadHistory())
      }

      setLastUpdate(
        new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      )
    } catch (e) {
      setClientError(e instanceof Error ? e.message : 'Failed to load data')
    } finally {
      setLoadingClient(false)
    }
  }, [])

  // ── Health scan ──────────────────────────────────────────────────────────

  const runHealthScan = useCallback(async () => {
    if (scanRunningRef.current) return
    scanRunningRef.current = true
    setScanRunning(true)
    setScanProgress(0)
    setScanStatus('Fetching lead history & workspace stats…')

    try {
      // Fetch leads CSV for last-lead dates
      let leadMap: Record<string, Date> = {}
      try {
        const resp = await fetch(LEADS_CSV_URL)
        const text = await resp.text()
        // Simple CSV parse — find Client Name and Date columns
        const lines = text.split('\n').filter((l) => l.trim())
        if (lines.length > 1) {
          const headers = lines[0].split(',').map((h) => h.replace(/"/g, '').trim())
          const clientIdx = headers.indexOf('Client Name')
          const dateIdx = headers.indexOf('Date')
          const nonLeadIdx = headers.indexOf('Non-Lead Status')
          if (clientIdx >= 0 && dateIdx >= 0) {
            for (let i = 1; i < lines.length; i++) {
              const cols = lines[i].split(',').map((c) => c.replace(/"/g, '').trim())
              const client = cols[clientIdx]
              const nonLead = nonLeadIdx >= 0 ? cols[nonLeadIdx] === 'TRUE' : false
              if (!client || nonLead) continue
              const d = new Date(cols[dateIdx])
              if (!isNaN(d.getTime()) && (!leadMap[client] || d > leadMap[client])) {
                leadMap[client] = d
              }
            }
          }
        }
      } catch {
        // silently ignore
      }

      function matchLeadDate(wsName: string): Date | null {
        const lower = wsName.toLowerCase().trim()
        for (const [k, v] of Object.entries(leadMap)) {
          if (k.toLowerCase().trim() === lower) return v
        }
        for (const [k, v] of Object.entries(leadMap)) {
          const kl = k.toLowerCase().trim()
          if (lower.includes(kl) || kl.includes(lower)) return v
        }
        return null
      }

      const hidden = loadHidden()
      const inactive = inactiveIds
      const active = workspaces.filter((w) => !hidden.has(w.id) && !inactive.has(w.id))
      const total = active.length
      const results: ClientHealthResult[] = []

      const BATCH = 5
      for (let i = 0; i < total; i += BATCH) {
        const batch = active.slice(i, i + BATCH)
        setScanStatus(`Checking ${i + 1}–${Math.min(i + BATCH, total)} of ${total} clients…`)
        setScanProgress(Math.round((i / total) * 100))

        const today = ds(new Date())
        const ago3 = ds(workdaysAgo(3))

        const settled = await Promise.allSettled(
          batch.map(async (ws) => {
            const [todayStats, stats3d, accs] = await Promise.all([
              pvGet<PvEmailStatsResponse>(
                `/pv-stats?workspace_id=${ws.id}&start_date=${today}&end_date=${today}`
              ),
              pvGet<PvEmailStatsResponse>(
                `/pv-stats?workspace_id=${ws.id}&start_date=${ago3}&end_date=${today}`
              ),
              pvGet<PvAccountsResponse | PvAccount[]>(`/pv-accounts?workspace_id=${ws.id}`),
            ])
            return { ws, todayStats, stats3d, accounts: accs }
          })
        )

        for (const r of settled) {
          if (r.status !== 'fulfilled') continue
          const { ws, todayStats, stats3d, accounts: accs } = r.value
          const todayAgg = aggEmailStats(todayStats as PvEmailStatsResponse)
          const agg3d = aggEmailStats(stats3d as PvEmailStatsResponse)

          const accArr: PvAccount[] = Array.isArray(accs)
            ? (accs as PvAccount[])
            : ((accs as PvAccountsResponse).accounts || (accs as PvAccountsResponse).data || [])
          const activeAcc = accArr.filter((a) => a.status === 'ACTIVE')
          const totalCap = activeAcc.reduce((s, a) => s + (a.payload?.daily_limit || 0), 0)
          const capPct = totalCap > 0 ? (todayAgg.sent / totalCap) * 100 : null

          const replyToday = replyWithOOO(todayAgg)
          const replyTodayEx = humanReplyRate(todayAgg)
          const reply3d = replyWithOOO(agg3d)
          const reply3dEx = humanReplyRate(agg3d)
          const bounceToday = pct(todayAgg.bounces, todayAgg.sent)

          const lastLeadDate = matchLeadDate(ws.name)
          const lastLeadDays =
            lastLeadDate
              ? Math.floor((Date.now() - lastLeadDate.getTime()) / 86400000)
              : null

          const flags: ClientHealthResult['flags'] = []
          const nowH = new Date().getHours()

          if (capPct !== null && nowH >= THR.capacityHour && capPct < THR.capacityMin)
            flags.push({ type: 'capacity', label: 'Low sends', color: 'amber' })
          if (todayAgg.sent > 20 && bounceToday > THR.bounceMax)
            flags.push({ type: 'bounce', label: 'High bounce', color: 'red' })
          if (reply3d > 0.5 && todayAgg.sent > 20 && replyToday < reply3d * (1 - THR.replyDropPct / 100))
            flags.push({ type: 'reply', label: 'Reply dropping', color: 'amber' })
          if (todayAgg.sent > 0 && agg3d.sent > 0 && agg3d.replies === 0)
            flags.push({ type: 'silent', label: 'Silent 3d', color: 'red' })

          const hasCritical = flags.some((f) => f.color === 'red') || (lastLeadDays !== null && lastLeadDays > 14)
          const hasWarning = flags.some((f) => f.color === 'amber') || (lastLeadDays !== null && lastLeadDays > 7)
          const color: 'red' | 'amber' | 'green' = hasCritical ? 'red' : hasWarning ? 'amber' : 'green'
          const sortKey =
            (color === 'red' ? 10000 : color === 'amber' ? 5000 : 0) +
            (lastLeadDays ?? 999) * 3 +
            flags.length * 50

          results.push({
            ws, todayAgg, agg3d, capPct, totalCap,
            replyToday, replyTodayEx, reply3d, reply3dEx,
            bounceToday, lastLeadDate, lastLeadDays,
            flags, color, sortKey,
          })
        }

        if (i + BATCH < total) {
          await new Promise((res) => setTimeout(res, 1000))
        }
      }

      setScanProgress(100)
      results.sort((a, b) => b.sortKey - a.sortKey)
      setScanResults(results)
    } catch (e) {
      console.error('Health scan error', e)
    } finally {
      scanRunningRef.current = false
      setScanRunning(false)
    }
  }, [workspaces, inactiveIds])

  // ── Manage modal ─────────────────────────────────────────────────────────

  function toggleVisibility(id: string, visible: boolean) {
    if (inactiveIds.has(id)) return
    const h = loadHidden()
    if (visible) h.delete(id)
    else h.add(id)
    saveHidden(h)
    setHiddenIds(new Set(h))
  }

  // ── Alert generation ─────────────────────────────────────────────────────

  interface Alert {
    cls: 'red' | 'amber'
    msg: string
  }

  function buildAlerts(): Alert[] {
    if (!todayAgg) return []
    const bounceRate = pct(todayAgg.bounces, todayAgg.sent)
    const replyRate = humanReplyRate(todayAgg)
    const avg7Reply = avgField(history, 'replyRate', 7)
    const alerts: Alert[] = []

    if (todayAgg.sent > 0 && bounceRate > THR.bounceMax) {
      alerts.push({
        cls: 'red',
        msg: `Bounce rate is ${fmtPct(bounceRate)} — above the ${THR.bounceMax}% threshold. Review sender reputation and list quality immediately.`,
      })
    }
    if (avg7Reply && todayAgg.sent > 0 && replyRate < avg7Reply * (1 - THR.replyDropPct / 100)) {
      alerts.push({
        cls: 'amber',
        msg: `Reply rate (${fmtPct(replyRate)}) is more than ${THR.replyDropPct}% below your 7-day average (${fmtPct(avg7Reply)}). Consider reviewing messaging.`,
      })
    }
    const now = new Date()
    if (now.getHours() >= THR.capacityHour && todayAgg.sent === 0) {
      alerts.push({
        cls: 'amber',
        msg: `No sends recorded today and it's past ${THR.capacityHour}:00. Check campaign schedules.`,
      })
    }

    // Renewal-approaching alerts
    if (mailboxData.length) {
      const renewSoon: Record<string, { count: number; date: Date; days: number }> = {}
      for (const m of mailboxData) {
        if (!m.billing_start_date) continue
        const day = m.billing_day || new Date(m.billing_start_date).getDate()
        let d = new Date(now.getFullYear(), now.getMonth(), day)
        if (d <= now) d = new Date(now.getFullYear(), now.getMonth() + 1, day)
        const daysLeft = Math.ceil((d.getTime() - now.getTime()) / 86400000)
        if (daysLeft > 5) continue
        const client = m.workspace_name || 'Unassigned'
        if (!renewSoon[client]) renewSoon[client] = { count: 0, date: d, days: daysLeft }
        renewSoon[client].count++
        if (d < renewSoon[client].date) {
          renewSoon[client].date = d
          renewSoon[client].days = daysLeft
        }
      }
      for (const [client, info] of Object.entries(renewSoon)) {
        const dateStr = info.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        alerts.push({
          cls: 'amber',
          msg: `${client} — ${info.count} mailbox${info.count > 1 ? 'es' : ''} renew${info.count === 1 ? 's' : ''} in ${info.days} day${info.days === 1 ? '' : 's'} (${dateStr}). Check billing.`,
        })
      }

      // All-warmup-off alert
      const byClient: Record<string, { total: number; warmupOn: number }> = {}
      for (const m of mailboxData) {
        const client = m.workspace_name
        if (!client || client === 'Ottaly') continue
        if (!byClient[client]) byClient[client] = { total: 0, warmupOn: 0 }
        byClient[client].total++
        if (m.warmup_status === 'ACTIVE') byClient[client].warmupOn++
      }
      for (const [client, info] of Object.entries(byClient)) {
        if (info.total >= 2 && info.warmupOn === 0) {
          alerts.push({
            cls: 'red',
            msg: `${client} — ${info.total} mailboxes, none in warmup. Subscription may have ended.`,
          })
        }
      }
    }

    return alerts
  }

  // ── Render helpers ───────────────────────────────────────────────────────

  const m = Math.floor(secsLeft / 60)
  const s = secsLeft % 60

  const replyRate = todayAgg ? replyWithOOO(todayAgg) : 0
  const humanRate = todayAgg ? humanReplyRate(todayAgg) : 0
  const bounceRate = todayAgg ? pct(todayAgg.bounces, todayAgg.sent) : 0
  const activeAccs = accounts.filter((a) => a.status === 'ACTIVE')
  const totalCap = activeAccs.reduce((sum, a) => sum + (a.payload?.daily_limit || 0), 0)
  const capPct = totalCap > 0 && todayAgg ? Math.round((todayAgg.sent / totalCap) * 100) : 0

  const warmupEa = warmup?.emailAcc || warmup?.data
  const inboxPct = parseFloat(warmupEa?.inbox_percent || '0')

  const r3 = avgField(history, 'replyRate', 3)
  const r7 = avgField(history, 'replyRate', 7)
  const r30 = avgField(history, 'replyRate', 30)
  const b3 = avgField(history, 'bounceRate', 3)
  const b7 = avgField(history, 'bounceRate', 7)
  const b30 = avgField(history, 'bounceRate', 30)

  function arrowEl(current: number, prev: number | null, higherGood: boolean) {
    if (prev == null || isNaN(prev)) return <span style={{ color: '#D1D5DB' }}>➡</span>
    const diff = current - prev
    if (Math.abs(diff) < 0.3) return <span style={{ color: '#D1D5DB' }}>➡</span>
    if (higherGood) {
      return diff > 0 ? (
        <span style={{ color: '#16A34A' }}>↑</span>
      ) : (
        <span style={{ color: '#DC2626' }}>↓</span>
      )
    }
    return diff < 0 ? (
      <span style={{ color: '#16A34A' }}>↓</span>
    ) : (
      <span style={{ color: '#DC2626' }}>↑</span>
    )
  }

  const alerts = buildAlerts()

  // Lead pipeline
  const leadMap: Record<string, number> = {}
  leads.forEach((l) => {
    leadMap[l.status] = l.count
  })
  const totalLeads = Object.values(leadMap).reduce((s, v) => s + v, 0)

  const pipelineItems = [
    { label: 'Not Contacted', key: 'NOT_CONTACTED', color: '#9CA3AF' },
    { label: 'Contacted', key: 'CONTACTED', color: '#224388' },
    { label: 'Replied', key: 'REPLIED', color: '#1F6F78' },
    { label: 'Bounced', key: 'BOUNCED', color: '#DC2626' },
    { label: 'Completed', key: 'COMPLETED', color: '#7C89CD' },
  ]

  // Sorted campaigns
  const sortedCampaigns = [...monthCampaigns].sort((a, b) => (b.sent_count || 0) - (a.sent_count || 0))

  // Domain breakdown
  const domains = warmupEa?.email_domain_detail || {}
  const domainEntries = Object.entries(domains).sort((a, b) => b[1] - a[1])

  // Sorted mailboxes
  const sortedMailboxes = [...accounts].sort((a, b) => {
    if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1
    if (b.status === 'ACTIVE' && a.status !== 'ACTIVE') return 1
    return (a.email || '').localeCompare(b.email || '')
  })

  // Health scan counters
  const redCount = scanResults?.filter((r) => r.color === 'red').length ?? 0
  const amberCount = scanResults?.filter((r) => r.color === 'amber').length ?? 0
  const greenCount = scanResults?.filter((r) => r.color === 'green').length ?? 0

  // ── JSX ──────────────────────────────────────────────────────────────────

  return (
    <div className="o-page">

      {/* ── Client tab bar ── */}
      <div style={{ background: '#ffffff', borderBottom: '2px solid #E2E6F0', margin: '-2rem -1.75rem 2rem', padding: '0 1.75rem', overflowX: 'auto', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'flex', gap: 0, alignItems: 'stretch' }}>
          <div style={{ width: 1, background: '#E2E6F0', margin: '8px 4px', flexShrink: 0 }} />
          {initError ? (
            <span style={{ padding: '14px 20px', color: '#DC2626', fontSize: 13 }}>
              Failed to load clients: {initError}
            </span>
          ) : workspaces.length === 0 ? (
            <span style={{ padding: '14px 20px', color: '#6B7280', fontSize: 13 }}>Loading clients…</span>
          ) : (
            activeWorkspaces.map((ws) => (
              <button
                key={ws.id}
                onClick={() => setActiveWS(ws)}
                style={{
                  padding: '14px 20px',
                  border: 'none',
                  background: 'transparent',
                  fontFamily: 'Inter, sans-serif',
                  fontSize: 13,
                  fontWeight: 600,
                  color: ws.id === activeWS?.id ? '#224388' : '#6B7280',
                  cursor: 'pointer',
                  borderBottom: ws.id === activeWS?.id ? '3px solid #224388' : '3px solid transparent',
                  marginBottom: -2,
                  transition: 'all 0.15s',
                  whiteSpace: 'nowrap',
                }}
              >
                {ws.name}
              </button>
            ))
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={() => setManageOpen(true)}
            style={{
              padding: '14px 16px',
              border: 'none',
              background: 'transparent',
              fontFamily: 'Inter, sans-serif',
              fontSize: 13,
              fontWeight: 600,
              color: '#6B7280',
              cursor: 'pointer',
              borderBottom: '3px solid transparent',
              marginBottom: -2,
              whiteSpace: 'nowrap',
            }}
          >
            ⚙ Manage
          </button>
          {lastUpdate && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderLeft: '1px solid #E2E6F0' }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#16A34A' }} />
              <span style={{ color: '#6B7280', fontSize: 12, fontWeight: 500 }}>{lastUpdate}</span>
              <span style={{ fontSize: 12, color: '#9CA3AF' }}>
                {m}:{s.toString().padStart(2, '0')}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Manage Modal ── */}
      {manageOpen && (
        <div
          className="o-modal-overlay"
          onClick={(e) => { if (e.target === e.currentTarget) setManageOpen(false) }}
        >
          <div className="o-modal o-modal-sm">
            <div className="o-modal-header">
              <div>
                <div className="o-modal-title">Manage Clients</div>
                <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>Hidden clients are excluded from the dashboard and scans</div>
              </div>
              <button className="o-modal-close" onClick={() => setManageOpen(false)}>×</button>
            </div>
            <div className="o-modal-body" style={{ padding: '0.75rem 0', maxHeight: '60vh', overflowY: 'auto' }}>
              {workspaces.map((ws) => {
                const isInactive = inactiveIds.has(ws.id)
                const isHidden = hiddenIds.has(ws.id) || isInactive
                return (
                  <div
                    key={ws.id}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1.75rem', opacity: isInactive ? 0.45 : 1 }}
                  >
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#050C29' }}>{ws.name}</div>
                      {isInactive ? (
                        <div style={{ fontSize: 11, color: '#DC2626' }}>Disabled in Clients page</div>
                      ) : isHidden ? (
                        <div style={{ fontSize: 11, color: '#6B7280' }}>Hidden</div>
                      ) : null}
                    </div>
                    <label style={{ position: 'relative', width: 40, height: 22, flexShrink: 0, pointerEvents: isInactive ? 'none' : 'auto' }}>
                      <input
                        type="checkbox"
                        checked={!isHidden}
                        disabled={isInactive}
                        onChange={(e) => toggleVisibility(ws.id, e.target.checked)}
                        style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
                      />
                      <span
                        style={{
                          position: 'absolute',
                          inset: 0,
                          borderRadius: 11,
                          background: !isHidden ? '#1F6F78' : '#E2E6F0',
                          cursor: 'pointer',
                          transition: 'background 0.2s',
                        }}
                      >
                        <span
                          style={{
                            position: 'absolute',
                            top: 3,
                            left: !isHidden ? 21 : 3,
                            width: 16,
                            height: 16,
                            borderRadius: '50%',
                            background: 'white',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                            transition: 'left 0.2s',
                          }}
                        />
                      </span>
                    </label>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Health Scan Section ── */}
      <div style={{ marginBottom: '2rem' }}>
        <div className="o-page-header" style={{ marginBottom: '1.25rem', paddingBottom: '1.25rem', borderBottom: '2px solid #E2E6F0' }}>
          <div>
            <div className="o-page-title">Client Health Overview</div>
            <div className="o-page-sub">
              {scanResults
                ? `${scanResults.length} active workspaces · Scanned at ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
                : scanRunning
                ? 'Scanning…'
                : 'Not yet scanned'}
            </div>
          </div>
          <div className="o-page-actions">
            <button
              className="o-btn o-btn-primary"
              onClick={runHealthScan}
              disabled={scanRunning}
            >
              {scanRunning ? <><span className="o-spin" /> Scanning…</> : '↻ Re-scan'}
            </button>
          </div>
        </div>

        {/* Scan progress */}
        {scanRunning && !scanResults && (
          <div className="o-card" style={{ maxWidth: 520, margin: '0 auto 2rem', textAlign: 'center' }}>
            <div className="o-card-body">
              <div style={{ fontFamily: 'Genos, sans-serif', fontSize: 22, fontWeight: 700, color: '#050C29', marginBottom: '1.5rem' }}>
                Loading client data…
              </div>
              <div style={{ background: '#E2E6F0', borderRadius: 8, height: 8, overflow: 'hidden', marginBottom: '1rem' }}>
                <div style={{ height: '100%', background: '#1F6F78', borderRadius: 8, transition: 'width 0.3s ease', width: `${scanProgress}%` }} />
              </div>
              <div style={{ fontSize: 13, color: '#6B7280' }}>{scanStatus}</div>
            </div>
          </div>
        )}

        {/* Health pills */}
        {scanResults && (
          <>
            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
              {redCount > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 18px', borderRadius: 10, background: '#FEF2F2', color: '#DC2626', fontSize: 13, fontWeight: 600 }}>
                  <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 24, fontWeight: 800, lineHeight: 1 }}>{redCount}</span>
                  Need attention
                </div>
              )}
              {amberCount > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 18px', borderRadius: 10, background: '#FFFBEB', color: '#D97706', fontSize: 13, fontWeight: 600 }}>
                  <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 24, fontWeight: 800, lineHeight: 1 }}>{amberCount}</span>
                  Monitor
                </div>
              )}
              {greenCount > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 18px', borderRadius: 10, background: '#DCFCE7', color: '#16A34A', fontSize: 13, fontWeight: 600 }}>
                  <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 24, fontWeight: 800, lineHeight: 1 }}>{greenCount}</span>
                  Healthy
                </div>
              )}
            </div>

            {/* Table header */}
            <div style={{ display: 'grid', gridTemplateColumns: '14px 180px 110px 120px 82px 120px 1fr 80px', gap: '1rem', alignItems: 'center', padding: '0 1.5rem 0.5rem', fontSize: 10, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 1 }}>
              <div />
              <div>Client</div>
              <div>Send Vol</div>
              <div>Reply Rate</div>
              <div>Bounce</div>
              <div>Last Lead</div>
              <div>Status</div>
              <div />
            </div>

            {/* Client rows */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div className="o-table-wrap">
                <table className="o-table">
                  <thead>
                    <tr>
                      <th style={{ width: 8 }}></th>
                      <th>Client</th>
                      <th style={{ textAlign: 'right' }}>Sent today</th>
                      <th style={{ textAlign: 'right' }}>Capacity</th>
                      <th style={{ textAlign: 'right' }}>Reply rate</th>
                      <th style={{ textAlign: 'right' }}>3d avg</th>
                      <th style={{ textAlign: 'right' }}>Bounce</th>
                      <th style={{ textAlign: 'right' }}>Last lead</th>
                      <th>Flags</th>
                      <th style={{ width: 60 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {scanResults.map((r) => {
                      const borderColor = r.color === 'red' ? '#DC2626' : r.color === 'amber' ? '#D97706' : '#16A34A'
                      const capColor = r.capPct === null ? '#D1D5DB' : r.capPct < 50 ? '#DC2626' : r.capPct < 80 ? '#D97706' : '#16A34A'
                      const rrColor = r.todayAgg.sent < 5 ? '#D1D5DB' : r.replyTodayEx >= 3 ? '#16A34A' : r.replyTodayEx >= 1 ? '#D97706' : '#DC2626'
                      const avg3d = r.reply3dEx > 0 ? fmtPct(r.reply3dEx) : '—'
                      const bounceColor = r.todayAgg.sent < 5 ? '#D1D5DB' : r.bounceToday > THR.bounceMax ? '#DC2626' : r.bounceToday > 3 ? '#D97706' : '#16A34A'
                      const lastLeadText = r.lastLeadDays === null ? 'No data' : r.lastLeadDays === 0 ? 'Today' : r.lastLeadDays === 1 ? 'Yesterday' : `${r.lastLeadDays}d ago`
                      const lastLeadColor = r.lastLeadDays === null ? '#D97706' : r.lastLeadDays > 14 ? '#DC2626' : r.lastLeadDays > 7 ? '#D97706' : '#16A34A'
                      const dropped = r.reply3dEx > 0.5 && r.replyTodayEx < r.reply3dEx * (1 - THR.replyDropPct / 100)
                      const up = r.reply3dEx > 0 && r.replyTodayEx > r.reply3dEx * 1.1

                      return (
                        <tr
                          key={r.ws.id}
                          style={{ borderLeft: `3px solid ${borderColor}`, cursor: 'pointer' }}
                          onClick={() => setActiveWS(r.ws)}
                        >
                          <td><div style={{ width: 8, height: 8, borderRadius: '50%', background: borderColor }} /></td>
                          <td style={{ fontWeight: 600 }}>{r.ws.name}</td>
                          <td style={{ textAlign: 'right' }}>{fmtN(r.todayAgg.sent)}</td>
                          <td style={{ textAlign: 'right', color: capColor, fontWeight: 500 }}>
                            {r.capPct === null ? '—' : `${r.capPct.toFixed(0)}%`}
                          </td>
                          <td style={{ textAlign: 'right', color: rrColor, fontWeight: 500 }}>
                            {r.todayAgg.sent < 5 ? '—' : (
                              <span>{fmtPct(r.replyTodayEx)}{dropped ? ' ↓' : up ? ' ↑' : ''}</span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right', color: '#6B7280' }}>{avg3d}</td>
                          <td style={{ textAlign: 'right', color: bounceColor, fontWeight: 500 }}>
                            {r.todayAgg.sent < 5 ? '—' : fmtPct(r.bounceToday)}
                          </td>
                          <td style={{ textAlign: 'right', color: lastLeadColor, fontWeight: 500 }}>{lastLeadText}</td>
                          <td>
                            {r.flags.length === 0 ? (
                              <span style={{ fontSize: 12, color: '#D1D5DB' }}>✓ OK</span>
                            ) : r.flags.map((f) => (
                              <span key={f.type} className={f.color === 'red' ? 'o-status o-status-critical' : 'o-status o-status-warning'} style={{ marginRight: 4 }}>
                                {f.label}
                              </span>
                            ))}
                          </td>
                          <td>
                            <button className="o-btn o-btn-ghost o-btn-sm" onClick={(e) => { e.stopPropagation(); setActiveWS(r.ws) }}>
                              View →
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Divider */}
      <div style={{ height: 2, background: '#E2E6F0', margin: '2rem 0' }} />

      {/* ── Client Detail Section ── */}
      {activeWS && (
        <>
          <div className="o-page-header" style={{ marginBottom: '1.5rem' }}>
            <div>
              <div className="o-page-title">{activeWS.name} — Detail View</div>
            </div>
            {loadingClient && (
              <div className="o-page-actions">
                <span className="o-spin" />
                <span style={{ fontSize: 12, color: '#6B7280', marginLeft: 6 }}>Refreshing…</span>
              </div>
            )}
          </div>

          {/* Alerts */}
          {(clientError || alerts.length > 0) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
              {clientError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.875rem 1.25rem', borderRadius: 10, fontSize: 14, fontWeight: 600, background: '#FEF2F2', border: '2px solid #FCA5A5', color: '#DC2626' }}>
                  Failed to load data: {clientError}
                </div>
              )}
              {alerts.map((a, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.75rem',
                    padding: '0.875rem 1.25rem', borderRadius: 10, fontSize: 14, fontWeight: 600,
                    background: a.cls === 'red' ? '#FEF2F2' : '#FFFBEB',
                    border: `2px solid ${a.cls === 'red' ? '#FCA5A5' : '#FCD34D'}`,
                    color: a.cls === 'red' ? '#DC2626' : '#D97706',
                  }}
                >
                  {a.cls === 'red' ? '🔴' : '⚠️'} {a.msg}
                </div>
              ))}
            </div>
          )}

          {/* Section: Today's Overview */}
          <div className="o-section-h" style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            Today&apos;s Overview
            <div style={{ flex: 1, height: 2, background: '#E2E6F0' }} />
          </div>

          <div className="o-metrics o-metrics-5" style={{ marginBottom: '1.75rem' }}>
            {[
              {
                label: 'Sent Today',
                color: '#1F6F78',
                value: todayAgg ? fmtN(todayAgg.sent) : '—',
                sub: todayAgg ? `${capPct}% of ${fmtN(totalCap)} capacity` : 'loading…',
                isRed: false,
              },
              {
                label: 'Reply Rate (incl. OOO)',
                color: '#224388',
                value: todayAgg && todayAgg.sent > 0 ? fmtPct(replyRate) : '—',
                sub: todayAgg ? `${fmtN((todayAgg.replies || 0) + (todayAgg.oooReplies || 0))} total replies today` : 'loading…',
                isRed: replyRate < 1 && (todayAgg?.sent ?? 0) > 50,
              },
              {
                label: 'Human Reply Rate',
                color: '#7C89CD',
                value: todayAgg && todayAgg.sent > 0 ? fmtPct(humanRate) : '—',
                sub: todayAgg && todayAgg.sent > 0 ? `${fmtN(todayAgg.replies)} human replies · excl. OOO` : 'excl. OOO & auto-replies',
                isRed: humanRate < 0.5 && (todayAgg?.sent ?? 0) > 50,
              },
              {
                label: 'Bounce Rate',
                color: '#D97706',
                value: todayAgg && todayAgg.sent > 0 ? fmtPct(bounceRate) : '—',
                sub: todayAgg ? `${fmtN(todayAgg.bounces)} bounces today` : 'loading…',
                isRed: bounceRate > THR.bounceMax,
              },
              {
                label: 'Inbox Health',
                color: '#7C89CD',
                value: warmupEa ? fmtPct(inboxPct) : '—',
                sub: warmupEa ? `${warmupEa.total_inboxes || 0} mailboxes warming` : 'loading…',
                isRed: inboxPct < 80 && !!warmupEa,
              },
            ].map((card, idx) => (
              <div className="o-metric" key={idx} style={{ borderTopColor: card.color }}>
                <div className="o-metric-label">{card.label}</div>
                <div className="o-metric-val" style={{ color: card.isRed ? '#DC2626' : card.color }}>{card.value}</div>
                <div className="o-metric-sub">{card.sub}</div>
              </div>
            ))}
          </div>

          {/* Section: Rate Trends */}
          <div className="o-section-h" style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            Rate Trends
            <div style={{ flex: 1, height: 2, background: '#E2E6F0' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem', marginBottom: '1.75rem' }}>
            {/* Reply Rate Trends */}
            <div className="o-card">
              <div className="o-card-header">
                <div className="o-card-title">Reply Rate</div>
              </div>
              <div className="o-card-body">
                {[
                  { label: 'Today', val: todayAgg && todayAgg.sent > 0 ? humanRate : null, isToday: true },
                  { label: '3-day avg', val: r3, isToday: false },
                  { label: '7-day avg', val: r7, isToday: false },
                  { label: '30-day avg', val: r30, isToday: false },
                ].map((row) => {
                  const cls =
                    row.val == null
                      ? '#6B7280'
                      : row.val >= 3
                      ? '#1F6F78'
                      : row.val >= 1.5
                      ? '#D97706'
                      : '#DC2626'
                  return (
                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.8rem 0', borderBottom: '1px solid #E2E6F0' }}>
                      <span style={{ fontSize: 13, color: '#6B7280', fontWeight: 500 }}>{row.label}</span>
                      <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 22, fontWeight: 700, color: cls, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        {row.val != null ? fmtPct(row.val) : '—'}
                        {row.isToday && arrowEl(humanRate, r7, true)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Bounce Rate Trends */}
            <div className="o-card">
              <div className="o-card-header">
                <div className="o-card-title">Bounce Rate</div>
              </div>
              <div className="o-card-body">
                {[
                  { label: 'Today', val: todayAgg && todayAgg.sent > 0 ? bounceRate : null, isToday: true },
                  { label: '3-day avg', val: b3, isToday: false },
                  { label: '7-day avg', val: b7, isToday: false },
                  { label: '30-day avg', val: b30, isToday: false },
                ].map((row) => {
                  const cls =
                    row.val == null
                      ? '#6B7280'
                      : row.val <= 2
                      ? '#1F6F78'
                      : row.val <= 5
                      ? '#D97706'
                      : '#DC2626'
                  return (
                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.8rem 0', borderBottom: '1px solid #E2E6F0' }}>
                      <span style={{ fontSize: 13, color: '#6B7280', fontWeight: 500 }}>{row.label}</span>
                      <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 22, fontWeight: 700, color: cls, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        {row.val != null ? fmtPct(row.val) : '—'}
                        {row.isToday && arrowEl(bounceRate, b7, false)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Section: Lead Pipeline */}
          <div className="o-section-h" style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            Lead Pipeline
            <div style={{ flex: 1, height: 2, background: '#E2E6F0' }} />
          </div>

          <div className="o-metrics o-metrics-5" style={{ marginBottom: '1.75rem' }}>
            {pipelineItems.map((item) => {
              const count = leadMap[item.key] || 0
              const p = totalLeads > 0 ? ((count / totalLeads) * 100).toFixed(1) : '0.0'
              return (
                <div className="o-metric" key={item.key} style={{ borderTopColor: item.color, textAlign: 'center' }}>
                  <div className="o-metric-label">{item.label}</div>
                  <div className="o-metric-val" style={{ color: item.color }}>{fmtN(count)}</div>
                  <div className="o-metric-sub">{p}% of total</div>
                </div>
              )
            })}
          </div>

          {/* Section: Campaign Breakdown */}
          <div className="o-section-h" style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            Campaign Breakdown — This Month
            <div style={{ flex: 1, height: 2, background: '#E2E6F0' }} />
          </div>

          <div className="o-card" style={{ marginBottom: '1.75rem' }}>
            <div className="o-card-body" style={{ padding: 0 }}>
              <div className="o-table-wrap">
                <table className="o-table">
                  <thead>
                    <tr>
                      {['Campaign', 'Status', 'Sent', 'Replies', 'Reply %', 'Bounces', 'Bounce %'].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCampaigns.length === 0 ? (
                      <LoadingRow cols={7} msg={loadingClient ? 'Loading…' : 'No campaign data for this month'} />
                    ) : (
                      sortedCampaigns.map((c) => {
                        const sent = c.sent_count || 0
                        const replies = c.replied_count || 0
                        const bounces = c.bounced_count || 0
                        const rr = pct(replies, sent)
                        const br = pct(bounces, sent)
                        const rrCls = rr >= 3 ? '#1F6F78' : rr >= 1.5 ? '#D97706' : '#DC2626'
                        const brCls = br <= 2 ? '#1F6F78' : br <= 5 ? '#D97706' : '#DC2626'
                        return (
                          <tr key={c.camp_id}>
                            <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.camp_name || ''}>
                              {shortName(c.camp_name)}
                            </td>
                            <td><Badge status={c.status} /></td>
                            <td>
                              <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 17, fontWeight: 700, color: '#050C29' }}>{fmtN(sent)}</span>
                            </td>
                            <td>
                              <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 17, fontWeight: 700, color: '#050C29' }}>{fmtN(replies)}</span>
                            </td>
                            <td>
                              <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 17, fontWeight: 700, color: rrCls }}>{sent > 0 ? fmtPct(rr) : '—'}</span>
                            </td>
                            <td>
                              <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 17, fontWeight: 700, color: '#050C29' }}>{fmtN(bounces)}</span>
                            </td>
                            <td>
                              <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 17, fontWeight: 700, color: brCls }}>{sent > 0 ? fmtPct(br) : '—'}</span>
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Section: Warmup & Inbox Health */}
          <div className="o-section-h" style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            Warmup &amp; Inbox Health — Today
            <div style={{ flex: 1, height: 2, background: '#E2E6F0' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem', marginBottom: '1.75rem' }}>
            {/* Agency Inbox Rates */}
            <div className="o-card">
              <div className="o-card-header">
                <div className="o-card-title">Agency Inbox Rates</div>
              </div>
              <div className="o-card-body">
                {!warmupEa ? (
                  <div className="o-empty">
                    {loadingClient ? 'Loading…' : 'No warmup data'}
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1.5rem', textAlign: 'center' }}>
                      {[
                        { label: 'Inbox', val: parseFloat(warmupEa.inbox_percent || '0'), color: '#1F6F78' },
                        { label: 'Spam', val: parseFloat(warmupEa.spam_percent || '0'), color: '#DC2626' },
                        { label: 'Promo', val: parseFloat(warmupEa.promotion_percent || '0'), color: '#D97706' },
                      ].map((item) => (
                        <div key={item.label}>
                          <div style={{ fontFamily: 'Genos, sans-serif', fontSize: 48, fontWeight: 800, lineHeight: 1, color: item.color }}>{item.val.toFixed(1)}%</div>
                          <div style={{ fontSize: 12, color: '#6B7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginTop: 4 }}>{item.label}</div>
                        </div>
                      ))}
                    </div>
                    {[
                      { label: 'Google inbox rate', val: parseFloat(warmupEa.google_percent || '0'), higherGood: true },
                      { label: 'Microsoft inbox rate', val: parseFloat(warmupEa.microsoft_percent || '0'), higherGood: true },
                    ].map((row) => {
                      const _cls =
                        row.val >= 3
                          ? pctCls(row.val, true) === 'pct-good'
                            ? '#1F6F78'
                            : '#D97706'
                          : '#DC2626'
                      const color = row.val >= 3 ? '#1F6F78' : row.val >= 1.5 ? '#D97706' : '#DC2626'
                      return (
                        <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.8rem 0', borderBottom: '1px solid #E2E6F0' }}>
                          <span style={{ fontSize: 13, color: '#6B7280', fontWeight: 500 }}>{row.label}</span>
                          <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 17, fontWeight: 700, color }}>{row.val.toFixed(1)}%</span>
                        </div>
                      )
                    })}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.8rem 0', borderBottom: '1px solid #E2E6F0' }}>
                      <span style={{ fontSize: 13, color: '#6B7280', fontWeight: 500 }}>Total warmup sent today</span>
                      <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 17, fontWeight: 700, color: '#050C29' }}>{fmtN(warmupEa.total_warmup_sent || 0)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.8rem 0' }}>
                      <span style={{ fontSize: 13, color: '#6B7280', fontWeight: 500 }}>Total inboxes / domains</span>
                      <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 17, fontWeight: 700, color: '#050C29' }}>
                        {warmupEa.total_inboxes || 0} / {warmupEa.total_domains || 0}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Mailboxes by Domain */}
            <div className="o-card">
              <div className="o-card-header">
                <div className="o-card-title">Mailboxes by Domain</div>
              </div>
              <div className="o-card-body">
                {domainEntries.length === 0 ? (
                  <div className="o-empty">
                    {loadingClient ? 'Loading…' : 'No domain data'}
                  </div>
                ) : (
                  domainEntries.map(([domain, count]) => (
                    <div key={domain} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.55rem 0', borderBottom: '1px solid #E2E6F0', fontSize: 13 }}>
                      <span style={{ fontWeight: 600, color: '#050C29' }}>{domain}</span>
                      <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 17, fontWeight: 700, color: '#224388' }}>{count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Section: Mailbox Status */}
          <div className="o-section-h" style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            Mailbox Status
            <div style={{ flex: 1, height: 2, background: '#E2E6F0' }} />
          </div>

          <div className="o-card">
            <div className="o-card-body" style={{ padding: 0 }}>
              <div className="o-table-wrap">
                <table className="o-table">
                  <thead>
                    <tr>
                      {['Email', 'Provider', 'Status', 'Warmup', 'Daily Limit'].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedMailboxes.length === 0 ? (
                      <LoadingRow cols={5} msg={loadingClient ? 'Loading…' : 'No mailboxes found'} />
                    ) : (
                      sortedMailboxes.map((a) => (
                        <tr key={a._id || a.email}>
                          <td style={{ fontSize: 13, fontWeight: 500 }}>{a.email || '—'}</td>
                          <td style={{ fontSize: 12, color: '#6B7280' }}>{(a.provider || '—').replace('365', '')}</td>
                          <td><Badge status={a.status} /></td>
                          <td><Badge status={a.warmup_status} /></td>
                          <td>
                            <span style={{ fontFamily: 'Genos, sans-serif', fontSize: 17, fontWeight: 700, color: '#050C29' }}>
                              {a.payload?.daily_limit ?? '—'}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
