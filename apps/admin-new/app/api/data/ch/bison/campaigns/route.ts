import { proxyToLegacy } from '@/lib/legacy-proxy'

// List campaigns for a workspace for the Push modal — proxy to legacy,
// forwarding the ws_id query param.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const wsId = searchParams.get('ws_id') ?? ''
  return proxyToLegacy(
    request,
    `/api/bison/campaigns?ws_id=${encodeURIComponent(wsId)}`
  )
}
