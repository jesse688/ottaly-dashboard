import { NextResponse, type NextRequest } from 'next/server'
import { getAdminSession } from '@/lib/auth'
import { sendTestNotification } from '@/lib/email'

// POST — send a sample new-lead notification to this client's email so the admin
// can preview the wording. Uses the current (saved) templates.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const res = await sendTestNotification(id)
  if (!res.ok) {
    const msg = res.reason === 'no_api_key' ? 'RESEND_API_KEY is not configured on the server.'
      : res.reason === 'no_email' ? 'This client has no email address set.'
      : res.reason?.startsWith('resend_') ? `Resend rejected the send (${res.reason}). Check the domain is verified.`
      : 'Could not send the test email.'
    return NextResponse.json({ error: msg }, { status: 400 })
  }
  return NextResponse.json({ ok: true, to: res.to })
}
