'use client'

import { useEffect, useState, useCallback } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

interface CampaignFlag {
  type: 'critical' | 'warning' | 'info'
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
  neutralReplies: number
  bounces: number
  leads: number
  exhaustion: number
  leadContacted: number
  dataSize: number
  lastReplied: string | null
  tier: 'top' | 'good' | 'warning' | 'critical' | 'new'
  flags: CampaignFlag[]
  variantInsights: VariantInsight[]
  variationSteps: VariationStep[]
  stepReplies: StepReply[]
}

interface Workspace {
  id: string
  name: string
  avgReplyRate: number
  activeCampaigns: number
  totalSent: number
  campaigns: Campaign[]
}

interface Optimisation {
  wsId: string
  wsName: string
  campId: string
  campName: string
  step: number
  confidence: 'high' | 'medium'
  winner: { variation: string; rate: number; reply: number; sent: number }
  losers: Array<{ variation: string; rate: number }>
}

interface TargetingPattern {
  titleKey: string
  sizeKey: string
  kwKey: string
  avgReplyRate: number
  count: number
  totalSent: number
  campaigns: Array<{ wsName: string }>
}

interface IntelligenceData {
  workspaces: Workspace[]
  optimisations: Optimisation[]
  targetingPatterns: TargetingPattern[]
  updatedAt: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    return {
      titles: get('personTitles'),
      seniority: get('personSeniorities'),
      sizes: get('organizationNumEmployeesRanges').map(s => sizeMap[s] || s),
      locations: [...new Set([...get('personLocations'), ...get('organizationLocations'), ...get('accounthqLocations')].map(clean))],
      inclKws: get('qOrganizationKeywordTags'),
      exclKws: get('qNotOrganizationKeywordTags'),
      emailStatus: get('contactEmailStatusV2'),
      rawUrl: raw,
    }
  } catch { return null }
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

type SortKey = 'sent' | 'exhaustion' | 'replyRate' | 'bounceRate' | 'positivePct' | 'leads'

function campaignSortValue(c: Campaign, key: SortKey): number {
  switch (key) {
    case 'sent':        return c.sent || 0
    case 'exhaustion':  return c.exhaustion || 0
    case 'replyRate':   return c.sent >= 50 ? (c.replyRate || 0) : -Infinity
    case 'bounceRate':  return c.sent >= 50 ? ((c.bounces || 0) / Math.max(c.sent, 1)) : -Infinity
    case 'positivePct': return c.replies > 0 ? ((c.posReplies || 0) / c.replies) : -Infinity
    case 'leads':       return c.leads || 0
    default:            return 0
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  const cls =
    s === 'active'    ? 'bg-[#D1FAE5] text-[#065F46]' :
    s === 'paused'    ? 'bg-[#FEF3C7] text-[#92400E]' :
    s === 'completed' ? 'bg-[#DBEAFE] text-[#1E40AF]' :
                        'bg-[#F3F4F6] text-[#4B5563]'
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>
      {status}
    </span>
  )
}

function TierDot({ tier }: { tier: Campaign['tier'] }) {
  const color =
    tier === 'top'      ? '#059669' :
    tier === 'good'     ? '#10B981' :
    tier === 'warning'  ? '#D97706' :
    tier === 'critical' ? '#DC2626' :
                          '#9CA3AF'
  return <span className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
}

function RateVal({ tier, children }: { tier: Campaign['tier']; children: React.ReactNode }) {
  const color =
    tier === 'top'      ? '#059669' :
    tier === 'good'     ? '#10B981' :
    tier === 'warning'  ? '#D97706' :
    tier === 'critical' ? '#DC2626' :
                          '#6B7280'
  return <span className="font-bold text-[13px]" style={{ color }}>{children}</span>
}

