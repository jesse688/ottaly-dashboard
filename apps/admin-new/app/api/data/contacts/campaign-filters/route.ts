import { type NextRequest } from 'next/server'
import { proxyToLegacy } from '@/lib/legacy-proxy'

// Saved per-campaign filter sets ({ rows: [{ workspace_id, workspace_name,
// campaign_id, campaign_name, filters }] }). Proxied to legacy /api/campaign-filters.
export async function GET(req: NextRequest) {
  return proxyToLegacy(req, '/api/campaign-filters')
}
