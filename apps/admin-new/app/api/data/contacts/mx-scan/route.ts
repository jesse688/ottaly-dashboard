import { type NextRequest } from 'next/server'
import { proxyToLegacy } from '@/lib/legacy-proxy'

// MX provider verification (live DNS). Stateful background job on the legacy
// server — proxied. POST starts the scan (body { reverify }); GET polls progress.
export async function POST(req: NextRequest) {
  return proxyToLegacy(req, '/api/contacts/mx-scan')
}

export async function GET(req: NextRequest) {
  return proxyToLegacy(req, '/api/contacts/mx-scan')
}
