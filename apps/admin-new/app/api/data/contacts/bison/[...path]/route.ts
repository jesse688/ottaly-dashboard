import { type NextRequest } from 'next/server'
import { proxyToLegacy } from '@/lib/legacy-proxy'

// Catch-all proxy for Bison (EmailBison) endpoints (workspaces, campaigns,
// create-campaign, push-contacts). Stateful — forwarded verbatim to legacy
// /api/bison/*, query string included.
function target(req: NextRequest, path: string[]) {
  const qs = req.nextUrl.search || ''
  return `/api/bison/${path.map(encodeURIComponent).join('/')}${qs}`
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
