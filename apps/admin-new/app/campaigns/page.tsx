'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// ── Types ──────────────────────────────────────────────────────────────────

interface Flag {
  type: 'critical' | 'warning' | 'top' | 'info'
  msg: string
}

interface VariantInsight {
  msg: string
}

interface Variation {
  variation: string
  name: string
  sent: number
  reply: number
  pos_reply: number
}

interface VariationStep {
  step: number
  variations: Variation[]
}

interface StepReply {
  step: number
  sent: number
  replies: number
}

interface Campaign {
  id: string
  name: string
  status: string
  sent: number
  replies: number
  replyRate: number
  posReplies: number
  negReplies: number
  neutralReplies?: number
  bounces: number
  leads: number
  tier: 'top' | 'good' | 'warning' | 'critical' | 'new'
  exhaustion: number
  leadContacted: number
  dataSize?: number
  lastReplied?: string
  flags: Flag[]
  variantInsights: VariantInsight[]
  variationSteps?: VariationStep[]
  stepReplies?: StepReply[]
}

interface Workspace {
  id: string
  name: string
  avgReplyRate: number
  activeCampaigns: number
  totalSent: number
  campaigns: Campaign[]
}

interface TargetingPattern {
  titleKey?: string
  sizeKey?: string
  kwKey?: string
  avgReplyRate: number
  count: number
  totalSent: number
  campaigns: { wsName: string }[]
}

interface Optimisation {
  wsId: string
  campId: string
  wsName: string
  campName: string
  step: number
  confidence: 'high' | 'medium'
  winner: { variation: string; rate: number; reply: number; sent: number }
  losers: { variation: string; rate: number }[]
}

interface IntelligenceData {
  workspaces: Workspace[]
  targetingPatterns: TargetingPattern[]
  optimisations: Optimisation[]
  updatedAt: string | null
}

type SortKey = 'sent' | 'exhaustion' | 'replyRate' | 'bounceRate' | 'positivePct' | 'leads'

// ── Helpers ───────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function shortName(name: string): string {
  const cleaned = name.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
  return cleaned.length > 55 ? cleaned.slice(0, 55) + '…' : cleaned || name.slice(0, 55)
}

function parseApolloUrl(name: string) {
  const match = name.match(/https?:\/\/app\.apollo\.io[^\s]*/)
  if (!match) return null
  try {
    const raw = match[0]
    const qPart = raw.includes('?') ? raw.split('?')[1] : ''
    if (!qPart) return null
    const p = new URLSearchParams(qPart)
    const get = (key: string) => p.getAll(key).map(v => decodeURIComponent(v).replace(/\+/g, ' '))
    const clean = (s: string) => s.replace(/%2C/gi, ',').replace(/%20/gi, ' ').trim()
    const sizeMap: Record<string, string> = {
      '1,10': '1-10', '11,20': '11-20', '21,50': '21-50', '51,100': '51-100',
      '101,200': '101-200', '201,500': '201-500', '501,1000': '501-1k', '1001,5000': '1k-5k',
    }
    const sizes = get('organizationNumEmployeesRanges').map(s => sizeMap[s] ?? s)
    const titles = get('personTitles')
    const seniority = get('personSeniorities')
    const allLocs = [...new Set([
      ...get('personLocations').map(clean),
      ...get('organizationLocations').map(clean),
      ...get('accounthqLocations').map(clean),
    ])]
    const inclKws = get('qOrganizationKeywordTags')
    const exclKws = get('qNotOrganizationKeywordTags')
    const emailStatus = get('contactEmailStatusV2')
    return { titles, seniority, sizes, locations: allLocs, inclKws, exclKws, emailStatus, url: raw }
  } catch {
    return null
  }
}

function apolloSummaryLine(name: string): string {
  const a = parseApolloUrl(name)
  if (!a) return ''
  const parts: string[] = []
  if (a.titles.length) parts.push(a.titles.slice(0, 3).join(', '))
  else if (a.seniority.length) parts.push(a.seniority.slice(0, 3).join(', '))
  if (a.sizes.length) parts.push(a.sizes.join(', ') + ' emp')
  if (a.locations.length) parts.push(a.locations.slice(0, 4).join(', '))
  if (a.inclKws.length) parts.push(a.inclKws.slice(0, 3).join(', '))
  return parts.join(' · ')
}

