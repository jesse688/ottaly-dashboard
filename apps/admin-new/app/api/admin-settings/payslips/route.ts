import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export interface Payslip {
  id: number
  manager_name: string
  month: string
  filename: string
  mimetype: string
  uploaded_at: string
}

export async function GET() {
  try {
    const data = await legacyFetch('/api/admin/payslips') as Payslip[]
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      manager_name: string
      month: string
      filename: string
      mimetype: string
      data: string
    }
    const data = await legacyFetch('/api/admin/payslips', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
