'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { cn } from '@/lib/utils'

// ── Types (match /api/health payload) ─────────────────────────────────────────
type HealthBand = 'green' | 'yellow' | 'amber' | 'red' | null

interface HealthAction {
  id: string
  workspace_id: string
  label: string
  kind: string | null
  rationale: string | null
  priority: number | null
  target_metric: string | null
  target_direction: string | null
  completed_at: string | null
  completed_by: string | null
  outcome: string | null
  outcome_notes: string | null
}

interface CopyAlert {
  id: string
  workspace_id: string
  campaign_name: string | null
  step: number | null
  variant: string | null
  alert_type: string | null
  severity: string | null
  reply_rate_baseline: number | null
  reply_rate_current: number | null
  lifetime_sends: number | null
  template_subject: string | null
}

interface Client {
  workspace_id: string
  workspace_name: string
  snapshot_date: string
  health_score: number | null
  health_band: HealthBand
  sent_7d: number | null
  sent_30d: number | null
  replies_7d: number | null
  replies_30d: number | null
  bounces_7d: number | null
  leads_7d: number | null
  leads_30d: number | null
  reply_rate_7d: number | null
  reply_rate_30d: number | null
  reply_rate_baseline: number | null
  bounce_rate_7d: number | null
  reply_rate_gmail_7d: number | null
  reply_rate_outlook_7d: number | null
  mailbox_total: number | null
  mailbox_unhealthy: number | null
  domain_unhealthy: number | null
  lead_target_monthly: number | null
  leads_mtd: number | null
  leads_expected_mtd: number | null
  pace_pct: number | null
  ai_briefing: string | null
  ai_briefing_source: string | null
  actions: HealthAction[]
  copy_alerts: CopyAlert[]
}

interface Payload {
  clients: Client[]
  generated_at: string | null
}

type View = 'all' | 'cm' | 'admin'
type Status = 'loading' | 'ok' | 'empty' | 'error'

// Infrastructure = mailboxes, domains, DNS, send volume, bounces.
const ADMIN_KINDS = new Set([
  'pause_mailbox', 'add_mailboxes', 'add_warmup', 'lower_send_volume',
  'check_dns', 'review_bounces',
])
// CM = content, copy, campaigns, lead gen.
const CM_KINDS = new Set([
  'refresh_copy', 'split_test_subject', 'add_followup_step', 'segment_rotation',
  'swap_offer', 'narrow_audience', 'pause_campaign',
])
function kindView(kind: string | null): View | 'neutral' {
  if (kind && ADMIN_KINDS.has(kind)) return 'admin'
  if (kind && CM_KINDS.has(kind)) return 'cm'
  return 'neutral'
}

// ── Format helpers ─────────────────────────────────────────────────────────────
const num = (v: number | null) => (v == null ? '—' : v.toLocaleString())
const pct = (v: number | null, d = 1) => (v == null ? '—' : (v * 100).toFixed(d) + '%')

function bandKey(b: HealthBand): 'green' | 'amber' | 'red' | 'na' {
  if (b === 'green') return 'green'
  if (b === 'yellow' || b === 'amber') return 'amber'
  if (b === 'red') return 'red'
  return 'na'
}
function bandLabel(b: HealthBand): string {
  return { green: 'Healthy', amber: 'Watch', red: 'Critical', na: 'No data' }[bandKey(b)]
}
function bandTone(b: HealthBand): StatusTone {
  return { green: 'ok', amber: 'warn', red: 'error', na: 'neutral' }[bandKey(b)] as StatusTone
}

// Human RR = replies / sent. Reply Rate (with OOO) is what the snapshot
// stores as reply_rate_7d; we surface Human RR alongside it.
function humanRR(c: Client): number | null {
  if (c.sent_7d == null || !c.sent_7d) return null
  return (c.replies_7d ?? 0) / c.sent_7d
}

