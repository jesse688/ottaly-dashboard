import { type NextRequest } from 'next/server'
import { proxyToLegacy } from '@/lib/legacy-proxy'

// Reacher verifier pool status ({ pool: [{ label, usageToday, dailyLimit, ... }] }).
// Proxied to legacy /api/reacher-pool.
export async function GET(req: NextRequest) {
  return proxyToLegacy(req, '/api/reacher-pool')
}
