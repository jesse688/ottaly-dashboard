'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'

interface WorkspaceRow {
  workspace_id: string
  workspace_name: string
  status: string
  sent: number
  replyRate: number
  leads: number
}

const num = (n: number) => (n || 0).toLocaleString()
const pct = (n: number) => (isNaN(n) ? '—' : (n * 100).toFixed(1) + '%')
function rrTone(rr: number) { return rr >= 0.025 ? 'ok' : rr >= 0.01 ? 'warn' : 'error' as const }

export default function Home() {
  const [rows, setRows] = useState<WorkspaceRow[]>([])
  const [totals, setTotals] = useState({ sent: 0, replies: 0, oooReplies: 0, leads: 0 })
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  useEffect(() => {
    const end = new Date().toISOString().slice(0, 10)
    const start = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    fetch(`/api/stats/summary?start=${start}&end=${end}`)
      .then(r => r.json())
      .then((s) => {
        if (s.error) throw new Error(s.error)
        const ws = (s.workspaces || []) as Array<{ workspace_id: string; name: string; totals: { sent: number; replies: number; oooReplies: number; leads: number } }>
        const t = ws.reduce((a, w) => ({
          sent: a.sent + (w.totals?.sent || 0),
          replies: a.replies + (w.totals?.replies || 0),
          oooReplies: a.oooReplies + (w.totals?.oooReplies || 0),
          leads: a.leads + (w.totals?.leads || 0),
        }), { sent: 0, replies: 0, oooReplies: 0, leads: 0 })
        setTotals(t)
        setRows(ws.map(w => ({
          workspace_id: w.workspace_id,
          workspace_name: w.name,
          status: 'active',
          sent: w.totals?.sent || 0,
          replyRate: w.totals?.sent > 0 ? w.totals.replies / w.totals.sent : 0,
          leads: w.totals?.leads || 0,
        })))
        setUpdatedAt(s.updatedAt ?? null)
        setStatus('ok')
      })
      .catch(() => setStatus('error'))
  }, [])

  const replyRate = totals.sent > 0 ? totals.replies / totals.sent : 0 // Human RR
  const allReplyRate = totals.sent > 0 ? (totals.replies + totals.oooReplies) / totals.sent : 0 // incl. OOO/auto
  const activeClients = rows.length

  const columns: Column<WorkspaceRow>[] = [
    { key: 'name', header: 'Workspace', sortValue: w => w.workspace_name.toLowerCase(), cell: w => <span className="font-semibold text-foreground">{w.workspace_name}</span> },
    { key: 'status', header: 'Status', cell: () => <StatusBadge status="info">Active</StatusBadge> },
    { key: 'sent', header: 'Sent', numeric: true, sortValue: w => w.sent, cell: w => num(w.sent) },
    { key: 'rr', header: 'Reply Rate', numeric: true, sortValue: w => w.replyRate, cell: w => <StatusBadge status={rrTone(w.replyRate)}>{pct(w.replyRate)}</StatusBadge> },
    { key: 'leads', header: 'Leads', numeric: true, sortValue: w => w.leads, cell: w => num(w.leads) },
  ]

  return (
    <PageShell
      title="Agency Dashboard"
      subtitle={`Last 30 days · ${status === 'loading' ? '…' : `${rows.length} workspaces`}`}
      freshness={{ table: 'workspace_stats', syncedAt: updatedAt }}
    >
      {/* Human RR (real replies) + Reply Rate (incl. OOO/auto); warmup excluded. */}
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Emails Sent" value={num(totals.sent)} tone="navy" loading={status === 'loading'} />
        <KpiCard label="Human RR" value={pct(replyRate)} sub="real replies" tone="teal" loading={status === 'loading'} />
        <KpiCard label="Reply Rate" value={pct(allReplyRate)} sub="incl. OOO/auto" tone="purple" loading={status === 'loading'} />
        <KpiCard label="Leads Generated" value={num(totals.leads)} tone="green" loading={status === 'loading'} />
        <KpiCard label="Active Clients" value={activeClients} tone="yellow" loading={status === 'loading'} />
      </div>

      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          Couldn’t load the dashboard. Check the data sync and try again.
        </div>
      )}

      {status !== 'error' && (
        <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-foreground">Workspaces</h2>
                <p className="text-xs text-muted-foreground">Sorted by sends (30 days)</p>
              </div>
              <Link href="/stats" className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                Full stats <ArrowRight size={12} />
              </Link>
            </div>
            <DataTable
              columns={columns}
              rows={[...rows].sort((a, b) => b.sent - a.sent)}
              getRowKey={w => w.workspace_id}
              empty={status === 'loading' ? 'Loading…' : 'No workspaces.'}
            />
          </div>

          <div className="flex flex-col gap-4">
            <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
              <div className="border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-bold text-foreground">Quick Links</h2>
              </div>
              {[
                { href: '/actions', label: 'Actions' },
                { href: '/finance', label: 'Finance' },
                { href: '/clients', label: 'Clients' },
                { href: '/mailboxes', label: 'Mailboxes' },
                { href: '/domains', label: 'Domains' },
              ].map((l, i, arr) => (
                <Link key={l.href} href={l.href} className={`flex items-center justify-between px-4 py-2.5 text-[13px] text-foreground transition-colors hover:bg-accent ${i < arr.length - 1 ? 'border-b border-border/60' : ''}`}>
                  {l.label}
                  <ArrowRight size={12} className="text-muted-foreground" />
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </PageShell>
  )
}
