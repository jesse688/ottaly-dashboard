import { proxyToLegacy } from '@/lib/legacy-proxy'

// Stateful: starts a Reacher verify (+optional PlusVibe push) job on the legacy
// server. Not reimplemented — proxied. Returns { jobId }.
export async function POST(req: Request) {
  return proxyToLegacy(req, '/api/contacts/verify-and-push')
}
