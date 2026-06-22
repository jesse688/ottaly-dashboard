import { type NextRequest } from 'next/server'
import { proxyToLegacy } from '@/lib/legacy-proxy'

// Typeahead over the full UK SIC 2007 list (by code / description / common-term
// alias) for the Industry (SIC) filter. Backed by the legacy SIC table + alias
// map (sic-codes.js), so proxied rather than rebundling ~700 codes here.
export async function GET(req: NextRequest) {
  const qs = req.nextUrl.search || ''
  return proxyToLegacy(req, `/api/contacts/sic-search${qs}`)
}
