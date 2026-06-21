import { type NextRequest } from 'next/server'
import { proxyToLegacy } from '@/lib/legacy-proxy'

// Provider coverage stats (google / outlook / other / unknown). Proxied to
// legacy /api/contacts/mx-coverage.
export async function GET(req: NextRequest) {
  return proxyToLegacy(req, '/api/contacts/mx-coverage')
}
