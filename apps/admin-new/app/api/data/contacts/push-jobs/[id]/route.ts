import { proxyToLegacy } from '@/lib/legacy-proxy'

// Poll a single push/verify job's progress. Proxied to legacy.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  return proxyToLegacy(req, `/api/contacts/push-jobs/${encodeURIComponent(id)}`)
}
