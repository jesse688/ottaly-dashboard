import { NextRequest, NextResponse } from 'next/server'
import { legacyFetch } from '@/lib/api'

export interface CommissionPayment {
  manager_name: string
  period_start: string
  period_end: string
  status: 'paid' | 'unpaid'
  payslip_name: string
  payslip_type: string
  payslip_data: string
  paid_at: string | null
  updated_at: string
}

export async function GET() {
  try {
    const data = await legacyFetch('/api/admin/commission-payments') as CommissionPayment[]
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json() as {
      manager_name: string
      period_start: string
      period_end: string
      status: string
      payslip_name: string
      payslip_type: string
      payslip_data: string
    }
    const data = await legacyFetch('/api/admin/commission-payments', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
