import { NextResponse } from 'next/server'
import { getRole } from '@/lib/auth'

// Returns the signed-in role so client components (e.g. the sidebar) can hide
// Finance/Revenue for CMs. Auth itself is still enforced server-side by the
// middleware — this is only for UI, never the security boundary.
export async function GET() {
  const role = await getRole()
  return NextResponse.json({ role })
}