function campaignSortValue(c: Campaign, key: SortKey): number {
  switch (key) {
    case 'sent': return c.sent || 0
    case 'exhaustion': return c.exhaustion || 0
    case 'replyRate': return c.sent >= 50 ? (c.replyRate || 0) : -Infinity
    case 'bounceRate': return c.sent >= 50 ? ((c.bounces || 0) / Math.max(c.sent, 1)) : -Infinity
    case 'positivePct': return c.replies > 0 ? ((c.posReplies || 0) / c.replies) : -Infinity
    case 'leads': return c.leads || 0
    default: return 0
  }
}

function tierColor(tier: string): string {
  switch (tier) {
    case 'top': return '#059669'
    case 'good': return '#10B981'
    case 'warning': return '#D97706'
    case 'critical': return '#DC2626'
    default: return '#9CA3AF'
  }
}

// ── Sub-components ────────────────────────────────────────────────────────

function SummaryCards({ data }: { data: IntelligenceData }) {
  const all = data.workspaces.flatMap(w => w.campaigns)
  const withData = all.filter(c => c.sent >= 50)
  const avgReply = withData.length
    ? withData.reduce((s, c) => s + c.replyRate, 0) / withData.length
    : 0

  const cards = [
    { label: 'Total Campaigns', value: all.length, accent: '#224388' },
    { label: 'Active', value: all.filter(c => c.status === 'ACTIVE').length, accent: '#1F6F78' },
    { label: 'Top Performers', value: all.filter(c => c.tier === 'top').length, accent: '#059669' },
    { label: 'Need Attention', value: all.filter(c => c.tier === 'warning').length, accent: '#D97706' },
    { label: 'Critical', value: all.filter(c => c.tier === 'critical').length, accent: '#DC2626' },
    { label: 'Avg Reply Rate', value: (avgReply * 100).toFixed(2) + '%', accent: '#224388' },
  ]

  return (
    <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
      {cards.map(c => (
        <div
          key={c.label}
          className="bg-white rounded-[10px] border border-[#E2E6F0] px-[1.1rem] py-[0.9rem]"
          style={{ borderTop: `3px solid ${c.accent}` }}
        >
          <div className="text-[11px] font-bold uppercase tracking-[0.5px] text-[#6B7280]">{c.label}</div>
          <div className="text-[1.4rem] font-bold mt-[3px]">{c.value}</div>
        </div>
      ))}
    </div>
  )
}

function AlertBanner({ data }: { data: IntelligenceData }) {
  const critAlerts = data.workspaces.flatMap(w =>
    w.campaigns.flatMap(c =>
      c.flags.filter(f => f.type === 'critical').map(f => `${w.name} — ${shortName(c.name)}: ${f.msg}`)
    )
  )
  if (!critAlerts.length) return null
  return (
    <div className="bg-[#FEF3C7] border-b-2 border-[#FCD34D] px-8 py-[10px] flex items-center gap-[10px] text-[13px] font-medium text-[#92400E]">
      ⚠️{' '}
      <span>
        <strong>{critAlerts.length} critical issue{critAlerts.length > 1 ? 's' : ''}:</strong>{' '}
        {critAlerts.slice(0, 3).join(' · ')}
        {critAlerts.length > 3 ? ` +${critAlerts.length - 3} more` : ''}
      </span>
    </div>
  )
}

