import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

async function proxy(req: NextRequest, id: string, method: 'POST' | 'PUT') {
  const body = (await req.json()) as Record<string, unknown>
  const data = await legacyFetch(`/api/client-status/${id}`, {
    method,
    body: JSON.stringify(body),
  })
  return NextResponse.json(data)
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    return await proxy(req, id, 'POST')
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    return await proxy(req, id, 'PUT')
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
