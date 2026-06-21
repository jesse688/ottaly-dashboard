import { proxyToLegacy } from '@/lib/legacy-proxy'

// List PlusVibe/Bison workspaces for the Push modal — proxy to legacy.
export async function GET(request: Request) {
  return proxyToLegacy(request, '/api/bison/workspaces')
}
