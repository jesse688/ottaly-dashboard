'use client'

import { useEffect, useState, useCallback } from 'react'

interface CampaignFlag {
  type: 'critical' | 'warning' | 'info'
  msg: string
}

interface VariantInsight {
  msg: string
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
}

interface Workspace {
  id: string
  name: string
  avgReplyRate: number
  activeCampaigns: number
  totalSent: number
  campaigns: Campaign[]
}

interface IntelligenceData {
  workspaces: Workspace[]
  optimisations?: Array<{ id: string; msg: string }>
  updatedAt: string
}

type SortKey = 'sent' | 'exhaustion' | 'replyRate' | 'bounceRate' | 'positivePct' | 'leads'

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

// Legacy-style status badge
function StatusBadge({ status }: { status: string }) {
  const s = (status || '').toLowerCase()
  const className =
    s === 'active'    ? 'status-badge active' :
    s === 'paused'    ? 'status-badge paused' :
    s === 'completed' ? 'status-badge completed' :
                        'status-badge draft'
  return <span className={className}>{status || '—'}</span>
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
        style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', color: active ? '#224388' : undefined }}
        onClick={() => handleSort(col)}
      >
        {label}{' '}
        <span style={{ display: 'inline-block', width: 10, marginLeft: 4, fontSize: 10, color: '#224388' }}>
          {active ? (sortDir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </th>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="o-page">

      {/* Alert banner */}
      {critAlerts.length > 0 && (
        <div style={{ background: '#FEF3C7', borderBottom: '2px solid #FCD34D', padding: '10px 0', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontWeight: 500, color: '#92400E', marginBottom: 20 }}>
          ⚠️ <strong>{critAlerts.length} critical issue{critAlerts.length > 1 ? 's' : ''}:</strong>{' '}
          {critAlerts.slice(0, 3).join(' · ')}{critAlerts.length > 3 ? ` +${critAlerts.length - 3} more` : ''}
        </div>
      )}

      {/* Page header */}
      <div className="o-page-header">
        <div>
          <div className="o-page-title">Campaign Intelligence</div>
          <div className="o-page-sub">
            {loading ? 'Loading…' : updatedAt || '—'}
          </div>
        </div>
        <div className="o-page-actions">
          <div className="o-search-wrap">
            <span className="o-search-icon">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="9" cy="9" r="6" stroke="#6B7280" strokeWidth="2" />
                <path d="M13.5 13.5L17 17" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            <input
              type="text"
              placeholder="Search campaigns…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Summary metrics */}
      <div className="o-metrics o-metrics-auto" style={{ marginBottom: 24 }}>
        {[
          { label: 'Total Campaigns', value: allCampaigns.length,                                    accent: '#224388' },
          { label: 'Active',          value: allCampaigns.filter(c => c.status === 'ACTIVE').length, accent: '#1F6F78' },
          { label: 'Top Performers',  value: allCampaigns.filter(c => c.tier === 'top').length,      accent: '#16A34A' },
          { label: 'Need Attention',  value: allCampaigns.filter(c => c.tier === 'warning').length,  accent: '#D97706' },
          { label: 'Critical',        value: allCampaigns.filter(c => c.tier === 'critical').length, accent: '#DC2626' },
          { label: 'Avg Reply Rate',  value: `${(avgReply * 100).toFixed(2)}%`,                      accent: '#224388' },
        ].map(card => (
          <div key={card.label} className="o-metric" style={{ borderTopColor: card.accent }}>
            <div className="o-metric-label">{card.label}</div>
            <div className="o-metric-val" style={{ color: card.accent }}>{loading ? '—' : card.value}</div>
          </div>
        ))}
      </div>

      {/* Suggested Optimisations */}
      {data && data.optimisations?.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              Suggested Optimisations{' '}
              <span style={{ background: '#FEF3C7', color: '#92400E', padding: '2px 8px', borderRadius: 9999, fontSize: 12, marginLeft: 6 }}>
                {data.optimisations.length} found
              </span>
            </div>
            <button className="o-btn o-btn-ghost o-btn-sm" onClick={() => setOptsVisible(v => !v)}>
              {optsVisible ? 'Hide' : 'Show'}
            </button>
          </div>
          {optsVisible && data.optimisations.map((o, i) => {
            const st = optStatuses[i]
            return (
              <div key={i} className="o-card" style={{ borderLeft: `4px solid ${o.confidence === 'high' ? '#059669' : '#D97706'}`, marginBottom: 8 }}>
                <div className="o-card-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
                      {o.wsName} — {o.campName}
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 9999, marginLeft: 6, background: o.confidence === 'high' ? '#D1FAE5' : '#FEF3C7', color: o.confidence === 'high' ? '#065F46' : '#92400E' }}>
                        {o.confidence === 'high' ? 'High confidence' : 'Medium confidence'}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.6 }}>
                      Step {o.step} · Winner: <strong>Variant {o.winner.variation}</strong>{' '}
                      ({(o.winner.rate * 100).toFixed(2)}% reply rate, {o.winner.reply} replies from {o.winner.sent.toLocaleString()} sends) ·
                      Pause: {o.losers.map(l => `Variant ${l.variation} (${(l.rate * 100).toFixed(2)}%)`).join(', ')}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                    {st && typeof st === 'string' && st !== 'applying' && st !== 'applied' && (
                      <span style={{ fontSize: 12, color: '#DC2626' }}>{st}</span>
                    )}
                    {st === 'applied' ? (
                      <span style={{ padding: '6px 12px', background: '#D1FAE5', color: '#065F46', borderRadius: 6, fontSize: 12, fontWeight: 600 }}>✓ Applied</span>
                    ) : (
                      <button
                        className="o-btn o-btn-teal o-btn-sm"
                        disabled={st === 'applying'}
                        onClick={() => applyOpt(i)}
                        style={st === 'applying' ? { background: '#9CA3AF', cursor: 'not-allowed' } : {}}
                      >
                        {st === 'applying' ? <><span className="o-spin" /> Applying…</> : 'Apply in PlusVibe'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Targeting Intelligence */}
      {data && data.targetingPatterns?.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
            Targeting Intelligence{' '}
            <span style={{ fontSize: 12, fontWeight: 400, color: '#6B7280' }}>— which Apollo targeting combinations perform best across all clients</span>
          </div>
          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: '1fr 1fr' }}>
            {data.targetingPatterns.slice(0, 10).map((p, i) => {
              const rr = (p.avgReplyRate * 100).toFixed(2)
              const tier = p.avgReplyRate >= 0.025 ? 'top' : p.avgReplyRate >= 0.01 ? 'good' : p.avgReplyRate >= 0.005 ? 'warning' : 'critical'
              const maxRate = data.targetingPatterns[0].avgReplyRate
              const barW = maxRate > 0 ? Math.round(p.avgReplyRate / maxRate * 100) : 0
              const rateColor = tier === 'top' ? '#059669' : tier === 'good' ? '#10B981' : tier === 'warning' ? '#D97706' : '#DC2626'
              const parts = [p.titleKey, p.sizeKey, p.kwKey].filter(Boolean)
              return (
                <div key={i} className="o-card">
                  <div className="o-card-body">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {parts.map(s => (
                          <span key={s} style={{ background: '#F3F4F6', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>{s}</span>
                        ))}
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: rateColor }}>{rr}%</div>
                    </div>
                    <div style={{ height: 4, background: '#E2E6F0', borderRadius: 2, marginBottom: 6 }}>
                      <div style={{ width: `${barW}%`, height: 4, borderRadius: 2, background: '#1F6F78' }} />
                    </div>
                    <div style={{ fontSize: 11, color: '#6B7280' }}>
                      {p.count} campaigns · {p.totalSent.toLocaleString()} total sends
                      · {p.campaigns.slice(0, 2).map(c => c.wsName).join(', ')}{p.count > 2 ? ` +${p.count - 2} more` : ''}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Workspace tabs */}
      {data && (
        <div style={{ overflowX: 'auto', marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 6, minWidth: 'max-content', paddingBottom: 2 }}>
            {data.workspaces.map((ws, i) => {
              const critCount = ws.campaigns.filter(c => c.tier === 'critical').length
              const dotColor = critCount > 0 ? '#DC2626' : ws.campaigns.some(c => c.tier === 'top') ? '#059669' : '#9CA3AF'
              return (
                <button
                  key={ws.id}
                  onClick={() => switchWs(i)}
                  className={'o-pill' + (i === activeWsIdx ? ' o-pill-active' : '')}
                >
                  <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 6, verticalAlign: 'middle', background: dotColor }} />
                  {ws.name}
                  {critCount > 0 && (
                    <span style={{ background: '#DC2626', color: '#fff', borderRadius: 9999, padding: '1px 6px', fontSize: 10, marginLeft: 4 }}>{critCount}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Campaign table */}
      <div className="o-card" style={{ marginBottom: 20 }}>
        <div className="o-card-header">
          <div>
            <div className="o-card-title">{activeWs?.name ?? '—'}</div>
            {activeWs && (
              <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>
                {activeWs.campaigns.length} campaigns · {activeWs.activeCampaigns} active · {activeWs.totalSent.toLocaleString()} total sends · avg reply rate {(activeWs.avgReplyRate * 100).toFixed(2)}%
              </div>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#6B7280' }}>Click a campaign to expand</div>
        </div>

        <div className="o-table-wrap">
          <table className="o-table">
            <thead>
              <tr>
                <th style={{ width: 24 }} />
                <th>Campaign</th>
                <th>Status</th>
                <SortTh col="sent"        label="Sent" />
                <SortTh col="exhaustion"  label="Data Used" />
                <SortTh col="replyRate"   label="Reply Rate" />
                <SortTh col="bounceRate"  label="Bounce Rate" />
                <SortTh col="positivePct" label="Positive %" />
                <SortTh col="leads"       label="Leads" />
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={10}><div className="o-empty"><span className="o-spin" /> Loading…</div></td></tr>
              ) : error ? (
                <tr><td colSpan={10}><div className="o-empty">{error}</div></td></tr>
              ) : filteredCampaigns.length === 0 ? (
                <tr><td colSpan={10}><div className="o-empty">No campaigns match</div></td></tr>
              ) : filteredCampaigns.map(c => {
                const rr = (c.replyRate * 100).toFixed(2)
                const rrExNum = c.sent > 0
                  ? ((c.posReplies + c.negReplies + (c.neutralReplies || 0)) / c.sent * 100)
                  : null
                const rrEx = rrExNum !== null ? rrExNum.toFixed(2) : null
                const showEx = rrEx !== null && Math.abs(parseFloat(rr) - parseFloat(rrEx)) > 0.05
                const prr = c.replies > 0 ? ((c.posReplies / c.replies) * 100).toFixed(0) : '—'
                const _lr = c.sent > 0 && c.leads > 0 ? ((c.leads / c.sent) * 100).toFixed(2) + '%' : '—'
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
                    style={{ cursor: 'pointer', borderBottom: '1px solid #E2E6F0' }}
                    onClick={() => toggleDetail(c.id)}
                    onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).querySelectorAll('td').forEach(td => (td.style.background = '#FAFBFF'))}
                    onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).querySelectorAll('td').forEach(td => (td.style.background = ''))}
                  >
                    <td style={{ color: '#6B7280' }}>
                      <span style={{ display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▶</span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 13, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.name}>
                        {shortName(c.name)}
                      </div>
                      {apolloSummary && (
                        <div style={{ fontSize: 11, marginTop: 2, color: '#7C89CD' }}>{apolloSummary}</div>
                      )}
                    </td>
                    <td><StatusBadge status={c.status} /></td>
                    <td style={{ fontWeight: 600 }}>{c.sent.toLocaleString()}</td>
                    <td>
                      {c.leadContacted > 0
                        ? <ExhaustBar pct={exPct} color={exColor} />
                        : <span style={{ color: '#6B7280', fontSize: 11 }}>—</span>
                      }
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <TierDot tier={c.tier} />
                        <RateVal tier={c.tier}>{c.sent < 50 ? '—' : rr + '%'}</RateVal>
                      </div>
                      {showEx && (
                        <div style={{ fontSize: 11, marginTop: 2, color: '#7C89CD' }}>{rrEx}% excl. OOO</div>
                      )}
                    </td>
                    <td>
                      {bounceRate === null
                        ? '—'
                        : <span style={{ fontWeight: 600, color: bounceColor }}>{bounceRate.toFixed(2)}%</span>
                      }
                    </td>
                    <td>
                      {c.sent >= 50 && c.replies > 0 ? prr + '%' : '—'}
                    </td>
                    <td style={{ fontWeight: 600 }}>{c.leads}</td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {allFlags.slice(0, 2).map((f, fi) => (
                          <FlagChip key={fi} flag={f} />
                        ))}
                      </div>
                    </td>
                  </tr>,
                  expanded && (
                    <tr key={`detail-${c.id}`} style={{ background: '#F8FAFF', borderBottom: '1px solid #E2E6F0' }}>
                      <td colSpan={10} style={{ padding: 0 }}>
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