function trend(current: number | null, baseline: number | null): React.ReactNode {
  if (current == null || baseline == null || baseline === 0) return null
  const delta = Math.round((current / baseline - 1) * 100)
  if (Math.abs(delta) < 5) return <span className="ml-1 text-[11px] font-semibold text-muted-foreground">flat</span>
  const down = delta < 0
  return (
    <span className={cn('ml-1 text-[11px] font-semibold', down ? 'text-red-500' : 'text-emerald-500')}>
      {down ? '↓' : '↑'}{Math.abs(delta)}%
    </span>
  )
}

// ── Signal tile ─────────────────────────────────────────────────────────────
function Signal({
  label, value, sub, view = 'neutral', currentView,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  view?: View | 'neutral'
  currentView: View
}) {
  if (currentView !== 'all' && view !== 'neutral' && view !== currentView) return null
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-bold tabular-nums text-foreground">{value}</div>
      {sub != null && sub !== '' && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function HealthPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [view, setView] = useState<View>('all')
  const [showHealthy, setShowHealthy] = useState(false)
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setStatus('loading')
    setErrMsg('')
    try {
      const r = await fetch('/api/health')
      const json: unknown = await r.json()
      if (!r.ok || (json && typeof json === 'object' && 'error' in json)) {
        throw new Error(
          json && typeof json === 'object' && 'error' in json
            ? String((json as { error: unknown }).error)
            : `Server returned ${r.status}`,
        )
      }
      const p = json as Payload
      if (!p.clients?.length) {
        setData(p)
        setStatus('empty')
        return
      }
      setData(p)
      setStatus('ok')
    } catch (e) {
      setStatus('error')
      setErrMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const clients = useMemo(() => {
    const list = data?.clients ?? []
    const order: Record<string, number> = { red: 0, amber: 1, green: 2, na: 3 }
    return [...list].sort((a, b) => {
      const ba = order[bandKey(a.health_band)]
      const bb = order[bandKey(b.health_band)]
      if (ba !== bb) return ba - bb
      return (a.health_score ?? 100) - (b.health_score ?? 100)
    })
  }, [data])

  const needAttention = clients.filter((c) => bandKey(c.health_band) === 'red' || bandKey(c.health_band) === 'amber')
  const healthy = clients.filter((c) => bandKey(c.health_band) === 'green')
  const openAlerts = clients.reduce((acc, c) => acc + c.copy_alerts.length, 0)

  async function callAction(url: string, body?: object) {
    setBusy((s) => new Set(s).add(url))
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      await load()
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy((s) => {
        const next = new Set(s)
        next.delete(url)
        return next
      })
    }
  }

  const toggleAction = (a: HealthAction) =>
    callAction(`/api/health/actions/${a.id}/${a.completed_at ? 'uncomplete' : 'complete'}`)
  const dismissAction = (a: HealthAction) => {
    const reason = window.prompt('Why skip this action? (optional)')
    if (reason === null) return
    callAction(`/api/health/actions/${a.id}/dismiss`, { reason })
  }
  const dismissAlert = (al: CopyAlert) => callAction(`/api/health/copy-alerts/${al.id}/dismiss`)

  const visibleCards = [...needAttention, ...(showHealthy ? healthy : [])]

  return (
    <PageShell
      title="Client Health"
      subtitle="Daily AI briefing per client · score · band · signals · next actions"
      freshness={{ table: 'client_health_snapshots', syncedAt: data?.generated_at ?? null }}
      actions={
        <button
          onClick={() => load()}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          Refresh
        </button>
      }
    >
      {/* KPI stripe */}
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Need attention" value={num(needAttention.length)} tone={needAttention.length ? 'red' : 'green'} loading={status === 'loading'} />
        <KpiCard label="Healthy" value={num(healthy.length)} tone="green" loading={status === 'loading'} />
        <KpiCard label="No data yet" value={num(clients.filter((c) => bandKey(c.health_band) === 'na').length)} tone="yellow" loading={status === 'loading'} />
        <KpiCard label="Open copy alerts" value={num(openAlerts)} tone={openAlerts ? 'yellow' : 'green'} loading={status === 'loading'} />
      </div>

      {/* View toggle: Admin sees infra signals/actions, CM sees content/copy */}
      <div className="mb-5 inline-flex rounded-lg border border-border bg-card p-0.5">
        {(['all', 'cm', 'admin'] as View[]).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={cn(
              'rounded-md px-4 py-1.5 text-xs font-semibold transition',
              view === v ? 'bg-[var(--chart-1)] text-white' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {v === 'all' ? 'All' : v === 'cm' ? 'Campaign Manager' : 'Infrastructure'}
          </button>
        ))}
      </div>

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load client health</div>
          <div className="mt-0.5 opacity-90">{errMsg}</div>
          <button
            onClick={() => load()}
            className="mt-2 rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium hover:bg-destructive/10"
          >
            Retry
          </button>
        </div>
      )}

      {status === 'empty' && (
        <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
          <div className="font-semibold text-foreground">No health snapshot yet.</div>
          The first daily build runs each morning at 7am.
        </div>
      )}

      {(status === 'ok' || status === 'loading') && (
        <div className="flex flex-col gap-4">
          {status === 'loading' && (
            <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
              Loading client health…
            </div>
          )}

          {visibleCards.map((c) => (
            <ClientCard
              key={c.workspace_id}
              c={c}
              view={view}
              busy={busy}
              onToggleAction={toggleAction}
              onDismissAction={dismissAction}
              onDismissAlert={dismissAlert}
            />
          ))}

          {status === 'ok' && healthy.length > 0 && (
            <div className="py-2 text-center">
              <button
                onClick={() => setShowHealthy((s) => !s)}
                className="rounded-md border border-dashed border-border px-3.5 py-1.5 text-xs text-muted-foreground hover:bg-muted"
              >
                {showHealthy ? 'Hide' : 'Show'} {healthy.length} healthy {healthy.length === 1 ? 'client' : 'clients'}
              </button>
            </div>
          )}

          {status === 'ok' && visibleCards.length === 0 && (
            <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center text-sm text-muted-foreground">
              <div className="font-semibold text-foreground">All clients are healthy today.</div>
              Nothing needs attention right now.
            </div>
          )}
        </div>
      )}
    </PageShell>
  )
}

