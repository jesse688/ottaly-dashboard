import { proxyToLegacy } from '@/lib/legacy-proxy'

// Email finding via Reacher verifier (+ SearXNG/Gemini domain discovery and
// liveness checks). Stateful, quota-bound, runs on the legacy server. Proxy.
export async function POST(request: Request) {
  return proxyToLegacy(request, '/api/ch/find-emails')
}
