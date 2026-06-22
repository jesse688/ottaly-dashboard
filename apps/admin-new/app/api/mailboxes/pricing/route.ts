import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// Mailbox pricing CRUD — unit_cost per (supplier × mailbox_type). Reads/writes
// the shared mailbox_pricing table (same one the sync uses to compute unit_cost).
//   GET    → all rows
//   PUT    { supplier, mailbox_type, unit_cost, notes? }  → upsert
//   DELETE { supplier, mailbox_type }                     → remove

export async function GET() {
  try {
    const r = await pool.query(`SELECT supplier, mailbox_type, unit_cost, currency, notes FROM mailbox_pricing ORDER BY supplier, mailbox_type`)
    return NextResponse.json(r.rows.map(x => ({ ...x, unit_cost: x.unit_cost != null ? Number(x.unit_cost) : null })))
  } catch (err) {
    console.error('[mailboxes/pricing GET]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  try {
    const b = await req.json() as { supplier?: string; mailbox_type?: string; unit_cost?: number; notes?: string }
    if (!b.supplier || !b.mailbox_type) return NextResponse.json({ error: 'supplier and mailbox_type required' }, { status: 400 })
    await pool.query(
      `INSERT INTO mailbox_pricing (supplier, mailbox_type, unit_cost, currency, notes, updated_at)
       VALUES ($1, $2, $3, 'USD', $4, now())
       ON CONFLICT (supplier, mailbox_type) DO UPDATE SET unit_cost = EXCLUDED.unit_cost, notes = EXCLUDED.notes, updated_at = now()`,
      [b.supplier, b.mailbox_type, b.unit_cost ?? null, b.notes ?? null]
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[mailboxes/pricing PUT]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    const b = await req.json() as { supplier?: string; mailbox_type?: string }
    if (!b.supplier || !b.mailbox_type) return NextResponse.json({ error: 'supplier and mailbox_type required' }, { status: 400 })
    await pool.query(`DELETE FROM mailbox_pricing WHERE supplier = $1 AND mailbox_type = $2`, [b.supplier, b.mailbox_type])
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[mailboxes/pricing DELETE]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 })
  }
}
