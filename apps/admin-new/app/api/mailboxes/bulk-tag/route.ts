import { NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import pool from '@/lib/db'

interface BulkTagBody {
  emails: string[]
  field: 'supplier' | 'mailbox_type'
  value: string | null
}

// Bulk supplier/type assignment — writes directly to mailbox_meta (admin-new's
// own Postgres, no legacy dependency) and mirrors the change into mailbox_full
// so the page reflects it immediately (without waiting for the next sync).
// unit_cost (supplier × type pricing) is recomputed on the next full sync.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<BulkTagBody>
    if (!Array.isArray(body.emails) || body.emails.length === 0) {
      return NextResponse.json({ error: 'No mailboxes selected' }, { status: 400 })
    }
    if (body.field !== 'supplier' && body.field !== 'mailbox_type') {
      return NextResponse.json({ error: 'Invalid field' }, { status: 400 })
    }
    const emails = body.emails.map(e => e.toLowerCase())
    const value = body.value || null
    const col = body.field // 'supplier' | 'mailbox_type'

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Upsert into mailbox_meta (the override table the sync reads).
      await client.query(
        `INSERT INTO mailbox_meta (email, ${col}, updated_at)
         SELECT unnest($1::text[]), $2, now()
         ON CONFLICT (email) DO UPDATE SET ${col} = EXCLUDED.${col}, updated_at = now()`,
        [emails, value]
      )
      // Mirror into mailbox_full immediately. supplier maps to supplier;
      // mailbox_type maps to the 'type' column.
      const fullCol = col === 'mailbox_type' ? 'type' : 'supplier'
      await client.query(
        `UPDATE mailbox_full SET ${fullCol} = $2 WHERE lower(email) = ANY($1::text[])`,
        [emails, value]
      )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }

    return NextResponse.json({ ok: true, updated: emails.length })
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'mailboxes-bulk-tag' } })
    const msg = err instanceof Error ? err.message : 'Failed to assign'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
