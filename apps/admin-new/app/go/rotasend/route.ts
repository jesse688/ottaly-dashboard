import { type NextRequest, NextResponse } from 'next/server'
import { verifyAccessJwt, accessLevelForEmail } from '@/lib/cf-access'

export const dynamic = 'force-dynamic'

// The Rotasend tile on /home lands here. Rotasend is on another domain with its
// own magic-link login, so Cloudflare Access cannot cover it. Instead this
// server asks Rotasend for a one-time login link for the person Access says is
// signed in, and sends the browser straight to it. Same link Rotasend would
// have emailed, minus the email.
//
//   ROTASEND_SSO_SECRET  shared with Rotasend (its HUB_SSO_SECRET). Unset = off.
//   ROTASEND_SSO_AS      optional: admins are signed in as this Rotasend user
//                        (the agency account) instead of their own email.
// Anything missing or failing just opens Rotasend's normal login page.
export async function GET(req: NextRequest) {
  const base = (process.env.ROTASEND_URL ?? 'https://app.rotasend.com').replace(/\/$/, '')
  const fallback = () => NextResponse.redirect(`${base}/login`)

  const secret = process.env.ROTASEND_SSO_SECRET
  const email = await verifyAccessJwt(req.headers.get('cf-access-jwt-assertion'))
  if (!secret || !email) return fallback()

  const as = process.env.ROTASEND_SSO_AS?.trim()
  const loginAs = as && accessLevelForEmail(email) === 'full' ? as : email

  try {
    const r = await fetch(`${base}/api/auth/sso`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ email: loginAs }),
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    })
    const j = (await r.json().catch(() => null)) as { ok?: boolean; link?: string } | null
    // Only ever follow a link back to Rotasend itself.
    if (r.ok && j?.ok && typeof j.link === 'string' && j.link.startsWith(`${base}/`)) {
      return NextResponse.redirect(j.link)
    }
  } catch {
    // fall through
  }
  return fallback()
}
