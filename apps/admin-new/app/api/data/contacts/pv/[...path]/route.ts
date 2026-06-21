import { type NextRequest } from 'next/server'
import { proxyToLegacy } from '@/lib/legacy-proxy'

// Catch-all proxy for PlusVibe endpoints (workspaces, campaigns, push-contacts,
// …). Stateful — forwarded verbatim to legacy /api/pv/*, query string included.
function target(req: NextRequest, path: string[]) {
  const qs = req.nextUrl.search || ''
  return `/api/pv/${path.map(encodeURIComponent).join('/')}${qs}`
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params
  return proxyToLegacy(req, target(req, path))
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params
  return proxyToLegacy(req, target(req, path))
}
