import { NextResponse } from 'next/server'
import { SIC_CODES } from '@/lib/sic-codes'

// Full SIC label map — the page builds a code→label lookup for SIC pills/tags.
export async function GET() {
  return NextResponse.json({
    codes: SIC_CODES.map(([code, label]) => ({ code, label })),
  })
}
