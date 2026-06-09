import { type NextRequest, NextResponse } from 'next/server'

const LEGACY_API = process.env.LEGACY_API_URL ?? 'http://localhost:3000'

interface RouteParams {
  params: Promise<{ month: string }>
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { month } = await params
  try {
    const res = await fetch(`${LEGACY_API}/api/payslips/${month}`, {
      headers: {
        cookie: req.headers.get('cookie') ?? '',
      },
    })
    if (!res.ok) {
      return NextResponse.json(
        { error: 'Payslip not found' },
        { status: res.status }
      )
    }
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    const contentDisposition = res.headers.get('content-disposition') ?? ''
    const buf = await res.arrayBuffer()
    return new NextResponse(buf, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': contentDisposition,
      },
    })
  } catch {
    return NextResponse.json({ error: 'Legacy API unavailable' }, { status: 502 })
  }
}