// ── Client card ───────────────────────────────────────────────────────────────
function ClientCard({
  c, view, busy, onToggleAction, onDismissAction, onDismissAlert,
}: {
  c: Client
  view: View
  busy: Set<string>
  onToggleAction: (a: HealthAction) => void
  onDismissAction: (a: HealthAction) => void
  onDismissAlert: (a: CopyAlert) => void
}) {
  const bk = bandKey(c.health_band)
  const borderColor =
    bk === 'red' ? 'border-l-red-500' : bk === 'amber' ? 'border-l-amber-500' : bk === 'green' ? 'border-l-emerald-500' : 'border-l-border'
  const scoreColor =
    bk === 'red' ? 'text-red-500' : bk === 'amber' ? 'text-amber-500' : bk === 'green' ? 'text-emerald-500' : 'text-muted-foreground'

  const src = c.ai_briefing_source
  const briefingSource =
    src === 'ai' ? 'AI briefing (Claude)'
    : src === 'fallback_api_failed' ? 'Fallback — Claude API call failed'
    : src === 'fallback_no_key' ? 'Fallback — ANTHROPIC_API_KEY not set'
    : 'Auto-generated'

  return (
    <div className={cn('overflow-hidden rounded-xl border border-l-4 border-border bg-card', borderColor)}>
      {/* head */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="min-w-0">
          <div className="text-lg font-bold text-foreground">{c.workspace_name}</div>
          <div className="text-[11px] text-muted-foreground">
            Snapshot {new Date(c.snapshot_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </div>
        </div>
        <div className="flex items-baseline gap-2">
          <span className={cn('text-3xl font-extrabold tabular-nums', scoreColor)}>{c.health_score ?? '—'}</span>
          <StatusBadge status={bandTone(c.health_band)}>{bandLabel(c.health_band)}</StatusBadge>
        </div>
      </div>

      <div className="px-5 pb-5">
        {/* AI briefing */}
        <div className="mb-3 rounded-lg border border-border bg-muted/30 p-4 text-[13.5px] leading-relaxed text-foreground">
          {c.ai_briefing || <span className="italic text-muted-foreground">No briefing.</span>}
          <span className="mt-2 block text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
            {briefingSource}
          </span>
        </div>

        {/* Inline copy alerts (CM view) */}
        {c.copy_alerts.length > 0 && (view === 'all' || view === 'cm') && (
          <div className="mb-3">
            <div className="mb-2 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
              ⚠ Needs fresh copy
              <span className="font-normal normal-case opacity-70">{c.copy_alerts.length} flagged</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {c.copy_alerts.map((a) => (
                <CopyAlertRow key={a.id} a={a} busy={busy} onDismiss={onDismissAlert} />
              ))}
            </div>
          </div>
        )}

        {/* Signals */}
        <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {c.lead_target_monthly != null && c.lead_target_monthly > 0 && (
            <PaceTile c={c} currentView={view} />
          )}
          <Signal label="Sent 7d" value={num(c.sent_7d)} currentView={view} />
          <Signal label="Sent 30d" value={num(c.sent_30d)} currentView={view} />
          <Signal
            label="Replies 7d"
            value={<>{num(c.replies_7d)}{trend(c.reply_rate_7d, c.reply_rate_baseline)}</>}
            view="cm"
            currentView={view}
          />
          <Signal
            label="Reply rate 7d"
            value={pct(c.reply_rate_7d, 2)}
            sub={c.reply_rate_baseline != null ? `vs ${pct(c.reply_rate_baseline, 2)} baseline` : ''}
            view="cm"
            currentView={view}
          />
          <Signal
            label="Human RR 7d"
            value={pct(humanRR(c), 2)}
            sub="replies / sent"
            view="cm"
            currentView={view}
          />
          <Signal
            label="Bounce rate 7d"
            value={pct(c.bounce_rate_7d, 1)}
            sub={c.bounce_rate_7d != null && c.bounce_rate_7d > 0.03 ? <span className="font-bold text-red-500">elevated</span> : ''}
            view="admin"
            currentView={view}
          />
          <Signal label="Leads 7d" value={num(c.leads_7d)} view="cm" currentView={view} />
          <Signal label="Leads 30d" value={num(c.leads_30d)} view="cm" currentView={view} />
          <Signal
            label="Mailboxes"
            value={c.mailbox_total ? `${c.mailbox_unhealthy ?? 0}/${c.mailbox_total}` : '—'}
            sub={c.mailbox_unhealthy != null && c.mailbox_unhealthy > 0 ? <span className="font-semibold text-amber-500">unhealthy</span> : ''}
            view="admin"
            currentView={view}
          />
          <Signal
            label="Domains"
            value={c.domain_unhealthy != null ? num(c.domain_unhealthy) : '—'}
            sub={c.domain_unhealthy != null && c.domain_unhealthy > 0 ? <span className="font-semibold text-amber-500">unhealthy</span> : ''}
            view="admin"
            currentView={view}
          />
          {c.reply_rate_gmail_7d != null && (
            <Signal label="Gmail reply" value={pct(c.reply_rate_gmail_7d, 2)} view="admin" currentView={view} />
          )}
          {c.reply_rate_outlook_7d != null && (
            <Signal label="Outlook reply" value={pct(c.reply_rate_outlook_7d, 2)} view="admin" currentView={view} />
          )}
        </div>

        {/* Actions */}
        <ActionsPanel
          actions={c.actions}
          view={view}
          busy={busy}
          onToggle={onToggleAction}
          onDismiss={onDismissAction}
        />
      </div>
    </div>
  )
}

function PaceTile({ c, currentView }: { c: Client; currentView: View }) {
  if (currentView === 'admin') return null
  const pace = c.pace_pct
  const mtd = c.leads_mtd ?? 0
  const target = c.lead_target_monthly ?? 0
  const expected = c.leads_expected_mtd != null ? c.leads_expected_mtd.toFixed(1) : '—'
  let color = 'text-foreground'
  let badge: React.ReactNode = null
  if (pace != null) {
    if (pace < 0.65) { color = 'text-red-500'; badge = <span className="font-bold text-red-500">↓{Math.round((1 - pace) * 100)}% behind</span> }
    else if (pace < 0.85) { color = 'text-amber-500'; badge = <span className="font-semibold text-amber-500">behind pace</span> }
    else if (pace > 1.1) { color = 'text-emerald-500'; badge = <span className="font-semibold text-emerald-500">ahead</span> }
    else badge = <span className="text-muted-foreground">on pace</span>
  }
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Lead pace MTD</div>
      <div className={cn('mt-0.5 text-sm font-bold tabular-nums', color)}>
        {mtd}<span className="font-medium text-muted-foreground">/{target}</span>
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{expected} expected · {badge}</div>
    </div>
  )
}

function CopyAlertRow({
  a, busy, onDismiss,
}: {
  a: CopyAlert
  busy: Set<string>
  onDismiss: (a: CopyAlert) => void
}) {
  const dismissing = busy.has(`/api/health/copy-alerts/${a.id}/dismiss`)
  const dropPct =
    a.reply_rate_baseline && a.reply_rate_current != null && a.reply_rate_baseline > 0
      ? Math.round((1 - a.reply_rate_current / a.reply_rate_baseline) * 100)
      : null
  const summary =
    a.alert_type === 'decay' || a.alert_type === 'copy_stale'
      ? `${pct(a.reply_rate_current, 2)} reply${dropPct != null ? ` (↓${dropPct}%)` : ''} vs ${pct(a.reply_rate_baseline, 2)} avg · ${num(a.lifetime_sends)} sends`
      : `${num(a.lifetime_sends)} lifetime sends`
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-300/50 bg-amber-50 px-3 py-2.5 dark:bg-amber-500/10">
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-foreground">
          {a.campaign_name || 'Unknown campaign'}{a.step != null ? ` · Step ${a.step}` : ''}
        </div>
        {a.template_subject && (
          <div className="mt-0.5 truncate text-[11px] font-medium text-foreground">“{a.template_subject.slice(0, 70)}”</div>
        )}
        <div className="mt-0.5 text-[11px] text-muted-foreground">{summary}</div>
      </div>
      <div className="flex flex-shrink-0 items-start gap-1.5">
        <StatusBadge status={a.severity === 'critical' ? 'error' : 'warn'}>
          {(a.alert_type || 'alert').replace(/_/g, ' ')}
        </StatusBadge>
        <button
          onClick={() => onDismiss(a)}
          disabled={dismissing}
          className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

function ActionsPanel({
  actions, view, busy, onToggle, onDismiss,
}: {
  actions: HealthAction[]
  view: View
  busy: Set<string>
  onToggle: (a: HealthAction) => void
  onDismiss: (a: HealthAction) => void
}) {
  const visible = actions.filter((a) => {
    const av = kindView(a.kind)
    return view === 'all' || av === 'neutral' || av === view
  })
  if (!actions.length) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[12px] italic text-muted-foreground">
        No open actions — hit Refresh to regenerate.
      </div>
    )
  }
  const done = actions.filter((a) => a.completed_at).length
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-1">
      <div className="flex items-center justify-between px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
        <span>Next actions</span>
        <span className="text-foreground">{done}/{actions.length} done</span>
      </div>
      {visible.length === 0 ? (
        <div className="px-3 py-2 text-[12px] italic text-muted-foreground">No actions for this view.</div>
      ) : (
        visible.map((a) => (
          <ActionRow key={a.id} a={a} busy={busy} onToggle={onToggle} onDismiss={onDismiss} />
        ))
      )}
    </div>
  )
}

