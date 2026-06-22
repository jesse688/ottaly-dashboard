import { proxyToLegacy } from '@/lib/legacy-proxy'

// Push verified directors as leads into a PlusVibe/Bison campaign, then stamp
// pushed_to_bison_at. Stateful (PlusVibe API + DB write) — proxy to legacy.
export async function POST(request: Request) {
  return proxyToLegacy(request, '/api/ch/push-to-bison')
}
