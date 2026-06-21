'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { PageShell } from '@/components/shell/page-shell'
import { KpiCard } from '@/components/ui/kpi-card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { PeriodFilter, periodRange, type PeriodKey } from '@/components/ui/period-filter'
import { StatusBadge } from '@/components/ui/status-badge'

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

interface DateRange {
  start: Date
  end: Date
}

type Status = 'loading' | 'ok' | 'empty' | 'error'

// ── Period setup ──────────────────────────────────────────────────────────────
// Reuse the design-system PeriodFilter. We restrict to the presets the legacy
// commission page exposed and add an "all time" pseudo-preset.

// PeriodFilter is typed to PeriodKey; commission adds an "all time" pseudo-key.
type CommPeriod = PeriodKey | 'all'

const COMMISSION_PRESETS: { key: PeriodKey; label: string }[] = [
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'this_year', label: 'This Year' },
  // 'all' is not a real PeriodKey; cast at the filter boundary below.
  { key: 'all' as PeriodKey, label: 'All Time' },
]

// `periodRange` doesn't know "all" — handle it locally and return real Dates.
function rangeFor(p: CommPeriod): DateRange {
  if (p === 'all') {
    return { start: new Date(2020, 0, 1), end: new Date(new Date().getFullYear() + 1, 0, 1) }
  }
  const { start, end } = periodRange(p)
  return {
    start: new Date(start + 'T00:00:00'),
    // `end` is inclusive (YYYY-MM-DD of the last day) — push to next-day exclusive.
    end: new Date(new Date(end + 'T00:00:00').getTime() + 24 * 60 * 60 * 1000),
  }
}

function monthOf(p: CommPeriod): string {
  return rangeFor(p).start.toISOString().slice(0, 7)
}

// ── Format helpers ─────────────────────────────────────────────────────────────

const zar = (amount: number) =>
  'R' + amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const gbp = (amount: number) => '£' + amount.toFixed(2)
const num = (n: number) => (n || 0).toLocaleString()

// ── Main component ────────────────────────────────────────────────────────────

