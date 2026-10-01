import pool from './db'
import type { MailboxMove } from './mailbox-dimensions'

/**
 * Mailboxes that moved onto Ottaly Mail, keyed by lowercase email. See asOf()
 * in mailbox-dimensions. A missing table (fresh database) means "no moves",
 * never an error: the cards must still render.
 */
export async function loadMailboxMoves(): Promise<Map<string, MailboxMove>> {
  try {
    const r = await pool.query(
      `SELECT lower(email) AS email, to_char(since, 'YYYY-MM-DD') AS since, prev_type, prev_supplier FROM mailbox_ottaly_mail_moves`,
    )
    return new Map(r.rows.map((x: { email: string; since: string; prev_type: string | null; prev_supplier: string | null }) =>
      [x.email, { since: x.since, prevType: x.prev_type, prevSupplier: x.prev_supplier }]))
  } catch {
    return new Map()
  }
}
