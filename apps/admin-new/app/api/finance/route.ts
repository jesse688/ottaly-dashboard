import { NextResponse } from 'next/server'
import pool from '@/lib/db'

export async function GET() {
  try {
    const [expensesRes, revenueRes] = await Promise.all([
      pool.query(
        `SELECT id, label, category, amount, currency, start_month, end_month, notes
         FROM monthly_expenses
         ORDER BY start_month DESC, label`
      ),
      pool.query(
        `SELECT r.id, r.workspace_id, r.month, r.lead_count, r.price_per_lead, r.note,
                ws.workspace_name
         FROM revenue_manual_entries r
         LEFT JOIN workspace_stats ws ON ws.workspace_id = r.workspace_id
         ORDER BY r.month DESC`
      ),
    ])
    return NextResponse.json({
      expenses: expensesRes.rows,
      revenue: revenueRes.rows,
    })
  } catch (err) {
    console.error('[finance]', err)
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
