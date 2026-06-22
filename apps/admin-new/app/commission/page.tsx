'use client'

import { useEffect, useState, useCallback, useRef } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkspacePrice {
  workspace_id: string
  workspace_name: string
  price_per_lead: number
  client_status: string
  contact_name: string
  campaign_manager: string
  campaign_manager_2: string
  commission_rate: number
  manager_start_date: string | null
}

interface Manager {
  id: number
  name: string
  commission_rate: number
  base_salary: number
}

interface Lead {
  workspace_id: string
  client_name: string
  lead_email: string
  lead_price: number
  date: Date | null
  is_nonlead: boolean
  label: string
}

interface WorkloadAssignment {
  client_workspace_id: string
  manager_name: string
  commission_rate: number
  split_count: number
}

interface WorkloadData {
  managers: Manager[]
  clients: WorkspacePrice[]
  assignments: WorkloadAssignment[]
  defaultRate: number
  currentManager: string | null
  role: string
}

interface AvgLeadPrice {
  avg_lead_price_gbp: number
  total_leads: number
  total_revenue: number
  period: string
}

interface GbpZarRate {
  rate: number
  source: string
}

interface ManagerRate {
  name: string
  commission_rate: number
  base_salary: number
}

interface PayslipMeta {
  exists: boolean
  filename?: string
  uploaded_at?: string
}

interface RevenueLeadsResponse {
  leads: Lead[]
  updatedAt: string | null
}

interface SessionData {
  ok: boolean
  role: 'admin' | 'manager'
  name: string
  commission_rate?: number
}

interface DateRange {
  start: Date
  end: Date
  label: string
}

interface ClientRow {
  name: string
  since: string | null
  leads: number
  earned: number
}

interface EarnerClientStats {
  leads: number
  revenue: number
  commission: number
  commRate: number
  share: number
  startDate: string | null
}

interface EarnerStats {
  [earner: string]: {
    [client: string]: EarnerClientStats
  }
}

type PeriodValue = 'month' | 'lastMonth' | 'quarter' | 'year' | 'all' | 'custom'

// ── Constants ─────────────────────────────────────────────────────────────────

const CLIENT_COLORS = ['#1F6F78', '#224388', '#FFB700', '#7C89CD', '#D2E4F8']

function buildRange(
  period: PeriodValue,
  customStart?: string,
  customEnd?: string
): DateRange {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()

  if (period === 'month') {
    return {
      start: new Date(y, m, 1),
      end: new Date(y, m + 1, 1),
      label: now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    }
  }
  if (period === 'lastMonth') {
    return {
      start: new Date(y, m - 1, 1),
      end: new Date(y, m, 1),
      label: new Date(y, m - 1, 1).toLocaleDateString('en-GB', {
        month: 'long',
        year: 'numeric',
      }),
    }
  }
  if (period === 'quarter') {
    const q = Math.floor(m / 3)
    return {
      start: new Date(y, q * 3, 1),
      end: new Date(y, q * 3 + 3, 1),
      label: `Q${q + 1} ${y}`,
    }
  }
  if (period === 'year') {
    return {
      start: new Date(y, 0, 1),
      end: new Date(y + 1, 0, 1),
      label: `${y}`,
    }
  }
  if (period === 'all') {
    return {
      start: new Date(2020, 0, 1),
      end: new Date(y + 1, 0, 1),
      label: 'All Time',
    }
  }
  // custom
  const s = customStart ?? ''
  const e = customEnd ?? ''
  return {
    start: new Date(s + 'T00:00:00'),
    end: new Date(e + 'T23:59:59'),
    label: `${s} – ${e}`,
  }
}

