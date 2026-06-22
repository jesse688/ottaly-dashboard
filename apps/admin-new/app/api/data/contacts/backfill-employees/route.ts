import { type NextRequest } from 'next/server'
import { proxyToLegacy } from '@/lib/legacy-proxy'

// Re-run the num_employees backfill. Stateful DB mutation on the legacy server.
export async function POST(req: NextRequest) {
  return proxyToLegacy(req, '/api/contacts/backfill-employees')
}
