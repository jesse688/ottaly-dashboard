'use client'

import { cn } from '@/lib/utils'

export type PeriodKey =
  | 'today' | '7d' | '14d' | '30d'
  | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'this_year' | 'all_time'

export const PERIOD_PRESETS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7D' },
  { key: '14d', label: '14D' },
  { key: '30d', label: '30D' },
  { key: 'this_week', label: 'This Week' },
  { key: 'last_week', label: 'Last Week' },
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'this_year', label: 'This Year' },
  { key: 'all_time', label: 'All Time' },
]

/** All ranges resolved in Europe/London so day boundaries match the ESP/Bison day. */
export function periodRange(p: PeriodKey, now = new Date()): { start: string; end: string } {
  // Work in London local date parts.
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d) // YYYY-MM-DD
  const londonNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }))
  const today = fmt(now)
  const shift = (days: number) => {
    const d = new Date(londonNow)
    d.setDate(d.getDate() + days)
    return fmt(d)
  }
  const dow = (londonNow.getDay() + 6) % 7 // 0 = Monday
  switch (p) {
    case 'today': return { start: today, end: today }
    case '7d': return { start: shift(-6), end: today }
    case '14d': return { start: shift(-13), end: today }
    case '30d': return { start: shift(-29), end: today }
    case 'this_week': return { start: shift(-dow), end: today }
    case 'last_week': return { start: shift(-dow - 7), end: shift(-dow - 1) }
    case 'this_month': return { start: today.slice(0, 8) + '01', end: today }
    case 'last_month': {
      const d = new Date(londonNow); d.setDate(1); d.setMonth(d.getMonth() - 1)
      const start = fmt(d)
      const e = new Date(londonNow); e.setDate(0)
      return { start, end: fmt(e) }
    }
    case 'this_year': return { start: today.slice(0, 4) + '-01-01', end: today }
    case 'all_time': return { start: '0000-01-01', end: today }
  }
}

export function PeriodFilter({
  value,
  onChange,
  presets = PERIOD_PRESETS,
}: {
  value: PeriodKey
  onChange: (p: PeriodKey) => void
  presets?: { key: PeriodKey; label: string }[]
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {presets.map(p => (
        <button
          key={p.key}
          type="button"
          onClick={() => onChange(p.key)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            value === p.key
              ? 'bg-primary text-primary-foreground'
              : 'border border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}
