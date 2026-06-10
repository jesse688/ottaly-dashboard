import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import pool from '@/lib/db'
import { getBalance, getLedger, reconcileLeadCharges } from '@/lib/balance'

// GET — current lead-credit balance + ledger history.
// Reconciles lead charges lazily so the balance is always current on view.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await reconcileLeadCharges(session.clientId)
    const [balance, ledger, client] = await Promise.all([
      getBalance(session.clientId),
      getLedger(session.clientId),
      pool.query('SELECT cost_per_lead, currency FROM portal_clients WHERE id = $1', [session.clientId]),
    ])
    return NextResponse.json({
      balance,
      costPerLead: Number(client.rows[0]?.cost_per_lead ?? 0),
      currency: client.rows[0]?.currency ?? 'GBP',
      ledger,
    })
  } catch (err) {
    console.error('[portal/balance]', err)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
