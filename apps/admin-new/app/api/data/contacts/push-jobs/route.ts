import { proxyToLegacy } from '@/lib/legacy-proxy'

// List active/recent push & verify jobs (legacy in-memory queue). Proxied.
export async function GET(req: Request) {
  return proxyToLegacy(req, '/api/contacts/push-jobs')
}
