'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { cn } from '@/lib/utils'

type Client = {
  workspaceId: string
  company: string
  target: number | null
  mailboxes: number
  capacityPerDay: number
  capacityWindow: number
  avgLimit: number
  sent: number
  avgDailySend: number
  humanReplies: number
  leads: number
  responseRate: number | null
  rtl: number | null
  rtlWindow: 'window' | '90d' | null
  utilisation: number | null
  expectedLeads: number | null
  projectedLeads: number | null
  sendsNeeded: number | null
  capacityGapPerDay: number | null
  mailboxesNeeded: number | null
  verdict: {
    code: 'no_target' | 'building' | 'under_utilised' | 'on_track' | 'needs_more'
    label: string
  }
}

const WINDOWS = [7, 30, 60, 90] as const
type Win = (typeof WINDOWS)[number]

const num = (n: number) => n.toLocaleString('en-GB')
const dec = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: 0 })
const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`)
const one = (n: number | null) => (n === null ? '—' : n.toFixed(1))
const int = (n: number | null) => (n === null ? '—' : Math.round(n).toLocaleString('en-GB'))

export default function ResourceCalcPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [days, setDays] = useState<Win>(30)
  const [sendDataDays, setSendDataDays] = useState(30)
  const [sendLimited, setSendLimited] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  const load = useCallback(async (windowDays: Win) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/resource-calc?days=${windowDays}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setClients(data.clients ?? [])
      setSendDataDays(data.sendDataDays ?? 30)
      setSendLimited(Boolean(data.sendDataLimited))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(days)
  }, [load, days])

  // Full PlusVibe → mailbox_full sync. It fetches per-mailbox stats for ~2.8k
  // mailboxes (~6 min), so we DON'T hold the request: POST kicks it off in the
  // background, then we poll mailbox_sync_state until it's done and reload.
  const syncMailboxes = useCallback(async () => {
    setSyncing(true)
    setSyncMsg('Syncing mailboxes from PlusVibe… this runs in the background (a few minutes).')
    try {
      const r = await fetch('/api/resource-calc/sync', { method: 'POST' })
      const d = await r.json()
      if (!d.ok) {
        setSyncMsg(`Could not start sync: ${d.error ?? 'unknown error'}`)
        setSyncing(false)
        return
      }

      // Poll status until running flips false (or we give up after ~10 min).
      const startedAt = Date.now()
      const poll = async (): Promise<void> => {
        const s = await fetch('/api/resource-calc/sync').then((res) => res.json())
        if (!s.running) {
          if (s.lastError) {
            setSyncMsg(`Sync failed: ${s.lastError}`)
          } else {
            setSyncMsg(`Synced ${s.count ?? ''} mailboxes.`)
            await load(days)
          }
          setSyncing(false)
          return
        }
        if (Date.now() - startedAt > 10 * 60 * 1000) {
          setSyncMsg('Sync is taking longer than expected — it will keep running; hit Refresh shortly.')
          setSyncing(false)
          return
        }
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        setSyncMsg(`Syncing mailboxes from PlusVibe… ${elapsed}s elapsed.`)
        setTimeout(poll, 4000)
      }
      setTimeout(poll, 4000)
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : String(e))
      setSyncing(false)
    }
  }, [load, days])

  const saveTarget = useCallback(async (workspaceId: string, value: number | null) => {
    setClients((prev) =>
      prev.map((c) => (c.workspaceId === workspaceId ? { ...c, target: value } : c)),
    )
    await fetch('/api/resource-calc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId, monthly_lead_target: value }),
    })
    // refetch so verdict / mailboxes-needed reflect the new target (windowed)
    load(days)
  }, [load, days])

  const totals = useMemo(() => {
    const t = { mailboxes: 0, capacityPerDay: 0, avgDailySend: 0, sent: 0, leads: 0, needMore: 0, underUsed: 0 }
    for (const c of clients) {
      t.mailboxes += c.mailboxes
      t.capacityPerDay += c.capacityPerDay
      t.avgDailySend += c.avgDailySend
      t.sent += c.sent
      t.leads += c.leads
      if (c.verdict.code === 'needs_more') t.needMore++
      if (c.verdict.code === 'under_utilised') t.underUsed++
    }
    return t
  }, [clients])

  return (
    <PageShell
      title="Resource Calc"
      subtitle="Per-client sending capacity vs. lead target — who's under-using resource and who needs more."
      actions={
        <div className="flex items-center gap-2">
          <WindowToggle value={days} onChange={setDays} disabled={syncing} />
          {syncMsg && <span className="text-xs text-muted-foreground">{syncMsg}</span>}
          <button
            onClick={syncMailboxes}
            disabled={syncing}
            className="rounded-lg bg-[var(--chart-2)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
            title="Pull the latest mailbox settings from PlusVibe (slow — a few minutes), then reload"
          >
            {syncing ? 'Syncing…' : '↻ Sync mailboxes'}
          </button>
          <button
            onClick={() => load(days)}
            disabled={syncing}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
            title="Recompute from the current cached data (fast)"
          >
            Refresh
          </button>
        </div>
      }
    >
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Active clients" value={loading ? '—' : clients.length} tone="navy" loading={loading} />
        <KpiCard label="Mailboxes" value={loading ? '—' : num(totals.mailboxes)} sub="total across clients" tone="teal" loading={loading} />
        <KpiCard label="Capacity / day" value={loading ? '—' : num(totals.capacityPerDay)} sub={`sending ${dec(totals.avgDailySend)}/day avg`} tone="purple" loading={loading} />
        <KpiCard label="Under-utilised" value={loading ? '—' : totals.underUsed} sub="have resource, not sending" tone="yellow" loading={loading} />
        <KpiCard label="Need more" value={loading ? '—' : totals.needMore} sub="can't hit target" tone="red" loading={loading} />
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {sendLimited && (
        <div className="mb-4 rounded-lg border border-[var(--chart-4)]/40 bg-[var(--chart-4)]/10 px-3 py-2 text-xs text-[var(--chart-4)]">
          Send &amp; reply history only goes back ~{sendDataDays} days, so over this {days}-day window
          the <strong>Sent</strong>, <strong>Avg/day</strong>, <strong>Utilisation</strong> and{' '}
          <strong>Response rate</strong> figures cover the available data only (leads go back further).
          These fill in as more history accumulates.
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[1200px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
              <Th className="text-left">Client</Th>
              <Th title="Mailboxes × their configured daily send limit">Max speed<br />/day</Th>
              <Th title={`Emails actually sent in the last ${days} days`}>Sent {days}d</Th>
              <Th title={`Average emails sent per day over the ${days}-day window`}>Avg /day</Th>
              <Th title={`Sent ÷ (max speed × ${days}). How much of capacity they're using.`}>Utilisation</Th>
              <Th title={`Human replies ÷ sent, last ${days} days (out-of-office auto-replies excluded)`}>Resp. rate</Th>
              <Th title="Replies per lead — measured from real data">RTL</Th>
              <Th title={`Leads (INTERESTED) in the last ${days} days`}>Leads {days}d</Th>
              <Th title="Editable — monthly lead target (verdict scales it to the window)">Target /mo</Th>
              <Th title="Leads they'd get at FULL capacity over this window, at current rate & RTL">Exp. @ full</Th>
              <Th className="text-left" title="Recommendation">Verdict</Th>
            </tr>
          </thead>
          <tbody>
            {loading && clients.length === 0 ? (
              <tr><td colSpan={11} className="px-4 py-10 text-center text-muted-foreground">Loading…</td></tr>
            ) : (
              clients.map((c) => <Row key={c.workspaceId} c={c} onSaveTarget={saveTarget} />)
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Max speed = Σ per-mailbox daily limit (PlusVibe). Sent, avg/day, response rate, RTL and leads are
        measured over the selected window (RTL widens to 90 days when a client has too few leads for a
        reliable ratio). Utilisation and expected leads scale capacity to the window. The monthly target is
        scaled to the window when producing the verdict.
      </p>
    </PageShell>
  )
}