function ActionRow({
  a, busy, onToggle, onDismiss,
}: {
  a: HealthAction
  busy: Set<string>
  onToggle: (a: HealthAction) => void
  onDismiss: (a: HealthAction) => void
}) {
  const done = !!a.completed_at
  const pri = Math.max(1, Math.min(3, a.priority || 2))
  const rowBusy =
    busy.has(`/api/health/actions/${a.id}/complete`) ||
    busy.has(`/api/health/actions/${a.id}/uncomplete`) ||
    busy.has(`/api/health/actions/${a.id}/dismiss`)
  const kindLabel = (a.kind || '').replace(/_/g, ' ')
  const targetLabel = a.target_metric
    ? `${a.target_metric}${a.target_direction === 'up' ? ' ↑' : a.target_direction === 'down' ? ' ↓' : ''}`
    : ''
  const outcome = a.outcome
  const pendingEval = done && !outcome
  const outcomeLabel =
    outcome === 'helped' ? '✓ Helped'
    : outcome === 'worse' ? '✗ Worse'
    : outcome === 'no_change' ? '— No change'
    : outcome === 'inconclusive' ? '? Inconclusive'
    : pendingEval ? '… Evaluating'
    : ''
  const outcomeTone: StatusTone =
    outcome === 'helped' ? 'ok' : outcome === 'worse' ? 'error' : pendingEval ? 'warn' : 'neutral'
  const priClass =
    pri === 1 ? 'bg-red-500/15 text-red-500' : pri === 2 ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-violet-500/15 text-violet-500'

  return (
    <div className={cn('grid grid-cols-[auto_1fr_auto] items-start gap-2.5 rounded-md px-3 py-2.5 hover:bg-card', done && 'opacity-60')}>
      <button
        onClick={() => onToggle(a)}
        disabled={rowBusy}
        title={done ? 'Mark not done' : 'Mark done'}
        className={cn(
          'mt-0.5 flex h-[18px] w-[18px] items-center justify-center rounded border-2 text-[12px] font-bold transition disabled:opacity-50',
          done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border bg-card hover:border-[var(--chart-1)]',
        )}
      >
        {done ? '✓' : ''}
      </button>
      <div className="min-w-0">
        <div className={cn('text-[13px] font-semibold leading-snug text-foreground', done && 'text-muted-foreground line-through')}>
          {a.label}
        </div>
        {a.rationale && <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{a.rationale}</div>}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {kindLabel && <span className="rounded bg-muted px-1.5 py-0.5 font-semibold text-foreground">{kindLabel}</span>}
          {targetLabel && <span>target: {targetLabel}</span>}
          {done && <span className="italic">done by {a.completed_by || 'someone'}</span>}
        </div>
        {outcome && a.outcome_notes && <div className="mt-1 text-[11px] italic text-muted-foreground">{a.outcome_notes}</div>}
      </div>
      <div className="flex flex-col items-end gap-1">
        {outcomeLabel ? (
          <StatusBadge status={outcomeTone}>{outcomeLabel}</StatusBadge>
        ) : (
          <span className={cn('rounded px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide', priClass)}>P{pri}</span>
        )}
        {!done && (
          <button
            onClick={() => onDismiss(a)}
            disabled={rowBusy}
            className="text-[11px] text-muted-foreground hover:text-red-500 hover:underline disabled:opacity-50"
          >
            skip
          </button>
        )}
      </div>
    </div>
  )
}