function OptimisationsSection({
  opts,
  onApply,
}: {
  opts: Optimisation[]
  onApply: (i: number) => Promise<void>
}) {
  const [visible, setVisible] = useState(true)
  const [applying, setApplying] = useState<Record<number, 'idle' | 'applying' | 'done' | string>>({})

  if (!opts.length) return null

  async function handleApply(i: number) {
    setApplying(prev => ({ ...prev, [i]: 'applying' }))
    try {
      await onApply(i)
      setApplying(prev => ({ ...prev, [i]: 'done' }))
    } catch (e) {
      setApplying(prev => ({ ...prev, [i]: e instanceof Error ? e.message : 'Error' }))
    }
  }

  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-[0.6rem]">
        <div className="font-bold text-[14px]">
          🎯 Suggested Optimisations{' '}
          <span className="bg-[#FEF3C7] text-[#92400E] px-2 py-[2px] rounded-[10px] text-[12px] ml-[6px]">
            {opts.length} found
          </span>
        </div>
        <button
          onClick={() => setVisible(v => !v)}
          className="text-[12px] text-[#6B7280] bg-none border-none cursor-pointer"
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
      {visible && opts.map((o, i) => {
        const state = applying[i] ?? 'idle'
        return (
          <div
            key={i}
            className="bg-white border border-[#E2E6F0] rounded-[8px] px-4 py-[0.9rem] mb-[0.6rem] flex items-center justify-between gap-4 flex-wrap"
            style={{ borderLeft: `4px solid ${o.confidence === 'high' ? '#059669' : '#D97706'}` }}
          >
            <div className="flex-1 min-w-[200px]">
              <div className="font-semibold text-[13px] mb-[3px]">
                {esc(o.wsName)} — {esc(o.campName)}
                <span
                  className="text-[10px] font-bold px-[7px] py-[2px] rounded-[10px] ml-[6px]"
                  style={
                    o.confidence === 'high'
                      ? { background: '#D1FAE5', color: '#065F46' }
                      : { background: '#FEF3C7', color: '#92400E' }
                  }
                >
                  {o.confidence === 'high' ? 'High confidence' : 'Medium confidence'}
                </span>
              </div>
              <div className="text-[12px] text-[#6B7280] leading-[1.5]">
                Step {o.step} · Winner: <strong>Variant {esc(o.winner.variation)}</strong>
                {' '}({(o.winner.rate * 100).toFixed(2)}% reply rate, {o.winner.reply} replies from{' '}
                {o.winner.sent.toLocaleString()} sends) ·{' '}
                Pause: {o.losers.map(l => `Variant ${l.variation} (${(l.rate * 100).toFixed(2)}%)`).join(', ')}
              </div>
            </div>
            <div className="flex gap-[6px] items-center flex-shrink-0">
              {state === 'idle' && (
                <button
                  onClick={() => handleApply(i)}
                  className="px-[14px] py-[6px] bg-[#1F6F78] text-white border-none rounded-[6px] text-[12px] font-semibold cursor-pointer hover:bg-[#185e65]"
                >
                  Apply in PlusVibe
                </button>
              )}
              {state === 'applying' && (
                <button disabled className="px-[14px] py-[6px] bg-[#9CA3AF] text-white border-none rounded-[6px] text-[12px] font-semibold">
                  Applying…
                </button>
              )}
              {state === 'done' && (
                <span className="px-[14px] py-[6px] bg-[#D1FAE5] text-[#065F46] border-none rounded-[6px] text-[12px] font-semibold">
                  ✓ Applied
                </span>
              )}
              {state !== 'idle' && state !== 'applying' && state !== 'done' && (
                <>
                  <span className="text-[12px] text-[#DC2626]">⚠️ {state}</span>
                  <button
                    onClick={() => setApplying(prev => ({ ...prev, [i]: 'idle' }))}
                    className="px-[14px] py-[6px] bg-[#1F6F78] text-white border-none rounded-[6px] text-[12px] font-semibold cursor-pointer"
                  >
                    Retry
                  </button>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TargetingSection({ patterns }: { patterns: TargetingPattern[] }) {
  const top = patterns.slice(0, 10)
  if (!top.length) return null
  const maxRate = top[0].avgReplyRate

  return (
    <div className="mb-5">
      <div className="font-bold text-[14px] mb-[0.6rem]">
        📊 Targeting Intelligence{' '}
        <span className="text-[12px] font-normal text-[#6B7280]">
          — which Apollo targeting combinations perform best across all clients
        </span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {top.map((p, i) => {
          const rr = (p.avgReplyRate * 100).toFixed(2)
          const tier =
            p.avgReplyRate >= 0.025 ? 'top'
            : p.avgReplyRate >= 0.01 ? 'good'
            : p.avgReplyRate >= 0.005 ? 'warning'
            : 'critical'
          const barW = maxRate > 0 ? Math.round((p.avgReplyRate / maxRate) * 100) : 0
          const parts = [p.titleKey, p.sizeKey, p.kwKey].filter(Boolean) as string[]
          return (
            <div key={i} className="bg-white border border-[#E2E6F0] rounded-[8px] px-4 py-[0.9rem]">
              <div className="flex items-center justify-between mb-[0.5rem]">
                <div className="text-[12px] font-semibold">
                  {parts.map((s, j) => (
                    <span key={j} className="bg-[#F3F4F6] px-[7px] py-[2px] rounded mr-1 text-[11px]">{s}</span>
                  ))}
                </div>
                <div className="text-[15px] font-bold" style={{ color: tierColor(tier) }}>{rr}%</div>
              </div>
              <div className="h-1 rounded bg-[#E2E6F0] mb-[6px]">
                <div className="h-1 rounded bg-[#1F6F78]" style={{ width: `${barW}%` }} />
              </div>
              <div className="text-[11px] text-[#6B7280]">
                {p.count} campaigns · {p.totalSent.toLocaleString()} total sends ·{' '}
                {p.campaigns.slice(0, 2).map(c => c.wsName).join(', ')}
                {p.count > 2 ? ` +${p.count - 2} more` : ''}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ApolloCard({ name }: { name: string }) {
  const a = parseApolloUrl(name)
  if (!a) return null

  function Row({ label, val, color }: { label: string; val: string; color?: string }) {
    if (!val) return null
    return (
      <div className="flex justify-between items-center py-[5px] border-b border-[#F3F4F6] last:border-0 text-[13px]">
        <span className="text-[#6B7280]">{label}</span>
        <span className="font-semibold text-right text-[12px] max-w-[300px]" style={color ? { color } : {}}>
          {val}
        </span>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-[8px] border border-[#E2E6F0] p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] font-bold uppercase tracking-[0.5px] text-[#6B7280]">Apollo Targeting</div>
        <a
          href={a.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-[#7C89CD] no-underline font-normal"
        >
          Open in Apollo ↗
        </a>
      </div>
      <Row label="Job Titles" val={a.titles.join(', ') || a.seniority.join(', ')} />
      {a.titles.length && a.seniority.length ? (
        <Row label="Seniority" val={a.seniority.join(', ')} />
      ) : null}
      <Row label="Company Size" val={a.sizes.join(', ')} />
      <Row label="Locations" val={a.locations.join(', ')} />
      <Row label="Include Industries" val={a.inclKws.join(', ')} color="#059669" />
      <Row
        label="Exclude Industries"
        val={a.exclKws.slice(0, 10).join(', ') + (a.exclKws.length > 10 ? ` +${a.exclKws.length - 10} more` : '')}
        color="#DC2626"
      />
      <Row label="Email Status" val={a.emailStatus.join(', ')} />
    </div>
  )
}

function DetailPanel({ c, wsAvg }: { c: Campaign; wsAvg: number }) {
  const insights: { cls: string; msg: string }[] = []
  c.flags.forEach(f =>
    insights.push({
      cls: f.type === 'critical' ? 'critical' : f.type === 'warning' ? 'warning' : 'success',
      msg: f.msg,
    })
  )
  c.variantInsights.forEach(v => insights.push({ cls: 'success', msg: v.msg }))
  if (!insights.length && c.sent >= 50)
    insights.push({ cls: 'success', msg: 'No issues detected — campaign is performing within normal range.' })

  const insightBg: Record<string, string> = {
    critical: '#FEF2F2',
    warning: '#FFFBEB',
    success: '#F0FDF4',
  }
  const insightBorder: Record<string, string> = {
    critical: '#FECACA',
    warning: '#FDE68A',
    success: '#BBF7D0',
  }
  const insightText: Record<string, string> = {
    critical: '#DC2626',
    warning: '#92400E',
    success: '#065F46',
  }

  const activeSteps = (c.variationSteps ?? []).filter(s => s.variations.some(v => v.sent >= 10))

  const exclOOO =
    c.sent > 0
      ? (((c.posReplies + c.negReplies + (c.neutralReplies ?? 0)) / c.sent) * 100).toFixed(2)
      : null

  const stepReplies = (c.stepReplies ?? []).filter(s => s.sent > 0)

  return (
    <div className="p-5 bg-[#F8FAFF]">
      <div className="grid gap-5" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {/* Left column */}
        <div>
          <ApolloCard name={c.name} />

          {/* Campaign Stats */}
          <div className="bg-white rounded-[8px] border border-[#E2E6F0] p-4 mb-4">
            <div className="text-[11px] font-bold uppercase tracking-[0.5px] text-[#6B7280] mb-3">Campaign Stats</div>
            {[
              { label: 'Total Sends', val: c.sent.toLocaleString() },
              { label: 'Total Replies', val: c.replies.toLocaleString() },
              { label: 'Reply Rate (incl. OOO)', val: `${(c.replyRate * 100).toFixed(2)}%`, color: tierColor(c.tier) },
              ...(exclOOO ? [{ label: 'Reply Rate (excl. OOO)', val: `${exclOOO}%`, color: '#7C89CD' }] : []),
              { label: 'Workspace Avg (incl. OOO)', val: `${(wsAvg * 100).toFixed(2)}%` },
              { label: 'Positive Replies', val: String(c.posReplies), color: '#059669' },
              { label: 'Negative Replies', val: String(c.negReplies), color: '#DC2626' },
              { label: 'Bounces', val: String(c.bounces) },
              { label: 'Actual Leads', val: String(c.leads), color: '#1F6F78' },
              { label: 'Data Size', val: `${(c.dataSize ?? 0).toLocaleString()} contacts` },
              {
                label: 'Data Used',
                val: `${c.leadContacted.toLocaleString()} / ${(c.dataSize ?? 0).toLocaleString()} (${c.exhaustion > 0 ? Math.round(c.exhaustion * 100) + '%' : '—'})`,
              },
              ...(c.lastReplied
                ? [{
                    label: 'Last Reply',
                    val: new Date(c.lastReplied).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
                  }]
                : []),
            ].map(row => (
              <div key={row.label} className="flex justify-between items-center py-[5px] border-b border-[#F3F4F6] last:border-0 text-[13px]">
                <span className="text-[#6B7280]">{row.label}</span>
                <span className="font-semibold" style={row.color ? { color: row.color } : {}}>
                  {row.val}
                </span>
              </div>
            ))}
          </div>

          {/* Step Drop-off */}
          {stepReplies.length > 1 && (
            <div className="bg-white rounded-[8px] border border-[#E2E6F0] p-4 mb-4">
              <div className="text-[11px] font-bold uppercase tracking-[0.5px] text-[#6B7280] mb-3">Step Drop-off</div>
              {stepReplies.map(s => {
                const sr = s.sent > 0 ? s.replies / s.sent : 0
                const barW = Math.min(Math.round(sr * 100 / 0.05), 80)
                return (
                  <div key={s.step} className="flex justify-between items-center py-[5px] border-b border-[#F3F4F6] last:border-0 text-[13px]">
                    <span className="text-[#6B7280]">Step {s.step}</span>
                    <span className="font-semibold flex items-center gap-[6px]">
                      <span
                        className="inline-block h-[5px] rounded"
                        style={{ width: `${barW}px`, background: '#1F6F78' }}
                      />
                      {(sr * 100).toFixed(2)}% ({s.replies}/{s.sent.toLocaleString()})
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {/* Insights */}
          <div className="bg-white rounded-[8px] border border-[#E2E6F0] p-4">
            <div className="text-[11px] font-bold uppercase tracking-[0.5px] text-[#6B7280] mb-3">Insights &amp; Recommendations</div>
            {insights.length ? insights.map((ins, i) => (
              <div
                key={i}
                className="rounded-[7px] px-3 py-[0.75rem] mb-2 text-[12px] leading-[1.5] border"
                style={{
                  background: insightBg[ins.cls] ?? '#EFF6FF',
                  borderColor: insightBorder[ins.cls] ?? '#BFDBFE',
                  color: insightText[ins.cls] ?? '#1E40AF',
                }}
              >
                {ins.msg}
              </div>
            )) : (
              <div className="rounded-[7px] px-3 py-[0.75rem] text-[12px] bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E40AF]">
                Not enough sends for analysis
              </div>
            )}
          </div>
        </div>

        {/* Right column — Variant Performance */}
        <div className="bg-white rounded-[8px] border border-[#E2E6F0] p-4">
          <div className="text-[11px] font-bold uppercase tracking-[0.5px] text-[#6B7280] mb-3">
            Variant Performance{' '}
            {!activeSteps.length && (
              <span className="font-normal text-[#6B7280]">(needs 300+ sends)</span>
            )}
          </div>
          {activeSteps.length ? activeSteps.map(step => {
            const vars = step.variations.filter(v => v.sent > 0)
            if (!vars.length) return null
            const maxRate = Math.max(...vars.map(v => v.sent > 0 ? v.reply / v.sent : 0))
            return (
              <div key={step.step} className="mb-[10px]">
                <div className="text-[11px] font-bold text-[#6B7280] mb-[5px] uppercase">Step {step.step}</div>
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr>
                      {['Variant', 'Name', 'Sent', 'Reply Rate', 'Pos Replies'].map(h => (
                        <th key={h} className="py-[5px] px-2 text-left text-[#6B7280] font-semibold border-b border-[#E2E6F0]">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {vars.map(v => {
                      const rate = v.sent > 0 ? v.reply / v.sent : 0
                      const isBest = rate === maxRate && maxRate > 0
                      const barW = maxRate > 0 ? Math.round((rate / maxRate) * 80) : 0
                      return (
                        <tr key={v.variation} className={isBest ? 'bg-[#F0FDF4]' : ''}>
                          <td className="py-[5px] px-2 border-b border-[#F3F4F6]">
                            <strong>{v.variation}</strong>{isBest ? ' 🏆' : ''}
                          </td>
                          <td className="py-[5px] px-2 text-[#6B7280] border-b border-[#F3F4F6]">
                            {v.name === '-' ? '' : esc(v.name)}
                          </td>
                          <td className="py-[5px] px-2 border-b border-[#F3F4F6]">{v.sent.toLocaleString()}</td>
                          <td className="py-[5px] px-2 border-b border-[#F3F4F6]">
                            <span
                              className="inline-block h-[6px] rounded align-middle mr-1 bg-[#1F6F78]"
                              style={{ width: `${barW}px` }}
                            />
                            <strong>{(rate * 100).toFixed(2)}%</strong>
                          </td>
                          <td className="py-[5px] px-2 border-b border-[#F3F4F6]">{v.pos_reply}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          }) : (
            <div className="text-[#6B7280] text-[13px] py-2">No variant data available for this campaign</div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const s = (status ?? '').toLowerCase()
  const styles: Record<string, { bg: string; color: string }> = {
    active:    { bg: '#D1FAE5', color: '#065F46' },
    paused:    { bg: '#FEF3C7', color: '#92400E' },
    completed: { bg: '#DBEAFE', color: '#1E40AF' },
    draft:     { bg: '#F3F4F6', color: '#4B5563' },
  }
  const st = styles[s] ?? { bg: '#F3F4F6', color: '#4B5563' }
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-[3px] rounded-[20px] text-[11px] font-semibold"
      style={{ background: st.bg, color: st.color }}
    >
      {status || '—'}
    </span>
  )
}

function ExhaustBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="flex items-center gap-[6px]">
      <div className="w-[50px] h-[5px] rounded-[3px] bg-[#E2E6F0] overflow-hidden">
        <div
          className="h-full rounded-[3px]"
          style={{ width: `${Math.min(pct, 100)}%`, background: color }}
        />
      </div>
      <span className="text-[11px] font-semibold" style={{ color }}>{pct}%</span>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────

export default function CampaignsPage() {
  const [data, setData] = useState<IntelligenceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeWs, setActiveWs] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/campaigns/intelligence')
      const d: IntelligenceData = await res.json()
      if (!d?.workspaces?.length) {
        setError('⏳ Server is scanning all campaigns — this takes 3–5 minutes on first load.')
        return
      }
      setData(d)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    intervalRef.current = setInterval(load, 5 * 60 * 1000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [load])

  function toggleExpanded(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function switchWs(idx: number) {
    setActiveWs(idx)
    setExpanded(new Set())
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  async function handleApply(i: number) {
    if (!data) return
    const o = data.optimisations[i]
    const res = await fetch('/api/campaigns/apply-optimisation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wsId: o.wsId,
        campId: o.campId,
        step: o.step,
        loserVariations: o.losers.map(l => l.variation),
      }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error || 'Failed')
  }

  function SortTh({ col, label }: { col: SortKey; label: string }) {
    const active = sortKey === col
    return (
      <th
        className="py-[9px] px-3 text-left text-[11px] font-bold uppercase tracking-[0.5px] border-b border-[#E2E6F0] whitespace-nowrap cursor-pointer select-none hover:text-[#050C29]"
        style={{ color: active ? '#224388' : '#6B7280' }}
        onClick={() => handleSort(col)}
      >
        {label}{' '}
        <span className="inline-block w-[10px] ml-1 text-[#224388] text-[10px]">
          {active ? (sortDir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </th>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#F0F2F8] text-[#6B7280]">
        Loading campaign intelligence…
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#F0F2F8] text-[#6B7280] text-[14px]">
        {error}
      </div>
    )
  }

  if (!data) return null

  const ws = data.workspaces[activeWs]
  const q = search.toLowerCase()
  let filtered = ws.campaigns.filter(c => !q || c.name.toLowerCase().includes(q))

  if (sortKey) {
    const dir = sortDir === 'asc' ? 1 : -1
    filtered = [...filtered].sort((a, b) => {
      const av = campaignSortValue(a, sortKey)
      const bv = campaignSortValue(b, sortKey)
      if (av === bv) return 0
      return av < bv ? -dir : dir
    })
  }

  return (
    <div className="min-h-screen bg-[#F0F2F8] font-sans">
      {/* Alert banner */}
      <AlertBanner data={data} />

      <div className="max-w-[1600px] mx-auto px-8 py-6">
        {/* Page header */}
        <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
          <div>
            <div className="text-[1.3rem] font-bold">Campaign Intelligence</div>
            <div className="text-[12px] text-[#6B7280]">
              {data.updatedAt
                ? 'Updated ' + new Date(data.updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
                : 'Loading…'}
            </div>
          </div>
          <input
            type="text"
            placeholder="Search campaigns…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="px-3 py-[7px] border border-[#E2E6F0] rounded-[8px] text-[13px] w-[220px] outline-none"
          />
        </div>

        {/* Summary cards */}
        <SummaryCards data={data} />

        {/* Optimisations */}
        <OptimisationsSection opts={data.optimisations ?? []} onApply={handleApply} />

        {/* Targeting Intelligence */}
        <TargetingSection patterns={data.targetingPatterns ?? []} />

        {/* Workspace tabs */}
        <div className="overflow-x-auto mb-5">
          <div className="flex gap-[6px] min-w-max pb-[2px]">
            {data.workspaces.map((w, i) => {
              const critCount = w.campaigns.filter(c => c.tier === 'critical').length
              const dotColor = critCount > 0 ? '#DC2626' : w.campaigns.some(c => c.tier === 'top') ? '#059669' : '#9CA3AF'
              return (
                <button
                  key={w.id}
                  onClick={() => switchWs(i)}
                  className="px-[14px] py-[7px] rounded-[20px] text-[12px] font-semibold border-[1.5px] whitespace-nowrap transition-all cursor-pointer"
                  style={
                    i === activeWs
                      ? { background: '#050C29', borderColor: '#050C29', color: '#fff' }
                      : { background: '#fff', borderColor: '#E2E6F0', color: '#6B7280' }
                  }
                >
                  <span
                    className="inline-block w-[7px] h-[7px] rounded-full mr-[5px] align-middle"
                    style={{ background: dotColor }}
                  />
                  {w.name}
                  {critCount > 0 && (
                    <span className="bg-[#DC2626] text-white rounded-[10px] px-[6px] py-[1px] text-[10px] ml-1">
                      {critCount}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Campaign table */}
        <div className="bg-white rounded-[12px] border border-[#E2E6F0] overflow-hidden mb-5">
          <div className="px-5 py-4 border-b border-[#E2E6F0] flex items-center justify-between flex-wrap gap-2">
            <div>
              <span className="font-bold text-[14px]">{ws.name}</span>
              <div className="text-[12px] text-[#6B7280]">
                {ws.campaigns.length} campaigns · {ws.activeCampaigns} active ·{' '}
                {ws.totalSent.toLocaleString()} total sends · avg reply rate{' '}
                {(ws.avgReplyRate * 100).toFixed(2)}%
              </div>
            </div>
            <div className="text-[12px] text-[#6B7280]">Click a campaign to expand</div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse min-w-[600px]">
              <thead className="bg-[#F8F9FC]">
                <tr>
                  <th className="py-[9px] px-3 text-left text-[11px] font-bold uppercase tracking-[0.5px] text-[#6B7280] border-b border-[#E2E6F0] w-6" />
                  <th className="py-[9px] px-3 text-left text-[11px] font-bold uppercase tracking-[0.5px] text-[#6B7280] border-b border-[#E2E6F0]">Campaign</th>
                  <th className="py-[9px] px-3 text-left text-[11px] font-bold uppercase tracking-[0.5px] text-[#6B7280] border-b border-[#E2E6F0]">Status</th>
                  <SortTh col="sent" label="Sent" />
                  <SortTh col="exhaustion" label="Data Used" />
                  <SortTh col="replyRate" label="Reply Rate" />
                  <SortTh col="bounceRate" label="Bounce Rate" />
                  <SortTh col="positivePct" label="Positive %" />
                  <SortTh col="leads" label="Leads" />
                  <th className="py-[9px] px-3 text-left text-[11px] font-bold uppercase tracking-[0.5px] text-[#6B7280] border-b border-[#E2E6F0]">Flags</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="text-center py-12 text-[#6B7280] text-[14px]">
                      No campaigns match
                    </td>
                  </tr>
                ) : (
                  filtered.flatMap(c => {
                    const rr = (c.replyRate * 100).toFixed(2)
                    const rrExNum = c.sent > 0 ? ((c.posReplies + c.negReplies + (c.neutralReplies ?? 0)) / c.sent) * 100 : null
                    const showEx = rrExNum !== null && Math.abs(parseFloat(rr) - rrExNum) > 0.05
                    const rrEx = rrExNum !== null ? rrExNum.toFixed(2) : null
                    const prr = c.replies > 0 ? Math.round((c.posReplies / c.replies) * 100) : null
                    const exPct = c.exhaustion > 0 ? Math.round(c.exhaustion * 100) : 0
                    const exColor = c.exhaustion >= 0.9 ? '#DC2626' : c.exhaustion >= 0.75 ? '#D97706' : '#059669'
                    const isExpanded = expanded.has(c.id)
                    const allFlags = [
                      ...c.flags,
                      ...c.variantInsights.map(v => ({ type: 'info' as const, msg: v.msg })),
                    ]
                    const bounceColor = (() => {
                      if (c.sent < 50) return '#6B7280'
                      const br = (c.bounces / c.sent) * 100
                      return br >= 5 ? '#DC2626' : br >= 2 ? '#D97706' : '#059669'
                    })()
                    const apolloSum = apolloSummaryLine(c.name)

                    return [
                      <tr
                        key={c.id}
                        className="cursor-pointer hover:bg-[#FAFBFF]"
                        onClick={() => toggleExpanded(c.id)}
                      >
                        <td className="py-[11px] px-3 text-[12px] text-[#6B7280] border-b border-[#E2E6F0]">
                          <span
                            className="inline-block transition-transform duration-200"
                            style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0)' }}
                          >
                            ▶
                          </span>
                        </td>
                        <td className="py-[11px] px-3 border-b border-[#E2E6F0]">
                          <div
                            className="font-semibold text-[13px] max-w-[300px] whitespace-nowrap overflow-hidden text-ellipsis"
                            title={c.name}
                          >
                            {shortName(c.name)}
                          </div>
                          {apolloSum && (
                            <div className="text-[11px] text-[#7C89CD] mt-[2px]">{apolloSum}</div>
                          )}
                        </td>
                        <td className="py-[11px] px-3 border-b border-[#E2E6F0]">
                          <StatusBadge status={c.status} />
                        </td>
                        <td className="py-[11px] px-3 border-b border-[#E2E6F0] font-semibold text-[13px]">
                          {c.sent.toLocaleString()}
                        </td>
                        <td className="py-[11px] px-3 border-b border-[#E2E6F0]">
                          {c.leadContacted > 0 ? (
                            <ExhaustBar pct={exPct} color={exColor} />
                          ) : (
                            <span className="text-[#6B7280] text-[11px]">—</span>
                          )}
                        </td>
                        <td className="py-[11px] px-3 border-b border-[#E2E6F0]">
                          <div className="flex items-center gap-[6px]">
                            <span
                              className="w-[10px] h-[10px] rounded-full flex-shrink-0"
                              style={{ background: tierColor(c.tier) }}
                            />
                            <span className="font-bold text-[13px]" style={{ color: tierColor(c.tier) }}>
                              {c.sent < 50 ? '—' : rr + '%'}
                            </span>
                          </div>
                          {showEx && rrEx && (
                            <div className="text-[11px] text-[#7C89CD] mt-[1px]">{rrEx}% excl. OOO</div>
                          )}
                        </td>
                        <td className="py-[11px] px-3 border-b border-[#E2E6F0]">
                          {c.sent < 50 ? '—' : (
                            <span className="font-semibold" style={{ color: bounceColor }}>
                              {((c.bounces / c.sent) * 100).toFixed(2)}%
                            </span>
                          )}
                        </td>
                        <td className="py-[11px] px-3 border-b border-[#E2E6F0]">
                          {c.sent >= 50 && c.replies > 0 && prr !== null ? `${prr}%` : '—'}
                        </td>
                        <td className="py-[11px] px-3 border-b border-[#E2E6F0] font-semibold text-[13px]">
                          {c.leads}
                        </td>
                        <td className="py-[11px] px-3 border-b border-[#E2E6F0]">
                          <div className="flex flex-wrap gap-1">
                            {allFlags.slice(0, 2).map((f, fi) => {
                              const flagStyles: Record<string, { bg: string; color: string }> = {
                                critical: { bg: '#FEE2E2', color: '#DC2626' },
                                warning:  { bg: '#FEF3C7', color: '#92400E' },
                                top:      { bg: '#D1FAE5', color: '#065F46' },
                                info:     { bg: '#DBEAFE', color: '#1E40AF' },
                              }
                              const fs = flagStyles[f.type === 'info' ? 'info' : f.type] ?? flagStyles.info
                              return (
                                <span
                                  key={fi}
                                  className="text-[10px] font-semibold px-[6px] py-[2px] rounded-[3px]"
                                  style={{ background: fs.bg, color: fs.color }}
                                >
                                  {f.msg.split('—')[0].trim()}
                                </span>
                              )
                            })}
                          </div>
                        </td>
                      </tr>,
                      ...(isExpanded
                        ? [
                            <tr key={`${c.id}-detail`}>
                              <td colSpan={10} className="p-0 border-b border-[#E2E6F0]">
                                <DetailPanel c={c} wsAvg={ws.avgReplyRate} />
                              </td>
                            </tr>,
                          ]
                        : []),
                    ]
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
