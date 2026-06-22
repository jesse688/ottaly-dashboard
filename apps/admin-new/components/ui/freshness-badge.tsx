'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

function relativeTime(d: Date, now: number): string {
  const secs = Math.max(0, Math.floor((now - d.getTime()) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

/**
 * Shows how fresh a cache table's data is. When the data has never synced
 * (null) it says "Not yet synced" — never a silent implication that 0 is real.
 * Goes amber once the data is older than staleAfterMin.
 */
export function FreshnessBadge({
  syncedAt,
  staleAfterMin = 30,
  className,
}: {
  syncedAt: string | Date | null
  staleAfterMin?: number
  className?: string
}) {
  // Read "now" after mount (Date.now() is impure — keep it out of render). Ticks
  // every 60s so the relative label stays current.
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  if (!syncedAt) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-400',
          className,
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        Not yet synced
      </span>
    )
  }
  const d = typeof syncedAt === 'string' ? new Date(syncedAt) : syncedAt
  if (now === null) return null // avoid hydration mismatch; appears after mount
  const stale = now - d.getTime() > staleAfterMin * 60_000
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
        stale
          ? 'bg-amber-500/15 text-amber-600 ring-amber-500/25 dark:text-amber-400'
          : 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-400',
        className,
      )}
      title={d.toLocaleString('en-GB', { timeZone: 'Europe/London' })}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', stale ? 'bg-amber-500' : 'bg-emerald-500')} />
      Updated {relativeTime(d, now)}
    </span>
  )
}