export default function CommissionPage() {
  // Shared data
  const [session, setSession] = useState<SessionData | null>(null)
  const [allLeads, setAllLeads] = useState<Lead[]>([])
  const [prices, setPrices] = useState<WorkspacePrice[]>([])
  const [workload, setWorkload] = useState<WorkloadData | null>(null)
  const [avgLeadPrice, setAvgLeadPrice] = useState<number>(0)
  const [zarRate, setZarRate] = useState<number | null>(null)
  const [managerRate, setManagerRate] = useState<ManagerRate | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [errMsg, setErrMsg] = useState('')

  // Period (single control drives both views)
  const [period, setPeriod] = useState<CommPeriod>('this_month')

  // Manager view derived state
  const [clientRows, setClientRows] = useState<ClientRow[]>([])
  const [sumCommZar, setSumCommZar] = useState(0)
  const [sumLeads, setSumLeads] = useState(0)
  const [sumClients, setSumClients] = useState(0)
  const [perLeadZar, setPerLeadZar] = useState(0)
  const [salaryEarnedZar, setSalaryEarnedZar] = useState(0)
  const [salaryNote, setSalaryNote] = useState('')
  const [totalZar, setTotalZar] = useState(0)
  const [showSalary, setShowSalary] = useState(false)
  const [showTotal, setShowTotal] = useState(false)
  const [payslipMeta, setPayslipMeta] = useState<PayslipMeta | null>(null)
  const [rateExplanation, setRateExplanation] = useState<{
    avgLead: number
    rate: number
    perLeadGbp: number
    perLeadZar: number
    zarRateDisplay: string
  } | null>(null)

  // Admin view derived state
  const [agencyCommGbp, setAgencyCommGbp] = useState(0)
  const [earnerStats, setEarnerStats] = useState<EarnerStats>({})
  const [activeEarner, setActiveEarner] = useState<string | null>(null)
  const [effectiveRates, setEffectiveRates] = useState<Record<string, Record<string, number>>>({})
  const [managerSalaryMap, setManagerSalaryMap] = useState<Record<string, number>>({})

  const initDone = useRef(false)

  // ── Build effectiveRates ──────────────────────────────────────────────────

  const buildEffectiveRates = useCallback(
    (
      priceList: WorkspacePrice[],
      mgrList: Manager[],
      workloadData: WorkloadData,
    ): { rates: Record<string, Record<string, number>>; salaryMap: Record<string, number> } => {
      const defaultRate = workloadData.defaultRate ?? 5
      const mgrRateLookup: Record<string, number> = {}
      const salaryMap: Record<string, number> = {}

      mgrList.forEach((m) => {
        mgrRateLookup[m.name.trim().toLowerCase()] = m.commission_rate ?? defaultRate
        salaryMap[m.name.trim()] = m.base_salary ?? 0
      })

      const wsNameMap: Record<string, string> = {}
      priceList.forEach((p) => {
        wsNameMap[p.workspace_id] = p.workspace_name
      })

      const wsToMgrs: Record<string, Array<{ name: string; rate: number }>> = {}
      ;(workloadData.assignments || []).forEach((a) => {
        const name = wsNameMap[a.client_workspace_id]
        if (!name) return
        if (!wsToMgrs[name]) wsToMgrs[name] = []
        const rate = mgrRateLookup[a.manager_name.toLowerCase()] ?? defaultRate
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
      return { rates, salaryMap }
    },
    [],
  )

  // ── Manager render ────────────────────────────────────────────────────────

  const renderManager = useCallback(
    (
      p: CommPeriod,
      leads: Lead[],
      priceList: WorkspacePrice[],
      mgrRate: ManagerRate | null,
      wkld: WorkloadData | null,
      zarRateVal: number | null,
      avgLead: number,
      sessName: string,
    ) => {
      const range = rangeFor(p)

      const defaultRate = mgrRate?.commission_rate ?? wkld?.defaultRate ?? 5
      const perLeadGbp = avgLead * (defaultRate / 100)
      const leadZar = zarRateVal ? perLeadGbp * zarRateVal : perLeadGbp

      const myAssigned = new Set(
        (wkld?.assignments || [])
          .filter((a) => a.manager_name === sessName)
          .map((a) => a.client_workspace_id),
      )
      const myClients = priceList.filter(
        (pr) =>
          myAssigned.has(pr.workspace_id) ||
          (pr.campaign_manager && pr.campaign_manager.toLowerCase() === sessName.toLowerCase()) ||
          (pr.campaign_manager_2 && pr.campaign_manager_2.toLowerCase() === sessName.toLowerCase()),
      )

      const rows: ClientRow[] = []
      let totalLeads = 0
      for (const c of myClients) {
        const mgrStart = c.manager_start_date ? new Date(c.manager_start_date + 'T00:00:00') : null
        const filtered = leads.filter(
          (l) =>
            l.client_name === c.workspace_name &&
            l.date &&
            l.date >= range.start &&
            l.date < range.end &&
            (!mgrStart || l.date >= mgrStart),
        )
        if (filtered.length === 0) continue
        totalLeads += filtered.length
        rows.push({
          name: c.workspace_name,
          since: c.manager_start_date,
          leads: filtered.length,
          earned: filtered.length * leadZar,
        })
      }
      rows.sort((a, b) => b.leads - a.leads)

      const totalCommZar = totalLeads * leadZar
      const isThisMonth = p === 'this_month'
      const salary = mgrRate?.base_salary ?? 0

      let salaryAmt = salary
      let note = ''
      if (isThisMonth && salary > 0) {
        const now = new Date()
        const yr = now.getFullYear()
        const mo = now.getMonth()
        let totalBizDays = 0
        let elapsedBizDays = 0
        const today = now.toISOString().slice(0, 10)
        for (let d = new Date(yr, mo, 1); d.getMonth() === mo; d.setDate(d.getDate() + 1)) {
          const dow = d.getDay()
          if (dow !== 0 && dow !== 6) {
            totalBizDays++
            if (d.toISOString().slice(0, 10) <= today) elapsedBizDays++
          }
        }
        const dailyRate = salary / (totalBizDays || 1)
        salaryAmt = dailyRate * elapsedBizDays
        note = `${elapsedBizDays}/${totalBizDays} days · ${zar(dailyRate)}/day`
      }

      setPerLeadZar(leadZar)
      setSumCommZar(totalCommZar)
      setSumLeads(totalLeads)
      setSumClients(rows.length)
      setSalaryEarnedZar(salaryAmt)
      setSalaryNote(note)
      setTotalZar(salaryAmt + totalCommZar)
      setShowSalary(salary > 0)
      setShowTotal(isThisMonth)
      setClientRows(rows)

      setRateExplanation({
        avgLead,
        rate: defaultRate,
        perLeadGbp,
        perLeadZar: leadZar,
        zarRateDisplay: zarRateVal ? zarRateVal.toFixed(2) : '23.50',
      })
    },
    [],
  )

  // ── Admin render ──────────────────────────────────────────────────────────

  const renderAdmin = useCallback(
    (
      p: CommPeriod,
      leads: Lead[],
      rates: Record<string, Record<string, number>>,
      avgLead: number,
      managerStartMap: Record<string, string | null>,
    ) => {
      const range = rangeFor(p)
      const periodLeads = leads.filter((l) => l.date && l.date >= range.start && l.date < range.end)

      const stats: EarnerStats = {}
      periodLeads.forEach((lead) => {
        const clientRates = rates[lead.client_name?.trim()] ?? {}
        if (!Object.keys(clientRates).length) return
        const startDateStr = managerStartMap[lead.client_name?.trim()] ?? null
        if (startDateStr && lead.date && lead.date < new Date(startDateStr + 'T00:00:00')) return
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
          stats[earner][lead.client_name].commission += avgLead * effectiveRate
        })
      })

      let agencyComm = 0
      Object.values(stats).forEach((clients) => {
        Object.values(clients).forEach((s) => {
          agencyComm += s.commission
        })
      })

      setAgencyCommGbp(agencyComm)
      setEarnerStats(stats)

      const earnerKeys = Object.keys(stats).sort()
      if (earnerKeys.length > 0) {
        setActiveEarner((prev) => (earnerKeys.includes(prev ?? '') ? prev : earnerKeys[0]))
      } else {
        setActiveEarner(null)
      }
    },
    [],
  )

  // ── Payslip check ─────────────────────────────────────────────────────────

  const checkPayslip = useCallback(async (p: CommPeriod) => {
    try {
      const res = await fetch(`/api/commission/payslips/${monthOf(p)}/meta`)
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
            r.ok ? (r.json() as Promise<Manager[]>) : Promise.resolve([] as Manager[]),
          ),
          fetch('/api/commission/revenue-leads').then((r) => r.json()) as Promise<RevenueLeadsResponse>,
          fetch('/api/commission/workload').then((r) => r.json()) as Promise<WorkloadData>,
        ])

        const parsedLeads: Lead[] = (leadsData.leads || [])
          .filter((l: Lead) => !l.is_nonlead)
          .map((l: Lead) => ({ ...l, date: l.date ? new Date(l.date as unknown as string) : null }))

        setPrices(priceData)
        setAllLeads(parsedLeads)
        setWorkload(wkldData)
        setUpdatedAt(leadsData.updatedAt ?? null)

        const managerStartMap: Record<string, string | null> = {}
        priceData.forEach((p) => {
          managerStartMap[p.workspace_name] = p.manager_start_date ?? null
        })

        const { rates, salaryMap } = buildEffectiveRates(priceData, mgrData, wkldData)
        setEffectiveRates(rates)
        setManagerSalaryMap(salaryMap)

        const avgData: AvgLeadPrice = await fetch('/api/commission/avg-lead-price').then((r) => r.json())
        const avg = avgData.avg_lead_price_gbp || 0
        setAvgLeadPrice(avg)

        if (sess.role === 'admin') {
          renderAdmin('this_month', parsedLeads, rates, avg, managerStartMap)
        } else {
          const [zarData, mgrRateData] = await Promise.all([
            fetch('/api/commission/gbp-zar-rate')
              .then((r) => r.json())
              .catch((): GbpZarRate => ({ rate: 23.5, source: 'fallback' })) as Promise<GbpZarRate>,
            fetch('/api/commission/manager-rate')
              .then((r) => r.json())
              .catch((): ManagerRate => ({ name: '', commission_rate: 5, base_salary: 0 })) as Promise<ManagerRate>,
          ])

          const zarVal = zarData.rate || null
          setZarRate(zarVal)
          setManagerRate(mgrRateData)

          renderManager('this_month', parsedLeads, priceData, mgrRateData, wkldData, zarVal, avg, sess.name)
          await checkPayslip('this_month')
        }

        setStatus('ok')
      } catch (err) {
        setStatus('error')
        setErrMsg(err instanceof Error ? err.message : 'Failed to load commission data')
      }
    }

    init()
  }, [buildEffectiveRates, renderManager, renderAdmin, checkPayslip])

  // ── Period change ─────────────────────────────────────────────────────────

  const handlePeriodChange = (val: CommPeriod) => {
    setPeriod(val)
    if (!session) return
    if (session.role === 'admin') {
      const managerStartMap: Record<string, string | null> = {}
      prices.forEach((p) => {
        managerStartMap[p.workspace_name] = p.manager_start_date ?? null
      })
      renderAdmin(val, allLeads, effectiveRates, avgLeadPrice, managerStartMap)
    } else {
      renderManager(val, allLeads, prices, managerRate, workload, zarRate, avgLeadPrice, session.name)
      checkPayslip(val)
    }
  }

  const handleDownloadPayslip = () => {
    window.open(`/api/commission/payslips/${monthOf(period)}`, '_blank')
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const earners = Object.keys(earnerStats).sort()
  const allClientKeys = Object.keys(effectiveRates)
  const isAdmin = session?.role === 'admin'

  const clientColumns: Column<ClientRow>[] = [
    {
      key: 'name',
      header: 'Client',
      sortValue: (r) => r.name.toLowerCase(),
      cell: (r) => <span className="font-semibold text-foreground">{r.name}</span>,
    },
    {
      key: 'since',
      header: 'Managing Since',
      sortValue: (r) => r.since ?? '',
      cell: (r) => <span className="text-muted-foreground">{r.since ?? '—'}</span>,
    },
    {
      key: 'leads',
      header: 'Leads',
      numeric: true,
      sortValue: (r) => r.leads,
      cell: (r) => num(r.leads),
    },
    {
      key: 'earned',
      header: 'Commission Earned',
      numeric: true,
      sortValue: (r) => r.earned,
      cell: (r) => <span className="font-semibold text-emerald-600 dark:text-emerald-400">{zar(r.earned)}</span>,
    },
  ]

  // ── Shell wrapper ─────────────────────────────────────────────────────────

  const title = isAdmin ? 'Commission Tracker' : 'My Commission'
  const subtitle = isAdmin
    ? 'Per-manager commission across all clients'
    : session
      ? `Commission for ${session.name}`
      : 'Commission'

  return (
    <PageShell
      title={title}
      subtitle={subtitle}
      freshness={{ table: 'revenue_leads', syncedAt: updatedAt }}
      actions={
        status === 'ok' ? (
          <PeriodFilter
            value={period as PeriodKey}
            onChange={(p) => handlePeriodChange(p as CommPeriod)}
            presets={COMMISSION_PRESETS}
          />
        ) : undefined
      }
    >
      {status === 'error' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-semibold">Couldn’t load commission data</div>
          <div className="mt-0.5 opacity-90">{errMsg}</div>
        </div>
      )}

      {status === 'loading' && (
        <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
          <KpiCard label="Commission" value="—" tone="green" loading />
          <KpiCard label="Leads" value="—" tone="navy" loading />
          <KpiCard label="Clients" value="—" tone="yellow" loading />
          <KpiCard label="Rate" value="—" tone="teal" loading />
        </div>
      )}

      {/* ── Manager view ─────────────────────────────────────────────────── */}
      {status === 'ok' && !isAdmin && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <KpiCard label="Commission Earned" value={zar(sumCommZar)} tone="green" />
            <KpiCard label="Leads Delivered" value={num(sumLeads)} tone="navy" />
            <KpiCard label="Active Clients" value={num(sumClients)} tone="yellow" />
            <KpiCard label="Rate per Lead" value={zar(perLeadZar)} tone="teal" />
            {showSalary && (
              <KpiCard
                label="Base Salary"
                value={zar(salaryEarnedZar)}
                sub={salaryNote || undefined}
                tone="purple"
              />
            )}
            {showTotal && (
              <KpiCard
                label="Total This Month"
                value={zar(totalZar)}
                sub="Salary + commission"
                tone="green"
              />
            )}
          </div>

          {rateExplanation && (
            <div className="mb-5 rounded-lg border border-border bg-card p-4 text-[13px] text-muted-foreground shadow-sm">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                How your rate is calculated
              </div>
              <div className="leading-6">
                All-time avg lead{' '}
                <span className="font-semibold text-foreground">{gbp(rateExplanation.avgLead)}</span>{' '}
                × {rateExplanation.rate}% ={' '}
                <span className="font-semibold text-foreground">{gbp(rateExplanation.perLeadGbp)}</span>{' '}
                × R{rateExplanation.zarRateDisplay}/GBP ={' '}
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  {zar(rateExplanation.perLeadZar)} per lead
                </span>
              </div>
            </div>
          )}

          {payslipMeta?.exists && (
            <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-4 shadow-sm">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Pay Slip
              </div>
              <button
                type="button"
                onClick={handleDownloadPayslip}
                className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                Download
              </button>
              {payslipMeta.filename && (
                <span className="text-xs text-muted-foreground">{payslipMeta.filename}</span>
              )}
            </div>
          )}

          <DataTable
            columns={clientColumns}
            rows={clientRows}
            getRowKey={(r) => r.name}
            empty="No leads delivered in this period"
          />
        </>
      )}

      {/* ── Admin view ───────────────────────────────────────────────────── */}
      {status === 'ok' && isAdmin && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3">
            <KpiCard label="Agency Commission" value={gbp(agencyCommGbp)} tone="yellow" />
            <KpiCard label="Earners" value={num(earners.length)} tone="teal" />
            <KpiCard
              label="Active Clients"
              value={num(new Set(earners.flatMap((e) => Object.keys(earnerStats[e]))).size)}
              tone="navy"
            />
          </div>

          {earners.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
              No commission data for this period.
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card shadow-sm">
              <div className="flex flex-wrap gap-1.5 border-b border-border p-3">
                {earners.map((earner) => (
                  <button
                    key={earner}
                    type="button"
                    onClick={() => setActiveEarner(earner)}
                    className={
                      'rounded-md px-3 py-1 text-xs font-medium transition-colors ' +
                      (activeEarner === earner
                        ? 'bg-primary text-primary-foreground'
                        : 'border border-border text-muted-foreground hover:bg-accent hover:text-foreground')
                    }
                  >
                    {earner}
                  </button>
                ))}
              </div>
              {activeEarner && earnerStats[activeEarner] && (
                <EarnerDetail
                  earner={activeEarner}
                  clients={earnerStats[activeEarner]}
                  salary={managerSalaryMap[activeEarner] ?? 0}
                  allClientKeys={allClientKeys}
                />
              )}
            </div>
          )}
        </>
      )}
    </PageShell>
  )
}

