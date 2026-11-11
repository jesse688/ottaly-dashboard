import { createRemoteJWKSet, jwtVerify } from 'jose'

// Cloudflare Access sits in front of this app and has already made the person
// prove their email. It forwards a signed token on every request
// (Cf-Access-Jwt-Assertion). We check that signature ourselves, so a request
// that skips Cloudflare (the raw IP, the easypanel.host name) cannot fake it.
//
// Off unless BOTH env vars are set. With them unset nothing here runs and the
// key login is the only way in, exactly as before.
//   CF_ACCESS_TEAM_DOMAIN  e.g. myteam.cloudflareaccess.com
//   CF_ACCESS_AUD          the Access application's AUD tag
//   ACCESS_ADMIN_EMAILS    comma list with full access incl. Finance; everyone
//                          else Access lets through gets all but the money
//                          pages (see accessLevelForEmail)
// Edge-safe (jose + fetch only): the middleware imports this.

export function cfAccessEnabled(): boolean {
  return !!(process.env.CF_ACCESS_TEAM_DOMAIN && process.env.CF_ACCESS_AUD)
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null

/** The signed-in email from a valid Access token, or null. Never throws. */
export async function verifyAccessJwt(token: string | null | undefined): Promise<string | null> {
  if (!token || !cfAccessEnabled()) return null
  const team = process.env.CF_ACCESS_TEAM_DOMAIN!
  try {
    jwks ??= createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`))
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${team}`,
      audience: process.env.CF_ACCESS_AUD!,
    })
    // Service tokens (scripts) carry no email. They get no session here.
    return typeof payload.email === 'string' && payload.email ? payload.email.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Who gets what after the Access login (Jesse 2026-11-11):
 *   'full'  ACCESS_ADMIN_EMAILS (Jesse, Jamie): everything, Finance included,
 *           with no extra passphrase.
 *   'staff' anyone else Access lets in (info@, the CMs): everything EXCEPT
 *           money: Finance, Revenue and Commission are closed to them even
 *           if they know the finance passphrase.
 * Access itself decides who gets in at all.
 */
export function accessLevelForEmail(email: string): 'full' | 'staff' {
  const full = (process.env.ACCESS_ADMIN_EMAILS ?? '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
  return full.includes(email.toLowerCase()) ? 'full' : 'staff'
}
