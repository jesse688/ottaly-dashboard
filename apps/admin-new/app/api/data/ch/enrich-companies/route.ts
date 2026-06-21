import { proxyToLegacy } from '@/lib/legacy-proxy'

// Per-company enrichment (Gemini firmographics + SearXNG domain discovery +
// liveness check). Stateful and quota-bound — runs on the legacy server. Proxy.
export async function POST(request: Request) {
  return proxyToLegacy(request, '/api/ch/enrich-companies')
}
