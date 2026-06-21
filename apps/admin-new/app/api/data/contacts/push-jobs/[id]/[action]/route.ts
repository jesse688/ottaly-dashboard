import { proxyToLegacy } from '@/lib/legacy-proxy'

// Job control: pause / resume / cancel. Proxied to legacy
// /api/contacts/push-jobs/:id/:action.
const ALLOWED = new Set(['pause', 'resume', 'cancel'])

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; action: string }> }
) {
  const { id, action } = await params
  if (!ALLOWED.has(action)) {
    return new Response(JSON.stringify({ error: 'Unknown action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return proxyToLegacy(
    req,
    `/api/contacts/push-jobs/${encodeURIComponent(id)}/${action}`
  )
}