function FlagChip({ flag }: { flag: CampaignFlag }) {
  const cls =
    flag.type === 'critical' ? 'bg-[#FEE2E2] text-[#DC2626]' :
    flag.type === 'warning'  ? 'bg-[#FEF3C7] text-[#92400E]' :
    flag.type === 'info'     ? 'bg-[#DBEAFE] text-[#1E40AF]' :
                               'bg-[#D1FAE5] text-[#065F46]'
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${cls}`}>
      {flag.msg.split('—')[0].trim()}
    </span>
  )
}

function ExhaustBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-[50px] h-[5px] rounded-full bg-[#E2E6F0] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
      </div>
      <span className="text-[11px] font-semibold" style={{ color }}>{pct}%</span>
    </div>
  )
}

function InsightCard({ cls, msg }: { cls: string; msg: string }) {
  const style =
    cls === 'critical' ? 'bg-[#FEF2F2] border-[#FECACA] text-[#DC2626]' :
    cls === 'warning'  ? 'bg-[#FFFBEB] border-[#FDE68A] text-[#92400E]' :
    cls === 'success'  ? 'bg-[#F0FDF4] border-[#BBF7D0] text-[#065F46]' :
                         'bg-[#EFF6FF] border-[#BFDBFE] text-[#1E40AF]'
  return <div className={`border rounded-[7px] px-3 py-2 mb-2 text-[12px] leading-relaxed ${style}`}>{msg}</div>
}

function ApolloCard({ name }: { name: string }) {
  const a = parseApolloUrl(name)
  if (!a) return null
  const row = (label: string, val: string, color?: string) =>
    val ? (
      <div key={label} className="flex justify-between items-center py-1 border-b border-[#F3F4F6] text-[13px] last:border-0">
        <span className="text-[#6B7280]">{label}</span>
        <span className="font-semibold text-right text-[12px] max-w-[300px]" style={color ? { color } : {}}>
          {val}
        </span>
      </div>
    ) : null
  return (
    <div className="bg-white rounded-lg border border-[#E2E6F0] p-4 mb-4">
      <div className="flex justify-between items-center mb-3">
        <span className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280]">Apollo Targeting</span>
        <a href={a.rawUrl} target="_blank" rel="noreferrer"
           className="text-[11px] text-[#7C89CD] no-underline font-normal">Open in Apollo ↗</a>
      </div>
      {row('Job Titles', a.titles.join(', ') || a.seniority.join(', '))}
      {a.titles.length && a.seniority.length ? row('Seniority', a.seniority.join(', ')) : null}
      {row('Company Size', a.sizes.join(', '))}
      {row('Locations', a.locations.join(', '))}
      {row('Include Industries', a.inclKws.join(', '), '#059669')}
      {row('Exclude Industries', a.exclKws.slice(0, 10).join(', ') + (a.exclKws.length > 10 ? ` +${a.exclKws.length - 10} more` : ''), '#DC2626')}
      {row('Email Status', a.emailStatus.join(', '))}
    </div>
  )
}

function DetailPanel({ campaign, wsAvg }: { campaign: Campaign; wsAvg: number }) {
  const insights: Array<{ cls: string; msg: string }> = []
  campaign.flags.forEach(f =>
    insights.push({ cls: f.type === 'critical' ? 'critical' : f.type === 'warning' ? 'warning' : 'success', msg: f.msg })
  )
  campaign.variantInsights.forEach(v => insights.push({ cls: 'success', msg: v.msg }))
  if (!insights.length && campaign.sent >= 50)
    insights.push({ cls: 'success', msg: 'No issues detected — campaign is performing within normal range.' })

  const exclOOO = campaign.sent > 0
    ? (((campaign.posReplies + campaign.negReplies + (campaign.neutralReplies || 0)) / campaign.sent) * 100).toFixed(2)
    : null

  const activeSteps = (campaign.variationSteps || []).filter(s =>
    s.variations.some(v => v.sent >= 10)
  )

  const statRow = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between items-center py-1.5 border-b border-[#F3F4F6] text-[13px] last:border-0">
      <span className="text-[#6B7280]">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  )

  return (
    <div className="p-5 grid gap-5" style={{ gridTemplateColumns: '1fr 1fr' }}>
      {/* Left column */}
      <div>
        <ApolloCard name={campaign.name} />

        {/* Campaign Stats */}
        <div className="bg-white rounded-lg border border-[#E2E6F0] p-4 mb-4">
          <div className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280] mb-3">Campaign Stats</div>
          {statRow('Total Sends', campaign.sent.toLocaleString())}
          {statRow('Total Replies', campaign.replies.toLocaleString())}
          {statRow('Reply Rate (incl. OOO)',
            <RateVal tier={campaign.tier}>{(campaign.replyRate * 100).toFixed(2)}%</RateVal>
          )}
          {exclOOO && statRow('Reply Rate (excl. OOO)',
            <span style={{ color: '#7C89CD' }}>{exclOOO}%</span>
          )}
          {statRow('Workspace Avg (incl. OOO)', `${(wsAvg * 100).toFixed(2)}%`)}
          {statRow('Positive Replies', <span style={{ color: '#059669' }}>{campaign.posReplies}</span>)}
          {statRow('Negative Replies', <span style={{ color: '#DC2626' }}>{campaign.negReplies}</span>)}
          {statRow('Bounces', campaign.bounces)}
          {statRow('Actual Leads', <span style={{ color: '#1F6F78' }}>{campaign.leads}</span>)}
          {statRow('Data Size', `${(campaign.dataSize || 0).toLocaleString()} contacts`)}
          {statRow('Data Used',
            `${campaign.leadContacted.toLocaleString()} / ${(campaign.dataSize || 0).toLocaleString()} (${campaign.exhaustion > 0 ? Math.round(campaign.exhaustion * 100) + '%' : '—'})`
          )}
          {campaign.lastReplied && statRow('Last Reply',
            new Date(campaign.lastReplied).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          )}
        </div>

        {/* Step Drop-off */}
        {(campaign.stepReplies || []).filter(s => s.sent > 0).length > 1 && (
          <div className="bg-white rounded-lg border border-[#E2E6F0] p-4 mb-4">
            <div className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280] mb-3">Step Drop-off</div>
            {(campaign.stepReplies || []).filter(s => s.sent > 0).map(s => {
              const sr = s.sent > 0 ? s.replies / s.sent : 0
              const barW = Math.min(Math.round(sr * 100 / 0.05), 80)
              return (
                <div key={s.step} className="flex justify-between items-center py-1.5 border-b border-[#F3F4F6] text-[13px] last:border-0">
                  <span className="text-[#6B7280]">Step {s.step}</span>
                  <span className="font-semibold flex items-center gap-1.5">
                    <span className="inline-block h-[5px] rounded-sm" style={{ width: barW, background: '#1F6F78' }} />
                    {(sr * 100).toFixed(2)}% ({s.replies}/{s.sent.toLocaleString()})
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* Insights */}
        <div className="bg-white rounded-lg border border-[#E2E6F0] p-4">
          <div className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280] mb-3">Insights & Recommendations</div>
          {insights.length
            ? insights.map((ins, i) => <InsightCard key={i} cls={ins.cls} msg={ins.msg} />)
            : <div className="border rounded-[7px] px-3 py-2 text-[12px] bg-[#EFF6FF] border-[#BFDBFE] text-[#1E40AF]">Not enough sends for analysis</div>
          }
        </div>
      </div>

      {/* Right column — Variant Performance */}
      <div className="bg-white rounded-lg border border-[#E2E6F0] p-4">
        <div className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280] mb-3">
          Variant Performance{' '}
          {!campaign.variationSteps?.length && (
            <span className="font-normal normal-case text-[#6B7280]">(needs 300+ sends)</span>
          )}
        </div>
        {activeSteps.length ? activeSteps.map(step => {
          const vars = step.variations.filter(v => v.sent > 0)
          if (!vars.length) return null
          const maxRate = Math.max(...vars.map(v => v.sent > 0 ? v.reply / v.sent : 0))
          return (
            <div key={step.step} className="mb-3">
              <div className="text-[11px] font-bold text-[#6B7280] mb-1.5">STEP {step.step}</div>
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr>
                    <th className="text-left py-1 px-2 text-[#6B7280] font-semibold border-b border-[#E2E6F0]">Variant</th>
                    <th className="text-left py-1 px-2 text-[#6B7280] font-semibold border-b border-[#E2E6F0]">Name</th>
                    <th className="text-left py-1 px-2 text-[#6B7280] font-semibold border-b border-[#E2E6F0]">Sent</th>
                    <th className="text-left py-1 px-2 text-[#6B7280] font-semibold border-b border-[#E2E6F0]">Reply Rate</th>
                    <th className="text-left py-1 px-2 text-[#6B7280] font-semibold border-b border-[#E2E6F0]">Pos Replies</th>
                  </tr>
                </thead>
                <tbody>
                  {vars.map(v => {
                    const rate = v.sent > 0 ? v.reply / v.sent : 0
                    const isBest = rate === maxRate && maxRate > 0
                    const barW = maxRate > 0 ? Math.round(rate / maxRate * 80) : 0
                    return (
                      <tr key={v.variation} className={isBest ? 'bg-[#F0FDF4]' : ''}>
                        <td className="py-1 px-2 border-b border-[#F3F4F6]">
                          <strong>{v.variation}</strong>{isBest ? ' 🏆' : ''}
                        </td>
                        <td className="py-1 px-2 border-b border-[#F3F4F6] text-[#6B7280]">
                          {v.name === '-' ? '' : v.name}
                        </td>
                        <td className="py-1 px-2 border-b border-[#F3F4F6]">{v.sent.toLocaleString()}</td>
                        <td className="py-1 px-2 border-b border-[#F3F4F6]">
                          <span className="inline-block h-[6px] rounded-sm align-middle mr-1" style={{ width: barW, background: '#1F6F78' }} />
                          <strong>{(rate * 100).toFixed(2)}%</strong>
                        </td>
                        <td className="py-1 px-2 border-b border-[#F3F4F6]">{v.pos_reply}</td>
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
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function CampaignsPage() {
  const [data, setData] = useState<IntelligenceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeWsIdx, setActiveWsIdx] = useState(0)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [optsVisible, setOptsVisible] = useState(true)
  const [optStatuses, setOptStatuses] = useState<Record<number, 'applying' | 'applied' | string>>({})
  const [updatedAt, setUpdatedAt] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/campaigns/intelligence')
      const d: IntelligenceData = await res.json()
      if (!d || !d.workspaces?.length) {
        setError('⏳ Server is scanning all campaigns — this takes 3–5 minutes on first load. Page will auto-refresh.')
        setTimeout(load, 30000)
        return
      }
      setData(d)
      setError(null)
      setUpdatedAt('Updated ' + new Date(d.updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [load])

  function toggleDetail(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function switchWs(idx: number) {
    setActiveWsIdx(idx)
    setExpandedIds(new Set())
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  async function applyOpt(i: number) {
    if (!data) return
    const o = data.optimisations[i]
    setOptStatuses(s => ({ ...s, [i]: 'applying' }))
    try {
      const r = await fetch('/api/campaigns/apply-optimisation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wsId: o.wsId, campId: o.campId, step: o.step, loserVariations: o.losers.map(l => l.variation) }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'Failed')
      setOptStatuses(s => ({ ...s, [i]: 'applied' }))
    } catch (e) {
      setOptStatuses(s => ({ ...s, [i]: `⚠️ ${e instanceof Error ? e.message : 'Failed'}` }))
    }
  }

  // ── Computed summary values ──────────────────────────────────────────────

  const allCampaigns = data?.workspaces.flatMap(w => w.campaigns) ?? []
  const withData = allCampaigns.filter(c => c.sent >= 50)
  const avgReply = withData.length ? withData.reduce((s, c) => s + c.replyRate, 0) / withData.length : 0

  const critAlerts = data?.workspaces.flatMap(w =>
    w.campaigns.flatMap(c => c.flags.filter(f => f.type === 'critical').map(f => `${w.name} — ${shortName(c.name)}: ${f.msg}`))
  ) ?? []

  const activeWs = data?.workspaces[activeWsIdx]

  const filteredCampaigns = (() => {
    if (!activeWs) return []
    const q = search.toLowerCase()
    let list = activeWs.campaigns.filter(c => !q || c.name.toLowerCase().includes(q))
    if (sortKey) {
      const dir = sortDir === 'asc' ? 1 : -1
      list = [...list].sort((a, b) => {
        const av = campaignSortValue(a, sortKey)
        const bv = campaignSortValue(b, sortKey)
        if (av === bv) return 0
        return av < bv ? -dir : dir
      })
    }
    return list
  })()

  // ── Sortable column header ───────────────────────────────────────────────

  function SortTh({ col, label }: { col: SortKey; label: string }) {
    const active = sortKey === col
    return (
      <th
        className="py-2 px-3 text-left text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280] border-b border-[#E2E6F0] cursor-pointer select-none whitespace-nowrap hover:text-[#050C29]"
        style={active ? { color: '#224388' } : {}}
        onClick={() => handleSort(col)}
      >
        {label}{' '}
        <span className="inline-block w-2.5 ml-1 text-[10px]" style={{ color: '#224388' }}>
          {active ? (sortDir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </th>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen" style={{ background: '#F0F2F8', color: '#050C29', fontFamily: 'Inter, sans-serif' }}>

      {/* Alert banner */}
      {critAlerts.length > 0 && (
        <div className="bg-[#FEF3C7] border-b-2 border-[#FCD34D] px-8 py-2.5 flex items-center gap-2.5 text-[13px] font-medium text-[#92400E]">
          ⚠️ <strong>{critAlerts.length} critical issue{critAlerts.length > 1 ? 's' : ''}:</strong>{' '}
          {critAlerts.slice(0, 3).join(' · ')}{critAlerts.length > 3 ? ` +${critAlerts.length - 3} more` : ''}
        </div>
      )}

      <div className="max-w-[1600px] mx-auto px-8 py-6">

        {/* Page header */}
        <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
          <div>
            <div className="text-[1.3rem] font-bold">Campaign Intelligence</div>
            <div className="text-[12px] text-[#6B7280]">
              {loading ? 'Loading…' : updatedAt || '—'}
            </div>
          </div>
          <input
            type="text"
            placeholder="Search campaigns…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="px-3 py-1.5 border border-[#E2E6F0] rounded-lg text-[13px] w-[220px] outline-none focus:border-[#1F6F78]"
          />
        </div>

        {/* Summary bar */}
        <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          {[
            { label: 'Total Campaigns', value: allCampaigns.length, accent: '#224388' },
            { label: 'Active',          value: allCampaigns.filter(c => c.status === 'ACTIVE').length, accent: '#1F6F78' },
            { label: 'Top Performers',  value: allCampaigns.filter(c => c.tier === 'top').length,      accent: '#059669' },
            { label: 'Need Attention',  value: allCampaigns.filter(c => c.tier === 'warning').length,  accent: '#D97706' },
            { label: 'Critical',        value: allCampaigns.filter(c => c.tier === 'critical').length, accent: '#DC2626' },
            { label: 'Avg Reply Rate',  value: `${(avgReply * 100).toFixed(2)}%`,                      accent: '#224388' },
          ].map(card => (
            <div key={card.label} className="bg-white rounded-[10px] border border-[#E2E6F0] px-4 py-3"
                 style={{ borderTop: `3px solid ${card.accent}` }}>
              <div className="text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280]">{card.label}</div>
              <div className="text-[1.4rem] font-bold mt-0.5">{loading ? '—' : card.value}</div>
            </div>
          ))}
        </div>

        {/* Suggested Optimisations */}
        {data && data.optimisations?.length > 0 && (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-2">
              <div className="font-bold text-[14px]">
                🎯 Suggested Optimisations{' '}
                <span className="bg-[#FEF3C7] text-[#92400E] px-2 py-0.5 rounded-full text-[12px] ml-1.5">
                  {data.optimisations.length} found
                </span>
              </div>
              <button
                onClick={() => setOptsVisible(v => !v)}
                className="text-[12px] text-[#6B7280] bg-transparent border-0 cursor-pointer"
              >
                {optsVisible ? 'Hide' : 'Show'}
              </button>
            </div>
            {optsVisible && data.optimisations.map((o, i) => {
              const st = optStatuses[i]
              return (
                <div key={i} className="bg-white border border-[#E2E6F0] rounded-lg px-4 py-3 mb-2 flex items-center justify-between gap-4 flex-wrap"
                     style={{ borderLeft: `4px solid ${o.confidence === 'high' ? '#059669' : '#D97706'}` }}>
                  <div className="flex-1 min-w-[200px]">
                    <div className="font-semibold text-[13px] mb-0.5">
                      {o.wsName} — {o.campName}
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ml-1.5 ${o.confidence === 'high' ? 'bg-[#D1FAE5] text-[#065F46]' : 'bg-[#FEF3C7] text-[#92400E]'}`}>
                        {o.confidence === 'high' ? 'High confidence' : 'Medium confidence'}
                      </span>
                    </div>
                    <div className="text-[12px] text-[#6B7280] leading-relaxed">
                      Step {o.step} · Winner: <strong>Variant {o.winner.variation}</strong>{' '}
                      ({(o.winner.rate * 100).toFixed(2)}% reply rate, {o.winner.reply} replies from {o.winner.sent.toLocaleString()} sends) ·
                      Pause: {o.losers.map(l => `Variant ${l.variation} (${(l.rate * 100).toFixed(2)}%)`).join(', ')}
                    </div>
                  </div>
                  <div className="flex gap-1.5 items-center flex-shrink-0">
                    {st && typeof st === 'string' && st !== 'applying' && st !== 'applied' && (
                      <span className="text-[12px] text-[#DC2626]">{st}</span>
                    )}
                    {st === 'applied' ? (
                      <span className="px-3 py-1.5 bg-[#D1FAE5] text-[#065F46] border-0 rounded-md text-[12px] font-semibold">✓ Applied</span>
                    ) : (
                      <button
                        disabled={st === 'applying'}
                        onClick={() => applyOpt(i)}
                        className="px-3 py-1.5 border-0 rounded-md text-[12px] font-semibold cursor-pointer transition-colors"
                        style={{ background: st === 'applying' ? '#9CA3AF' : '#1F6F78', color: '#fff', cursor: st === 'applying' ? 'not-allowed' : 'pointer' }}
                      >
                        {st === 'applying' ? 'Applying…' : 'Apply in PlusVibe'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Targeting Intelligence */}
        {data && data.targetingPatterns?.length > 0 && (
          <div className="mb-5">
            <div className="font-bold text-[14px] mb-2">
              📊 Targeting Intelligence{' '}
              <span className="text-[12px] font-normal text-[#6B7280]">— which Apollo targeting combinations perform best across all clients</span>
            </div>
            <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 1fr' }}>
              {data.targetingPatterns.slice(0, 10).map((p, i) => {
                const rr = (p.avgReplyRate * 100).toFixed(2)
                const tier = p.avgReplyRate >= 0.025 ? 'top' : p.avgReplyRate >= 0.01 ? 'good' : p.avgReplyRate >= 0.005 ? 'warning' : 'critical'
                const maxRate = data.targetingPatterns[0].avgReplyRate
                const barW = maxRate > 0 ? Math.round(p.avgReplyRate / maxRate * 100) : 0
                const rateColor = tier === 'top' ? '#059669' : tier === 'good' ? '#10B981' : tier === 'warning' ? '#D97706' : '#DC2626'
                const parts = [p.titleKey, p.sizeKey, p.kwKey].filter(Boolean)
                return (
                  <div key={i} className="bg-white border border-[#E2E6F0] rounded-lg px-4 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex flex-wrap gap-1">
                        {parts.map(s => (
                          <span key={s} className="bg-[#F3F4F6] px-2 py-0.5 rounded text-[11px]">{s}</span>
                        ))}
                      </div>
                      <div className="text-[15px] font-bold" style={{ color: rateColor }}>{rr}%</div>
                    </div>
                    <div className="h-1 bg-[#E2E6F0] rounded mb-1.5">
                      <div className="h-1 rounded" style={{ width: `${barW}%`, background: '#1F6F78' }} />
                    </div>
                    <div className="text-[11px] text-[#6B7280]">
                      {p.count} campaigns · {p.totalSent.toLocaleString()} total sends
                      · {p.campaigns.slice(0, 2).map(c => c.wsName).join(', ')}{p.count > 2 ? ` +${p.count - 2} more` : ''}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Workspace tabs */}
        {data && (
          <div className="overflow-x-auto mb-5">
            <div className="flex gap-1.5 min-w-max pb-0.5">
              {data.workspaces.map((ws, i) => {
                const critCount = ws.campaigns.filter(c => c.tier === 'critical').length
                const dotColor = critCount > 0 ? '#DC2626' : ws.campaigns.some(c => c.tier === 'top') ? '#059669' : '#9CA3AF'
                return (
                  <button
                    key={ws.id}
                    onClick={() => switchWs(i)}
                    className="px-3.5 py-1.5 rounded-full text-[12px] font-semibold cursor-pointer border transition-all whitespace-nowrap"
                    style={i === activeWsIdx
                      ? { background: '#050C29', borderColor: '#050C29', color: '#fff' }
                      : { background: '#fff', borderColor: '#E2E6F0', color: '#6B7280' }
                    }
                  >
                    <span className="inline-block w-[7px] h-[7px] rounded-full mr-1.5 align-middle" style={{ background: dotColor }} />
                    {ws.name}
                    {critCount > 0 && (
                      <span className="bg-[#DC2626] text-white rounded-full px-1.5 py-px text-[10px] ml-1">{critCount}</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Campaign table */}
        <div className="bg-white rounded-xl border border-[#E2E6F0] overflow-hidden mb-5">
          <div className="px-5 py-4 border-b border-[#E2E6F0] flex items-center justify-between flex-wrap gap-2">
            <div>
              <span className="font-bold text-[14px]">{activeWs?.name ?? '—'}</span>
              {activeWs && (
                <div className="text-[12px] text-[#6B7280] mt-0.5">
                  {activeWs.campaigns.length} campaigns · {activeWs.activeCampaigns} active · {activeWs.totalSent.toLocaleString()} total sends · avg reply rate {(activeWs.avgReplyRate * 100).toFixed(2)}%
                </div>
              )}
            </div>
            <div className="text-[12px] text-[#6B7280]">Click a campaign to expand</div>
          </div>

          <table className="w-full border-collapse">
            <thead style={{ background: '#F8F9FC' }}>
              <tr>
                <th className="py-2 px-3 text-left text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280] border-b border-[#E2E6F0] w-6" />
                <th className="py-2 px-3 text-left text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280] border-b border-[#E2E6F0]">Campaign</th>
                <th className="py-2 px-3 text-left text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280] border-b border-[#E2E6F0]">Status</th>
                <SortTh col="sent"        label="Sent" />
                <SortTh col="exhaustion"  label="Data Used" />
                <SortTh col="replyRate"   label="Reply Rate" />
                <SortTh col="bounceRate"  label="Bounce Rate" />
                <SortTh col="positivePct" label="Positive %" />
                <SortTh col="leads"       label="Leads" />
                <th className="py-2 px-3 text-left text-[11px] font-bold uppercase tracking-[.5px] text-[#6B7280] border-b border-[#E2E6F0]">Flags</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={10} className="text-center py-12 text-[14px] text-[#6B7280]">Loading…</td></tr>
              ) : error ? (
                <tr><td colSpan={10} className="text-center py-12 text-[14px] text-[#6B7280]">{error}</td></tr>
              ) : filteredCampaigns.length === 0 ? (
                <tr><td colSpan={10} className="text-center py-12 text-[14px] text-[#6B7280]">No campaigns match</td></tr>
              ) : filteredCampaigns.map(c => {
                const rr = (c.replyRate * 100).toFixed(2)
                const rrExNum = c.sent > 0
                  ? ((c.posReplies + c.negReplies + (c.neutralReplies || 0)) / c.sent * 100)
                  : null
                const rrEx = rrExNum !== null ? rrExNum.toFixed(2) : null
                const showEx = rrEx !== null && Math.abs(parseFloat(rr) - parseFloat(rrEx)) > 0.05
                const prr = c.replies > 0 ? ((c.posReplies / c.replies) * 100).toFixed(0) : '—'
                const lr = c.sent > 0 && c.leads > 0 ? ((c.leads / c.sent) * 100).toFixed(2) + '%' : '—'
                const expanded = expandedIds.has(c.id)
                const exPct = c.exhaustion > 0 ? Math.round(c.exhaustion * 100) : 0
                const exColor = c.exhaustion >= 0.9 ? '#DC2626' : c.exhaustion >= 0.75 ? '#D97706' : '#059669'
                const bounceRate = c.sent >= 50 ? (c.bounces / c.sent) * 100 : null
                const bounceColor = bounceRate === null ? '' : bounceRate >= 5 ? '#DC2626' : bounceRate >= 2 ? '#D97706' : '#059669'
                const apolloSummary = apolloSummaryLine(c.name)
                const allFlags = [
                  ...c.flags,
                  ...c.variantInsights.map(v => ({ type: 'info' as const, msg: v.msg })),
                ]
                return [
                  <tr
                    key={`row-${c.id}`}
                    className="cursor-pointer"
                    onClick={() => toggleDetail(c.id)}
                    style={{ borderBottom: '1px solid #E2E6F0' }}
                    onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).querySelectorAll('td').forEach(td => (td.style.background = '#FAFBFF'))}
                    onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).querySelectorAll('td').forEach(td => (td.style.background = ''))}
                  >
                    <td className="py-2.5 px-3 text-[12px] text-[#6B7280]" style={{ transition: 'transform 0.2s' }}>
                      <span style={{ display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▶</span>
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="font-semibold text-[13px] max-w-[300px] truncate" title={c.name}>
                        {shortName(c.name)}
                      </div>
                      {apolloSummary && (
                        <div className="text-[11px] mt-0.5" style={{ color: '#7C89CD' }}>{apolloSummary}</div>
                      )}
                    </td>
                    <td className="py-2.5 px-3"><StatusBadge status={c.status} /></td>
                    <td className="py-2.5 px-3 font-semibold">{c.sent.toLocaleString()}</td>
                    <td className="py-2.5 px-3">
                      {c.leadContacted > 0
                        ? <ExhaustBar pct={exPct} color={exColor} />
                        : <span className="text-[#6B7280] text-[11px]">—</span>
                      }
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-1.5">
                        <TierDot tier={c.tier} />
                        <RateVal tier={c.tier}>{c.sent < 50 ? '—' : rr + '%'}</RateVal>
                      </div>
                      {showEx && (
                        <div className="text-[11px] mt-0.5" style={{ color: '#7C89CD' }}>{rrEx}% excl. OOO</div>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      {bounceRate === null
                        ? '—'
                        : <span className="font-semibold" style={{ color: bounceColor }}>{bounceRate.toFixed(2)}%</span>
                      }
                    </td>
                    <td className="py-2.5 px-3">
                      {c.sent >= 50 && c.replies > 0 ? prr + '%' : '—'}
                    </td>
                    <td className="py-2.5 px-3 font-semibold">{c.leads}</td>
                    <td className="py-2.5 px-3">
                      <div className="flex flex-wrap gap-1">
                        {allFlags.slice(0, 2).map((f, fi) => (
                          <FlagChip key={fi} flag={f} />
                        ))}
                      </div>
                    </td>
                  </tr>,
                  expanded && (
                    <tr key={`detail-${c.id}`} style={{ background: '#F8FAFF', borderBottom: '1px solid #E2E6F0' }}>
                      <td colSpan={10} className="p-0">
                        <DetailPanel campaign={c} wsAvg={activeWs!.avgReplyRate} />
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