function fmtZarDirect(zarAmount: number): string {
  return (
    'R' +
    zarAmount.toLocaleString('en-ZA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  )
}

function avatarLetter(name: string): string {
  return (name[0] ?? '?').toUpperCase()
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CommissionPage() {
  // Shared data
  const [session, setSession] = useState<SessionData | null>(null)
  const [allLeads, setAllLeads] = useState<Lead[]>([])
  const [prices, setPrices] = useState<WorkspacePrice[]>([])
  const [workload, setWorkload] = useState<WorkloadData | null>(null)
  const [, setManagers] = useState<Manager[]>([])
  const [avgLeadPrice, setAvgLeadPrice] = useState<number>(0)
  const [zarRate, setZarRate] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Manager view state
  const [managerRate, setManagerRate] = useState<ManagerRate | null>(null)
  const [period, setPeriod] = useState<PeriodValue>('month')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [periodLabel, setPeriodLabel] = useState('')
  const [clientRows, setClientRows] = useState<ClientRow[]>([])
  const [sumComm, setSumComm] = useState('R0.00')
  const [sumLeads, setSumLeads] = useState(0)
  const [sumClients, setSumClients] = useState(0)
  const [sumRate, setSumRate] = useState('—')
  const [salaryDisplay, setSalaryDisplay] = useState('')
  const [sumTotal, setSumTotal] = useState('')
  const [showSalaryCard, setShowSalaryCard] = useState(false)
  const [showTotalCard, setShowTotalCard] = useState(false)
  const [payslipMeta, setPayslipMeta] = useState<PayslipMeta | null>(null)
  const [rateExplanation, setRateExplanation] = useState<{
    avgLead: number
    rate: number
    perLeadGbp: number
    perLeadZar: number
    zarRateDisplay: string
  } | null>(null)

  // Admin view state
  const [adminPeriod, setAdminPeriod] = useState<PeriodValue>('month')
  const [adminCustomStart, setAdminCustomStart] = useState('')
  const [adminCustomEnd, setAdminCustomEnd] = useState('')
  const [adminPeriodLabel, setAdminPeriodLabel] = useState('')
  const [agencyTotal, setAgencyTotal] = useState('£0')
  const [agencyTotalSub, setAgencyTotalSub] = useState('')
  const [earnerStats, setEarnerStats] = useState<EarnerStats>({})
  const [activeEarner, setActiveEarner] = useState<string | null>(null)
  const [effectiveRates, setEffectiveRates] = useState<
    Record<string, Record<string, number>>
  >({})
  const [managerSalaryMap, setManagerSalaryMap] = useState<
    Record<string, number>
  >({})

  // Track init done
  const initDone = useRef(false)

  // ── Build effectiveRates ──────────────────────────────────────────────────

  const buildEffectiveRates = useCallback(
    (
      priceList: WorkspacePrice[],
      mgrList: Manager[],
      workloadData: WorkloadData
    ): Record<string, Record<string, number>> => {
      const defaultRate = workloadData.defaultRate ?? 5
      const mgrRateLookup: Record<string, number> = {}
      const salaryMap: Record<string, number> = {}

      mgrList.forEach((m) => {
        mgrRateLookup[m.name.trim().toLowerCase()] =
          m.commission_rate ?? defaultRate
        salaryMap[m.name.trim()] = m.base_salary ?? 0
      })
      setManagerSalaryMap(salaryMap)

      const wsNameMap: Record<string, string> = {}
      priceList.forEach((p) => {
        wsNameMap[p.workspace_id] = p.workspace_name
      })

      const wsToMgrs: Record<string, Array<{ name: string; rate: number }>> = {}
      ;(workloadData.assignments || []).forEach((a) => {
        const name = wsNameMap[a.client_workspace_id]
        if (!name) return
        if (!wsToMgrs[name]) wsToMgrs[name] = []
        const rate =
          mgrRateLookup[a.manager_name.toLowerCase()] ?? defaultRate
        wsToMgrs[name].push({ name: a.manager_name, rate })
      })

      // Fallback to campaign_manager fields
      priceList.forEach((p) => {
        if (wsToMgrs[p.workspace_name]) return
        const m1 = (p.campaign_manager || '').trim()
        const m2 = (p.campaign_manager_2 || '').trim()
        if (m1 || m2) {
          wsToMgrs[p.workspace_name] = []
          if (m1)
            wsToMgrs[p.workspace_name].push({
              name: m1,
              rate: mgrRateLookup[m1.toLowerCase()] ?? defaultRate,
            })
          if (m2)
            wsToMgrs[p.workspace_name].push({
              name: m2,
              rate: mgrRateLookup[m2.toLowerCase()] ?? defaultRate,
            })
        }
      })

      const rates: Record<string, Record<string, number>> = {}
      Object.entries(wsToMgrs).forEach(([wsName, mgrs]) => {
        rates[wsName] = {}
        mgrs.forEach(({ name, rate }) => {
          rates[wsName][name] = rate
        })
      })
      return rates
    },
    []
  )

  // ── Manager render ────────────────────────────────────────────────────────

  const renderManager = useCallback(
    (
      p: PeriodValue,
      cStart: string,
      cEnd: string,
      leads: Lead[],
      priceList: WorkspacePrice[],
      mgrRate: ManagerRate | null,
      wkld: WorkloadData | null,
      zarRateVal: number | null,
      avgLead: number,
      sessName: string
    ) => {
      const range = buildRange(p, cStart, cEnd)
      setPeriodLabel(range.label)

      const defaultRate = mgrRate?.commission_rate ?? wkld?.defaultRate ?? 5
      const perLeadGbp = avgLead * (defaultRate / 100)
      const perLeadZar = zarRateVal ? perLeadGbp * zarRateVal : perLeadGbp

      // Build my clients
      const myAssigned = new Set(
        (wkld?.assignments || [])
          .filter((a) => a.manager_name === sessName)
          .map((a) => a.client_workspace_id)
      )
      const myClients = priceList.filter(
        (pr) =>
          myAssigned.has(pr.workspace_id) ||
          (pr.campaign_manager &&
            pr.campaign_manager.toLowerCase() === sessName.toLowerCase()) ||
          (pr.campaign_manager_2 &&
            pr.campaign_manager_2.toLowerCase() === sessName.toLowerCase())
      )

      const rows: ClientRow[] = []
      let totalLeads = 0
      for (const c of myClients) {
        const mgrStart = c.manager_start_date
          ? new Date(c.manager_start_date + 'T00:00:00')
          : null
        const filtered = leads.filter(
          (l) =>
            l.client_name === c.workspace_name &&
            l.date &&
            l.date >= range.start &&
            l.date < range.end &&
            (!mgrStart || l.date >= mgrStart)
        )
        if (filtered.length === 0) continue
        const earned = filtered.length * perLeadZar
        totalLeads += filtered.length
        rows.push({
          name: c.workspace_name,
          since: c.manager_start_date,
          leads: filtered.length,
          earned,
        })
      }
      rows.sort((a, b) => b.leads - a.leads)

      const totalCommZar = totalLeads * perLeadZar
      const isThisMonth = p === 'month'
      const salary = mgrRate?.base_salary ?? 0

      let salaryEarned = salary
      let salaryLabel = fmtZarDirect(salary)
      if (isThisMonth && salary > 0) {
        const now = new Date()
        const yr = now.getFullYear()
        const mo = now.getMonth()
        let totalBizDays = 0
        let elapsedBizDays = 0
        const today = now.toISOString().slice(0, 10)
        for (
          let d = new Date(yr, mo, 1);
          d.getMonth() === mo;
          d.setDate(d.getDate() + 1)
        ) {
          const dow = d.getDay()
          if (dow !== 0 && dow !== 6) {
            totalBizDays++
            if (d.toISOString().slice(0, 10) <= today) elapsedBizDays++
          }
        }
        const dailyRate = salary / (totalBizDays || 1)
        salaryEarned = dailyRate * elapsedBizDays
        salaryLabel = `R${salaryEarned.toLocaleString('en-ZA', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} (${elapsedBizDays}/${totalBizDays} days · R${dailyRate.toLocaleString(
          'en-ZA',
          { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        )}/day)`
      }

      const totalZar = salaryEarned + totalCommZar

      setSumComm(
        'R' +
          totalCommZar.toLocaleString('en-ZA', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
      )
      setSumLeads(totalLeads)
      setSumClients(rows.length)
      setSumRate(
        'R' +
          perLeadZar.toLocaleString('en-ZA', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }) +
          '/lead'
      )
      setSalaryDisplay(salaryLabel)
      setSumTotal(
        'R' +
          totalZar.toLocaleString('en-ZA', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
      )
      setShowSalaryCard(salary > 0)
      setShowTotalCard(isThisMonth)
      setClientRows(rows)

      // Rate explanation
      setRateExplanation({
        avgLead,
        rate: defaultRate,
        perLeadGbp,
        perLeadZar,
        zarRateDisplay: zarRateVal ? zarRateVal.toFixed(2) : '23.50',
      })
    },
    []
  )

  // ── Admin render ──────────────────────────────────────────────────────────

  const renderAdmin = useCallback(
    (
      p: PeriodValue,
      cStart: string,
      cEnd: string,
      leads: Lead[],
      rates: Record<string, Record<string, number>>,
      avgLead: number,
      managerStartMap: Record<string, string | null>
    ) => {
      const range = buildRange(p, cStart, cEnd)
      setAdminPeriodLabel(range.label)

      const periodLeads = leads.filter(
        (l) => l.date && l.date >= range.start && l.date < range.end
      )

      const stats: EarnerStats = {}
      periodLeads.forEach((lead) => {
        const clientRates = rates[lead.client_name?.trim()] ?? {}
        if (!Object.keys(clientRates).length) return
        const startDateStr = managerStartMap[lead.client_name?.trim()] ?? null
        if (
          startDateStr &&
          lead.date &&
          lead.date < new Date(startDateStr + 'T00:00:00')
        )
          return
        Object.entries(clientRates).forEach(([earner, ratePct]) => {
          const effectiveRate = ratePct / 100
          if (!stats[earner]) stats[earner] = {}
          if (!stats[earner][lead.client_name]) {
            stats[earner][lead.client_name] = {
              leads: 0,
              revenue: 0,
              commission: 0,
              commRate: effectiveRate,
              share: 1,
              startDate: startDateStr,
            }
          }
          stats[earner][lead.client_name].leads++
          stats[earner][lead.client_name].revenue += lead.lead_price
          stats[earner][lead.client_name].commission +=
            avgLead * effectiveRate
        })
      })

      let agencyComm = 0
      Object.values(stats).forEach((clients) => {
        Object.values(clients).forEach((s) => {
          agencyComm += s.commission
        })
      })

      setAgencyTotal('£' + agencyComm.toFixed(2))
      setAgencyTotalSub(`£${agencyComm.toFixed(0)} commission · ${range.label}`)
      setEarnerStats(stats)

      const earners = Object.keys(stats).sort()
      if (earners.length > 0) {
        setActiveEarner((prev) =>
          earners.includes(prev ?? '') ? prev : earners[0]
        )
      } else {
        setActiveEarner(null)
      }
    },
    []
  )

  // ── Payslip check ─────────────────────────────────────────────────────────

  const checkPayslip = useCallback(async (p: PeriodValue, cStart: string) => {
    const range = buildRange(p, cStart, '')
    const month = range.start.toISOString().slice(0, 7)
    try {
      const res = await fetch(`/api/commission/payslips/${month}/meta`)
      const data: PayslipMeta = await res.json()
      setPayslipMeta(data)
    } catch {
      setPayslipMeta(null)
    }
  }, [])

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (initDone.current) return
    initDone.current = true

    async function init() {
      try {
        // Fetch session from legacy
        const sessRes = await fetch('/api/commission/session')
        if (!sessRes.ok) {
          window.location.href = '/login'
          return
        }
        const sess: SessionData = await sessRes.json()
        if (!sess.ok) {
          window.location.href = '/login'
          return
        }
        setSession(sess)

        const [priceData, mgrData, leadsData, wkldData] = await Promise.all([
          fetch('/api/commission/workspace-prices').then((r) => r.json()) as Promise<WorkspacePrice[]>,
          fetch('/api/commission/managers').then((r) =>
            r.ok ? (r.json() as Promise<Manager[]>) : Promise.resolve([] as Manager[])
          ),
          fetch('/api/commission/revenue-leads').then((r) =>
            r.json()
          ) as Promise<RevenueLeadsResponse>,
          fetch('/api/commission/workload').then((r) =>
            r.json()
          ) as Promise<WorkloadData>,
        ])

        const parsedLeads: Lead[] = (leadsData.leads || [])
          .filter((l: Lead) => !l.is_nonlead)
          .map((l: Lead) => ({ ...l, date: l.date ? new Date(l.date as unknown as string) : null }))

        setPrices(priceData)
        setManagers(mgrData)
        setAllLeads(parsedLeads)
        setWorkload(wkldData)

        const managerStartMap: Record<string, string | null> = {}
        priceData.forEach((p) => {
          managerStartMap[p.workspace_name] = p.manager_start_date ?? null
        })

        const rates = buildEffectiveRates(priceData, mgrData, wkldData)
        setEffectiveRates(rates)

        const avgData: AvgLeadPrice = await fetch(
          '/api/commission/avg-lead-price'
        ).then((r) => r.json())
        const avg = avgData.avg_lead_price_gbp || 0
        setAvgLeadPrice(avg)

        if (sess.role === 'admin') {
          renderAdmin(
            'month',
            '',
            '',
            parsedLeads,
            rates,
            avg,
            managerStartMap
          )
        } else {
          const [zarData, mgrRateData] = await Promise.all([
            fetch('/api/commission/gbp-zar-rate')
              .then((r) => r.json())
              .catch((): GbpZarRate => ({ rate: 23.5, source: 'fallback' })) as Promise<GbpZarRate>,
            fetch('/api/commission/manager-rate')
              .then((r) => r.json())
              .catch((): ManagerRate => ({ name: '', commission_rate: 5, base_salary: 0 })) as Promise<ManagerRate>,
          ])

          const zar = zarData.rate || null
          setZarRate(zar)
          setManagerRate(mgrRateData)

          renderManager(
            'month',
            '',
            '',
            parsedLeads,
            priceData,
            mgrRateData,
            wkldData,
            zar,
            avg,
            sess.name
          )
          await checkPayslip('month', '')
        }
      } catch (err) {
        console.error('[commission init]', err)
        setError(err instanceof Error ? err.message : 'Failed to load commission data')
      } finally {
        setLoading(false)
      }
    }

    init()
  }, [buildEffectiveRates, renderManager, renderAdmin, checkPayslip])

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handlePeriodChange = (val: PeriodValue) => {
    setPeriod(val)
    if (val !== 'custom') {
      renderManager(
        val,
        customStart,
        customEnd,
        allLeads,
        prices,
        managerRate,
        workload,
        zarRate,
        avgLeadPrice,
        session?.name ?? ''
      )
      checkPayslip(val, customStart)
    }
  }

  const handleApplyCustom = () => {
    renderManager(
      'custom',
      customStart,
      customEnd,
      allLeads,
      prices,
      managerRate,
      workload,
      zarRate,
      avgLeadPrice,
      session?.name ?? ''
    )
    checkPayslip('custom', customStart)
  }

  const handleAdminPeriodChange = (val: PeriodValue) => {
    setAdminPeriod(val)
    if (val !== 'custom') {
      const managerStartMap: Record<string, string | null> = {}
      prices.forEach((p) => {
        managerStartMap[p.workspace_name] = p.manager_start_date ?? null
      })
      renderAdmin(
        val,
        adminCustomStart,
        adminCustomEnd,
        allLeads,
        effectiveRates,
        avgLeadPrice,
        managerStartMap
      )
    }
  }

  const handleApplyAdminCustom = () => {
    const managerStartMap: Record<string, string | null> = {}
    prices.forEach((p) => {
      managerStartMap[p.workspace_name] = p.manager_start_date ?? null
    })
    renderAdmin(
      'custom',
      adminCustomStart,
      adminCustomEnd,
      allLeads,
      effectiveRates,
      avgLeadPrice,
      managerStartMap
    )
  }

  const handleDownloadPayslip = (e: React.MouseEvent) => {
    e.preventDefault()
    const range = buildRange(period, customStart, '')
    const month = range.start.toISOString().slice(0, 7)
    window.open(`/api/commission/payslips/${month}`, '_blank')
  }

  // ── Derived admin data ────────────────────────────────────────────────────

  const earners = Object.keys(earnerStats).sort()
  const allClientKeys = Object.keys(effectiveRates)

  // ── Loading / Error states ────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="o-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <span className="o-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="o-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="o-card" style={{ maxWidth: '400px', textAlign: 'center' }}>
          <div className="o-card-body">
            <div style={{ fontWeight: 700, marginBottom: '8px', color: '#050C29' }}>
              Failed to load
            </div>
            <div style={{ color: '#6B7280', fontSize: '13px' }}>{error}</div>
          </div>
        </div>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="o-page">

      {/* ── Manager View ────────────────────────────────────────────────── */}
      {session?.role !== 'admin' && (
        <>
          {/* Header */}
          <div className="o-page-header">
            <div>
              <div className="o-page-title">My Commission</div>
              <div className="o-page-sub">Commission for {session?.name}</div>
            </div>
            <div className="o-page-actions">
              <select
                className="o-select"
                value={period}
                onChange={(e) => handlePeriodChange(e.target.value as PeriodValue)}
              >
                <option value="month">This Month</option>
                <option value="lastMonth">Last Month</option>
                <option value="quarter">This Quarter</option>
                <option value="year">This Year</option>
                <option value="all">All Time</option>
                <option value="custom">Custom Range</option>
              </select>
              {period === 'custom' && (
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    className="o-input"
                    type="date"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                    style={{ width: 'auto' }}
                  />
                  <span style={{ fontSize: '12px', color: '#6B7280' }}>to</span>
                  <input
                    className="o-input"
                    type="date"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    style={{ width: 'auto' }}
                  />
                  <button className="o-btn o-btn-primary o-btn-sm" onClick={handleApplyCustom}>
                    Apply
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Summary cards */}
          <div className="o-metrics o-metrics-auto" style={{ marginBottom: '1.5rem' }}>
            {/* Commission Earned */}
            <div className="o-metric" style={{ borderTopColor: '#16A34A' }}>
              <div className="o-metric-label">Commission Earned</div>
              <div className="o-metric-val" style={{ color: '#16A34A' }}>{sumComm}</div>
            </div>
            {/* Leads Delivered */}
            <div className="o-metric" style={{ borderTopColor: '#224388' }}>
              <div className="o-metric-label">Leads Delivered</div>
              <div className="o-metric-val">{String(sumLeads)}</div>
            </div>
            {/* Active Clients */}
            <div className="o-metric" style={{ borderTopColor: '#D97706' }}>
              <div className="o-metric-label">Active Clients</div>
              <div className="o-metric-val" style={{ color: '#D97706' }}>{String(sumClients)}</div>
            </div>
            {/* Rate per Lead */}
            <div className="o-metric" style={{ borderTopColor: '#1F6F78' }}>
              <div className="o-metric-label">Rate per Lead</div>
              <div className="o-metric-val" style={{ fontSize: '1.1rem' }}>{sumRate}</div>
            </div>

            {/* Rate explanation card */}
            {rateExplanation && (
              <div className="o-metric" style={{ borderTopColor: '#7C89CD' }}>
                <div className="o-metric-label">How your rate is calculated</div>
                <div style={{ fontSize: '11px', color: '#6B7280', marginTop: '6px', lineHeight: 1.6 }}>
                  All-time avg lead:{' '}
                  <strong>£{rateExplanation.avgLead.toFixed(2)}</strong>
                  <br />
                  × {rateExplanation.rate}% commission = £
                  {rateExplanation.perLeadGbp.toFixed(2)}
                  <br />
                  × R{rateExplanation.zarRateDisplay}/GBP
                  <br />
                  ={' '}
                  <strong style={{ color: '#16A34A' }}>
                    R{rateExplanation.perLeadZar.toFixed(2)} per lead
                  </strong>
                </div>
              </div>
            )}

            {/* Base Salary */}
            {showSalaryCard && (
              <div className="o-metric" style={{ borderTopColor: '#1F6F78' }}>
                <div className="o-metric-label">Base Salary</div>
                <div style={{ fontSize: '13px', fontWeight: 600, marginTop: '4px', color: '#050C29' }}>
                  {salaryDisplay}
                </div>
              </div>
            )}

            {/* Total This Month */}
            {showTotalCard && (
              <div className="o-metric" style={{ borderTopColor: '#16A34A' }}>
                <div className="o-metric-label">Total This Month</div>
                <div className="o-metric-val">{sumTotal}</div>
                <div className="o-metric-sub">Salary + commission</div>
              </div>
            )}

            {/* Pay Slip */}
            {payslipMeta?.exists && (
              <div className="o-metric" style={{ borderTopColor: '#1F6F78' }}>
                <div className="o-metric-label">Pay Slip</div>
                <div style={{ marginTop: '8px' }}>
                  <a
                    href="#"
                    onClick={handleDownloadPayslip}
                    className="o-btn o-btn-primary o-btn-sm"
                    style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  >
                    ↓ Download
                  </a>
                </div>
                {payslipMeta.filename && (
                  <div className="o-metric-sub" style={{ marginTop: '6px' }}>
                    {payslipMeta.filename}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Client Breakdown table */}
          <div className="o-card" style={{ marginBottom: '1.5rem' }}>
            <div className="o-card-header">
              <div className="o-card-title">Client Breakdown</div>
              <span style={{ fontSize: '12px', color: '#6B7280' }}>{periodLabel}</span>
            </div>
            <div className="o-table-wrap">
              <table className="o-table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Managing Since</th>
                    <th style={{ textAlign: 'center' }}>Leads</th>
                    <th style={{ textAlign: 'right' }}>Commission Earned</th>
                  </tr>
                </thead>
                <tbody>
                  {clientRows.length === 0 ? (
                    <tr>
                      <td colSpan={4}>
                        <div className="o-empty">No leads delivered in this period</div>
                      </td>
                    </tr>
                  ) : (
                    clientRows.map((row, i) => (
                      <tr key={i}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <div
                              style={{
                                width: '34px',
                                height: '34px',
                                borderRadius: '8px',
                                background: '#1F6F78',
                                color: '#fff',
                                fontWeight: 700,
                                fontSize: '14px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                              }}
                            >
                              {avatarLetter(row.name)}
                            </div>
                            <span style={{ fontWeight: 600 }}>{row.name}</span>
                          </div>
                        </td>
                        <td style={{ color: '#6B7280', fontSize: '12px' }}>
                          {row.since ?? '—'}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>
                          {row.leads}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: '#16A34A' }}>
                          R
                          {row.earned.toLocaleString('en-ZA', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── Admin View ──────────────────────────────────────────────────── */}
      {session?.role === 'admin' && (
        <>
          {/* Header */}
          <div className="o-page-header">
            <div>
              <div className="o-page-title">Commission Tracker</div>
              <div className="o-page-sub">{adminPeriodLabel}</div>
            </div>
            <div className="o-page-actions">
              <select
                className="o-select"
                value={adminPeriod}
                onChange={(e) => handleAdminPeriodChange(e.target.value as PeriodValue)}
              >
                <option value="month">This Month</option>
                <option value="lastMonth">Last Month</option>
                <option value="quarter">This Quarter</option>
                <option value="year">This Year</option>
                <option value="all">All Time</option>
                <option value="custom">Custom Range</option>
              </select>
              {adminPeriod === 'custom' && (
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    className="o-input"
                    type="date"
                    value={adminCustomStart}
                    onChange={(e) => setAdminCustomStart(e.target.value)}
                    style={{ width: 'auto' }}
                  />
                  <span style={{ fontSize: '12px', color: '#6B7280' }}>to</span>
                  <input
                    className="o-input"
                    type="date"
                    value={adminCustomEnd}
                    onChange={(e) => setAdminCustomEnd(e.target.value)}
                    style={{ width: 'auto' }}
                  />
                  <button className="o-btn o-btn-primary o-btn-sm" onClick={handleApplyAdminCustom}>
                    Apply
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Comm layout — agency card + earner panel */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '220px 1fr',
              gap: '1.25rem',
              marginBottom: '2rem',
              alignItems: 'start',
            }}
          >
            {/* Agency card */}
            <div
              style={{
                background: '#050C29',
                borderRadius: '12px',
                padding: '1.5rem',
                boxShadow: '0 1px 3px rgba(5,12,41,.12)',
              }}
            >
              <div style={{ fontSize: '26px', marginBottom: '.75rem' }}>👁</div>
              <div
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'rgba(255,255,255,.5)',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  marginBottom: '6px',
                }}
              >
                Agency Commission
              </div>
              <div
                style={{
                  fontFamily: "'Genos', sans-serif",
                  fontSize: '38px',
                  fontWeight: 700,
                  color: '#FFB700',
                  lineHeight: 1,
                }}
              >
                {agencyTotal}
              </div>
              <div
                style={{
                  fontSize: '12px',
                  color: 'rgba(255,255,255,.35)',
                  marginTop: '6px',
                }}
              >
                {agencyTotalSub}
              </div>
            </div>

            {/* Earner panel */}
            <div className="o-card" style={{ overflow: 'hidden' }}>
              {/* Earner tabs */}
              <div
                style={{
                  display: 'flex',
                  gap: '.5rem',
                  padding: '1rem 1.25rem',
                  borderBottom: '2px solid #E2E6F0',
                  flexWrap: 'wrap',
                }}
              >
                {earners.length === 0 ? (
                  <span style={{ color: '#6B7280', fontSize: '13px' }}>
                    No commission data for this period
                  </span>
                ) : (
                  earners.map((earner) => (
                    <button
                      key={earner}
                      onClick={() => setActiveEarner(earner)}
                      className={'o-btn' + (activeEarner === earner ? ' o-btn-primary' : ' o-btn-ghost')}
                      style={{
                        fontFamily: "'Genos', sans-serif",
                        fontSize: '18px',
                        fontWeight: 700,
                      }}
                    >
                      {earner}
                    </button>
                  ))
                )}
              </div>

              {/* Earner detail */}
              {activeEarner && earnerStats[activeEarner] ? (
                <EarnerDetail
                  earner={activeEarner}
                  clients={earnerStats[activeEarner]}
                  salary={managerSalaryMap[activeEarner] ?? 0}
                  allClientKeys={allClientKeys}
                />
              ) : (
                <p style={{ color: '#6B7280', padding: '1.5rem', fontSize: '13px' }}>
                  {earners.length === 0
                    ? 'No commission data for this period'
                    : 'Select a manager above'}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface EarnerClientStats {
  leads: number
  revenue: number
  commission: number
  commRate: number
  share: number
  startDate: string | null
}

function EarnerDetail({
  earner,
  clients,
  salary,
  allClientKeys,
}: {
  earner: string
  clients: Record<string, EarnerClientStats>
  salary: number
  allClientKeys: string[]
}) {
  const entries = Object.entries(clients).sort(
    (a, b) => b[1].revenue - a[1].revenue
  )
  const totalLeads = entries.reduce((s, [, c]) => s + c.leads, 0)
  const totalCommission = entries.reduce(
    (s, [, c]) => s + (c.commission ?? c.revenue * c.commRate),
    0
  )

  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid #E2E6F0',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "'Genos', sans-serif",
              fontSize: '26px',
              fontWeight: 700,
              color: '#050C29',
            }}
          >
            {earner}
          </div>
          <div style={{ fontSize: '13px', color: '#6B7280', marginTop: '2px' }}>
            {entries.length} client{entries.length !== 1 ? 's' : ''} · {totalLeads}{' '}
            lead{totalLeads !== 1 ? 's' : ''}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            gap: '1.5rem',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          {salary > 0 && (
            <div style={{ textAlign: 'right' }}>
              <div
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: '#6B7280',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  marginBottom: '4px',
                }}
              >
                Base Salary
              </div>
              <div
                style={{
                  fontFamily: "'Genos', sans-serif",
                  fontSize: '22px',
                  fontWeight: 700,
                  color: '#6B7280',
                }}
              >
                R
                {salary.toLocaleString('en-ZA', {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 0,
                })}
                <span style={{ fontSize: '13px' }}>/mo</span>
              </div>
            </div>
          )}
          <div style={{ textAlign: 'right' }}>
            <div
              style={{
                fontSize: '11px',
                fontWeight: 600,
                color: '#6B7280',
                textTransform: 'uppercase',
                letterSpacing: '1px',
                marginBottom: '4px',
              }}
            >
              Commission
            </div>
            <div
              style={{
                fontFamily: "'Genos', sans-serif",
                fontSize: '30px',
                fontWeight: 700,
                color: '#1F6F78',
                lineHeight: 1,
              }}
            >
              £{totalCommission.toFixed(2)}
            </div>
          </div>
          {salary > 0 && (
            <div style={{ textAlign: 'right' }}>
              <div
                style={{
                  fontSize: '10px',
                  fontWeight: 600,
                  color: '#6B7280',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                }}
              >
                Note: salary paid in ZAR separately
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Client rows */}
      {entries.map(([client, stats], i) => {
        const commission = stats.commission ?? stats.revenue * stats.commRate
        const colorIdx = allClientKeys.indexOf(client)
        const color = CLIENT_COLORS[colorIdx % CLIENT_COLORS.length]
        return (
          <div
            key={client}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '1rem 1.5rem',
              borderBottom: i < entries.length - 1 ? '1px solid #E2E6F0' : 'none',
              flexWrap: 'wrap',
              gap: '.5rem',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                fontWeight: 600,
                fontSize: '13px',
                color: '#050C29',
              }}
            >
              <div
                style={{
                  width: '30px',
                  height: '30px',
                  borderRadius: '7px',
                  background: color,
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {client.charAt(0).toUpperCase()}
              </div>
              {client}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '1.25rem',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: '12px', color: '#6B7280', fontWeight: 500 }}>
                {stats.leads} lead{stats.leads !== 1 ? 's' : ''}
              </span>
              <span className="o-status o-status-good">
                £{commission.toFixed(2)}
              </span>
              {stats.startDate && (
                <span style={{ fontSize: '11px', color: '#6B7280' }}>
                  from {stats.startDate}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
