import { type NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

interface RouteParams {
  params: Promise<{ month: string }>
}

export interface PayslipMeta {
  exists: boolean
  filename?: string
  uploaded_at?: string
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { month } = await params
  try {
    const data: PayslipMeta = await legacyFetch(`/api/payslips/${month}/meta`)
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ exists: false })
  }
}
