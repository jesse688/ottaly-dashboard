import { proxyToLegacy } from '@/lib/legacy-proxy'

// Live Companies House API fetch of officers/directors — stateful, depends on
// COMPANIES_HOUSE_API_KEY + chFetch rate-limiting on the legacy server. Proxy.
export async function POST(request: Request) {
  return proxyToLegacy(request, '/api/ch/fetch-directors')
}
