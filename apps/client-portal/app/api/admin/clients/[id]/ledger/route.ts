import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getBalance, getLedger, addTopup, addAdjustment, reconcileLeadCharges } from '@/lib/balance'

// GET — a client's balance + full ledger
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  await reconcileLeadCharges(id)
  const [balance, ledger] = await Promise.all([getBalance(id), getLedger(id, 500)])
  return NextResponse.json({ balance, ledger })
}

// POST — admin adds a manual credit/debit. { type: 'topup'|'adjustment', amount, note }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const { type, amount, note } = await req.json() as { type: string; amount: number; note?: string }
  const amt = Number(amount)
  if (!amt) return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })

  if (type === 'topup') await addTopup(id, Math.abs(amt), note)
  else await addAdjustment(id, amt, note ?? 'Manual adjustment')

  return NextResponse.json({ ok: true, balance: await getBalance(id) })
}
