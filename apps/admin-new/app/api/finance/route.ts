import { NextResponse } from 'next/server'
import pool from '@/lib/db'

function currentMonthStr(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

async function getFinanceSnapshot(month: string) {
  const pgdb = pool

  // Mailbox inventory comes from mailbox_meta (the `mailboxes` table doesn't
  // exist in Postgres — inventory + supplier/type/billing all live in mailbox_meta).
  const metaRes = await pgdb.query(
    `SELECT email, supplier, mailbox_type, billing_start_date, billing_day
     FROM mailbox_meta
     ORDER BY email`
  )
  const allMailboxes = metaRes.rows as any[]
  const metaByEmail = new Map(
    (metaRes.rows as any[]).map((m: any) => [m.email?.toLowerCase(), m])
  )

  // Pricing
  const pricingRes = await pgdb.query(
    `SELECT supplier, mailbox_type, unit_cost, notes
     FROM mailbox_pricing
     ORDER BY supplier, mailbox_type`
  )
  const prices = (pricingRes.rows as any[]).reduce((acc: any, p: any) => {
    acc[`${p.supplier}|${p.mailbox_type}`] = parseFloat(p.unit_cost) || 0
    return acc
  }, {})

  // Workspace names from workspace_stats (the `clients` table is legacy SQLite,
  // not reachable from this Postgres pool — names are all we need for the P&L).
  const wsRes = await pgdb.query(
    `SELECT DISTINCT workspace_id, workspace_name
     FROM workspace_stats
     WHERE workspace_id IS NOT NULL AND workspace_id <> ''
     ORDER BY workspace_id`
  )
  const wsMeta: Record<string, any> = {}
  ;(wsRes.rows as any[]).forEach((r: any) => {
    wsMeta[r.workspace_id] = r
  })

  // Revenue for the month
  const revenueRes = await pgdb.query(
    `SELECT workspace_id, COUNT(*) as delivered, SUM(lead_price) as revenue
     FROM revenue_leads
     WHERE date::date >= $1::date AND date::date < ($1::date + INTERVAL '1 month')
     AND pv_nonlead IS NOT TRUE
     GROUP BY workspace_id`,
    [`${month}-01`]
  )
  const revenue: Record<string, any> = {}
  ;(revenueRes.rows as any[]).forEach((r: any) => {
    revenue[r.workspace_id] = {
      delivered: parseInt(r.delivered) || 0,
      revenue: parseFloat(r.revenue) || 0,
    }
  })

  // Manual revenue entries
  const manualRes = await pgdb.query(
    `SELECT workspace_id, SUM(lead_count) as manual_leads, SUM(lead_count * price_per_lead) as manual_revenue
     FROM revenue_manual_entries
     WHERE month = $1
     GROUP BY workspace_id`,
    [month]
  )
  const manualByWs: Record<string, any> = {}
  ;(manualRes.rows as any[]).forEach((r: any) => {
    manualByWs[r.workspace_id] = {
      manual_leads: parseInt(r.manual_leads) || 0,
      manual_revenue: parseFloat(r.manual_revenue) || 0,
    }
  })

  // Mailbox costs
  const costByWorkspace: Record<string, number> = {}
  const countByWorkspace: Record<string, number> = {}
  const costBySupplier: Record<string, number> = {}

  for (const m of allMailboxes) {
    const meta = metaByEmail.get((m.email?.toLowerCase() as string) || '')
    const supplier = meta?.supplier || m.supplier || 'Unassigned'
    const type = meta?.mailbox_type || m.type || 'smtp'
    const unitCost = parseFloat(m.unit_cost) || prices[`${supplier}|${type}`] || 0

    const ws = m.workspace_id || 'unassigned'
    costByWorkspace[ws] = (costByWorkspace[ws] || 0) + unitCost
    countByWorkspace[ws] = (countByWorkspace[ws] || 0) + 1
    costBySupplier[supplier] = (costBySupplier[supplier] || 0) + unitCost
  }

  // Expenses active in this month
  const expensesRes = await pgdb.query(
    `SELECT id, label, category, amount, currency, start_month, end_month, notes
     FROM monthly_expenses
     WHERE start_month <= $1 AND (end_month IS NULL OR end_month >= $1)
     ORDER BY start_month DESC, label`,
    [month]
  )
  const activeExpenses = expensesRes.rows as any[]

  // FX rates (fallback to sensible defaults)
  const fx = { GBP: 1, USD: 0.79, EUR: 0.85, ZAR: 0.042 }

  const totalOpex = activeExpenses.reduce(
    (s: number, e: any) => s + (parseFloat(e.amount) || 0) * (fx[e.currency as keyof typeof fx] || 1),
    0
  )

  // Staff costs (simplified - no manager commission lookup for now)
  const staffRows: any[] = []
  const totalStaffCost = 0

  // Build client rows
  const activeWsIds = new Set([
    ...Object.keys(wsMeta),
    ...Object.keys(revenue),
    ...Object.keys(countByWorkspace).filter((id) => id !== 'unassigned'),
  ])

  const clients: any[] = []
  for (const id of activeWsIds) {
    if (id === 'unassigned') continue
    const rev = revenue[id]?.revenue || 0
    const delivered = revenue[id]?.delivered || 0
    const cost = costByWorkspace[id] || 0
    const meta = wsMeta[id] || {}
    const manual = manualByWs[id] || { manual_leads: 0, manual_revenue: 0 }

    // Include if there's any activity
    if (rev === 0 && cost === 0 && !countByWorkspace[id]) continue

    clients.push({
      workspace_id: id,
      workspace_name: meta.workspace_name || id,
      client_status: meta.client_status || 'active',
      delivered: delivered + manual.manual_leads,
      revenue: rev + manual.manual_revenue,
      mailbox_cost: cost,
      mailbox_count: countByWorkspace[id] || 0,
      manual_leads: manual.manual_leads || 0,
      manual_revenue: manual.manual_revenue || 0,
    })
  }
  clients.sort((a, b) => (b.revenue - b.mailbox_cost) - (a.revenue - a.mailbox_cost))

  const totalRevenue = clients.reduce((s, c) => s + c.revenue, 0)
  const totalMailboxCost = clients.reduce((s, c) => s + c.mailbox_cost, 0) + (costByWorkspace['unassigned'] || 0)
  const grossProfit = totalRevenue - totalMailboxCost
  const netProfit = grossProfit - totalOpex - totalStaffCost

  return {
    month,
    clients,
    bySupplier: Object.entries(costBySupplier)
      .map(([supplier, monthly_cost]) => ({
        supplier,
        monthly_cost,
        mailbox_count: allMailboxes.filter(
          (m) => (metaByEmail.get((m.email?.toLowerCase() as string) || '')?.supplier || m.supplier || 'Unassigned') === supplier
        ).length,
      }))
      .sort((a, b) => b.monthly_cost - a.monthly_cost),
    expenses: activeExpenses,
    staff: staffRows,
    pricing: pricingRes.rows,
    totals: {
      revenue: totalRevenue,
      mailbox_cost: totalMailboxCost,
      opex: totalOpex,
      staff_cost: totalStaffCost,
      mailbox_total: allMailboxes.length,
    },
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const month = (searchParams.get('month') || currentMonthStr()).slice(0, 7)

    const snapshot = await getFinanceSnapshot(month)
    return NextResponse.json(snapshot)
  } catch (err) {
    console.error('[finance snapshot]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const body = await req.json()
  const { type, ...data } = body

  try {
    if (type === 'expense') {
      const { label, category, amount, currency, start_month, end_month, notes } = data
      await pool.query(
        `INSERT INTO monthly_expenses (label, category, amount, currency, start_month, end_month, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [label, category ?? null, amount, currency ?? 'GBP', start_month, end_month ?? null, notes ?? null]
      )
    } else if (type === 'revenue') {
      const { workspace_id, month, lead_count, price_per_lead, note } = data
      await pool.query(
        `INSERT INTO revenue_manual_entries (workspace_id, month, lead_count, price_per_lead, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [workspace_id, month, lead_count, price_per_lead, note ?? null]
      )
    } else {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[finance POST]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
