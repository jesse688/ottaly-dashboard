import { type NextRequest } from 'next/server'
import { proxyToLegacy } from '@/lib/legacy-proxy'

// Today's verification stats strip ({ total, safe, invalid, risky, unknown }).
// Proxied to legacy /api/contacts/verified-today.
export async function GET(req: NextRequest) {
  return proxyToLegacy(req, '/api/contacts/verified-today')
}
