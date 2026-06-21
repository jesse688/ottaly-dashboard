import { NextResponse } from 'next/server'
import { SIC_CODES } from '@/lib/sic-codes'

// Common-term aliases that promote specific SIC codes to the top of results.
const SIC_ALIASES: Record<string, string[]> = {
  'care home': ['87100', '87200', '87300', '87900'],
  'nursing': ['87100', '87200', '87300'],
  accountant: ['69201', '69202', '69203'],
  accountancy: ['69201', '69202', '69203'],
  solicitor: ['69101', '69102', '69109'],
  legal: ['69101', '69102', '69109'],
  software: ['62010', '62012', '62020', '62090'],
  it: ['62010', '62012', '62020', '62090'],
  builder: ['41201', '41202'],
  construction: ['41100', '41201', '41202'],
  architect: ['71111', '71112'],
  restaurant: ['56101', '56102', '56103'],
  hotel: ['55100', '55201', '55202'],
  gym: ['93130'],
  fitness: ['93130'],
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const q = (searchParams.get('q') || '').trim().toLowerCase()
  if (!q) {
    return NextResponse.json({
      results: SIC_CODES.slice(0, 40).map(([code, label]) => ({ code, label })),
    })
  }
  const digits = q.replace(/[^0-9]/g, '')
  const aliasCodes = new Set<string>()
  for (const [term, codes] of Object.entries(SIC_ALIASES)) {
    if (term.includes(q) || q.includes(term)) codes.forEach((c) => aliasCodes.add(c))
  }
  const scored: { code: string; label: string; score: number }[] = []
  for (const [code, label] of SIC_CODES) {
    const ll = label.toLowerCase()
    let score = 0
    if (aliasCodes.has(code)) score = 110
    if (digits && code.startsWith(digits)) score = Math.max(score, 100)
    else if (digits && code.includes(digits)) score = Math.max(score, 60)
    if (ll.startsWith(q)) score = Math.max(score, 90)
    else if (ll.includes(q)) score = Math.max(score, 50)
    if (score) scored.push({ code, label, score })
  }
  scored.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code))
  return NextResponse.json({
    results: scored.slice(0, 40).map(({ code, label }) => ({ code, label })),
  })
}
