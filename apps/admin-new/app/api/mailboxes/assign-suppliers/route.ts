import { NextResponse } from 'next/server'
import pool from '@/lib/db'

// POST /api/mailboxes/assign-suppliers
//   { supplierDomains: { Maildoso: ['x.com',...] }, supplierEmails: { Winnr: ['a@b.com'] }, defaultSupplier? }
// Bulk-assign suppliers by domain and/or exact email. Domains match the email's
// domain; emails match exactly. defaultSupplier (optional) fills any still-
// unassigned mailbox. Writes mailbox_meta + mirrors mailbox_full.
export async function POST(req: Request) {
  try {
    const b = await req.json() as {
      supplierDomains?: Record<string, string[]>
      supplierEmails?: Record<string, string[]>
      defaultSupplier?: string | null
    }
    // Build email → supplier map. Exact-email wins over domain.
    const domainToSupplier = new Map<string, string>()
    for (const [sup, doms] of Object.entries(b.supplierDomains || {})) {
      for (const d of doms) domainToSupplier.set(d.trim().toLowerCase().replace(/^@/, ''), sup)
    }
    const emailToSupplier = new Map<string, string>()
    for (const [sup, ems] of Object.entries(b.supplierEmails || {})) {
      for (const e of ems) emailToSupplier.set(e.trim().toLowerCase(), sup)
    }

    const all = await pool.query(`SELECT email, domain, supplier FROM mailbox_full WHERE ignored_at IS NULL`)
    const updates: { email: string; supplier: string }[] = []
    for (const m of all.rows) {
      const email = (m.email as string).toLowerCase()
      const domain = (m.domain as string || '').toLowerCase()
      let sup = emailToSupplier.get(email) || domainToSupplier.get(domain) || null
      if (!sup && b.defaultSupplier && !m.supplier) sup = b.defaultSupplier
      if (sup && sup !== m.supplier) updates.push({ email, supplier: sup })
    }
    if (!updates.length) return NextResponse.json({ ok: true, updated: 0 })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const u of updates) {
        await client.query(
          `INSERT INTO mailbox_meta (email, supplier, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (email) DO UPDATE SET supplier = EXCLUDED.supplier, updated_at = now()`,
          [u.email, u.supplier]
        )
        await client.query(`UPDATE mailbox_full SET supplier = $2 WHERE lower(email) = $1`, [u.email, u.supplier])
      }
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }

    return NextResponse.json({ ok: true, updated: updates.length })
  } catch (err) {
    console.error('[mailboxes/assign-suppliers]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 })
  }
}
