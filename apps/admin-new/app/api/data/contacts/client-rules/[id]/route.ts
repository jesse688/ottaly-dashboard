import { type NextRequest } from 'next/server'
import { proxyToLegacy } from '@/lib/legacy-proxy'

// A client's master exclusion lists ({ rules: { excluded_industries, ... } }).
// Proxied to legacy /api/client-rules/:id. Used by the "Filter for Client"
// selector to show a summary of what's auto-excluded for that client.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  return proxyToLegacy(req, `/api/client-rules/${encodeURIComponent(id)}`)
}
