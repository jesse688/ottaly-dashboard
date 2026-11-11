import { createRemoteJWKSet, jwtVerify } from 'jose'

// Cloudflare Access sits in front of /admin and has already made the person
// prove their email. It forwards a signed token on every request
// (Cf-Access-Jwt-Assertion). We check that signature ourselves, so a request
// that skips Cloudflare cannot fake it.
//
// Off unless BOTH env vars are set; then the admin password is the only way in,
// as before.
//   CF_ACCESS_TEAM_DOMAIN  e.g. myteam.cloudflareaccess.com
//   CF_ACCESS_AUD          AUD tag of the Access app covering /admin
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