// ── Earner detail ──────────────────────────────────────────────────────────────

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
  const entries = Object.entries(clients).sort((a, b) => b[1].revenue - a[1].revenue)
  const totalLeads = entries.reduce((s, [, c]) => s + c.leads, 0)
  const totalCommission = entries.reduce((s, [, c]) => s + (c.commission ?? c.revenue * c.commRate), 0)

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border p-4">
        <div>
          <div className="font-[family-name:var(--font-display)] text-xl font-bold text-foreground">
            {earner}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {entries.length} client{entries.length !== 1 ? 's' : ''} · {totalLeads} lead
            {totalLeads !== 1 ? 's' : ''}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-6">
          {salary > 0 && (
            <div className="text-right">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Base Salary
              </div>
              <div className="font-[family-name:var(--font-display)] text-lg font-bold tabular-nums text-muted-foreground">
                R{salary.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}
                <span className="text-xs">/mo</span>
              </div>
              <div className="text-[10px] text-muted-foreground">paid in ZAR separately</div>
            </div>
          )}
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Commission
            </div>
            <div className="font-[family-name:var(--font-display)] text-2xl font-bold tabular-nums text-primary">
              {'£' + totalCommission.toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      <ul>
        {entries.map(([client, stats], i) => {
          const commission = stats.commission ?? stats.revenue * stats.commRate
          return (
            <li
              key={client}
              className={
                'flex flex-wrap items-center justify-between gap-2 px-4 py-3' +
                (i < entries.length - 1 ? ' border-b border-border' : '')
              }
            >
              <span className="font-semibold text-foreground">
                {client}
                {allClientKeys.indexOf(client) === -1 && (
                  <span className="ml-2 text-[10px] font-normal text-muted-foreground">(unassigned)</span>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {stats.leads} lead{stats.leads !== 1 ? 's' : ''}
                </span>
                <StatusBadge status="ok">{'£' + commission.toFixed(2)}</StatusBadge>
                {stats.startDate && (
                  <span className="text-[11px] text-muted-foreground">from {stats.startDate}</span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