function WindowToggle({ value, onChange, disabled }: { value: Win; onChange: (w: Win) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-border">
      {WINDOWS.map((w) => (
        <button
          key={w}
          onClick={() => onChange(w)}
          disabled={disabled}
          className={cn(
            'px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60',
            w === value
              ? 'bg-[var(--chart-1)] text-white'
              : 'bg-background text-muted-foreground hover:bg-muted',
          )}
        >
          {w}d
        </button>
      ))}
    </div>
  )
}

function Th({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <th title={title} className={cn('px-3 py-2.5 text-right font-semibold', className)}>
      {children}
    </th>
  )
}

const VERDICT_STYLE: Record<Client['verdict']['code'], string> = {
  needs_more: 'bg-destructive/15 text-destructive',
  under_utilised: 'bg-[var(--chart-4)]/15 text-[var(--chart-4)]',
  on_track: 'bg-[var(--chart-5)]/15 text-[var(--chart-5)]',
  building: 'bg-muted text-muted-foreground',
  no_target: 'bg-muted text-muted-foreground',
}

function Row({ c, onSaveTarget }: { c: Client; onSaveTarget: (ws: string, v: number | null) => void }) {
  const [draft, setDraft] = useState(c.target?.toString() ?? '')
  useEffect(() => { setDraft(c.target?.toString() ?? '') }, [c.target])

  const commit = () => {
    const trimmed = draft.trim()
    const next = trimmed === '' ? null : Math.max(0, Math.round(Number(trimmed)))
    const cur = c.target ?? null
    if (next !== cur && (trimmed === '' || Number.isFinite(next))) {
      onSaveTarget(c.workspaceId, next)
    }
  }

  const utilLow = c.utilisation !== null && c.utilisation < 0.5
  return (
    <tr className="border-b border-border/60 last:border-0 hover:bg-muted/40">
      <td className="px-3 py-2.5 text-left font-medium text-foreground">{c.company}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        {num(c.capacityPerDay)}
        <span className="ml-1 text-[11px] text-muted-foreground">({c.mailboxes}mb)</span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{num(c.sent)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums font-medium">{dec(c.avgDailySend)}</td>
      <td className={cn('px-3 py-2.5 text-right tabular-nums', utilLow && 'text-[var(--chart-4)]')}>
        {pct(c.utilisation)}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{pct(c.responseRate)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        {one(c.rtl)}
        {c.rtlWindow === '90d' && <span className="ml-1 text-[10px] text-muted-foreground">90d</span>}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{c.leads}</td>
      <td className="px-3 py-2.5 text-right">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          placeholder="—"
          inputMode="numeric"
          className="h-7 w-16 rounded-md border border-input bg-transparent px-2 text-right text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{int(c.expectedLeads)}</td>
      <td className="px-3 py-2.5 text-left">
        <span className={cn('inline-block rounded-md px-2 py-1 text-[11px] font-semibold', VERDICT_STYLE[c.verdict.code])}>
          {c.verdict.label}
        </span>
      </td>
    </tr>
  )
}
