import { NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { legacyFetch } from '@/lib/api'

interface BulkTagBody {
  emails: string[]
  field: 'supplier' | 'mailbox_type'
  value: string | null
}

// Proxies bulk supplier/type assignment to the legacy endpoint
// POST /api/mailboxes/bulk-tag { emails, field, value }.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<BulkTagBody>
    if (!Array.isArray(body.emails) || body.emails.length === 0) {
      return NextResponse.json({ error: 'No mailboxes selected' }, { status: 400 })
    }
    if (body.field !== 'supplier' && body.field !== 'mailbox_type') {
      return NextResponse.json({ error: 'Invalid field' }, { status: 400 })
    }
    const result = await legacyFetch('/api/mailboxes/bulk-tag', {
      method: 'POST',
      body: JSON.stringify({
        emails: body.emails,
        field: body.field,
        value: body.value ?? null,
      }),
    })
    return NextResponse.json(result)
  } catch (err) {
    Sentry.captureException(err, { tags: { tag: 'mailboxes-bulk-tag' } })
    const msg = err instanceof Error ? err.message : 'Failed to assign supplier'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
