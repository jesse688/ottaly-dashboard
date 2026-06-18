'use client'

import { useEffect, useState } from 'react'

const GOAL_SECS = 5 * 60 // 5-minute speed-to-lead goal

function fmt(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// Speed-to-Lead timer shown on each lead. Counts UP from when the prospect's
// reply landed (repliedAt) until the client responds (respondedAt). While the
// client hasn't responded it TICKS LIVE — green under the 5-min goal, then amber,
// then red — to motivate a fast reply. Once responded it freezes on the achieved
// time. `size` controls prominence: 'lg' for the open thread header, 'sm' for the
// lead list row.
export function SpeedTimer({
  repliedAt, respondedAt, done, size = 'sm',
}: {
  repliedAt: string | null
  respondedAt: string | null
  done: boolean        // client has already replied (has_sent / replied_off / first_responded_at)
  size?: 'sm' | 'lg'
}) {
  const [now, setNow] = useState<number>(() => Date.now())

  const live = !done && !respondedAt && !!repliedAt
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])

  if (!repliedAt) return null

  const start = new Date(repliedAt).getTime()
  const elapsed = respondedAt
    ? (new Date(respondedAt).getTime() - start) / 1000
    : (now - start) / 1000

  const beat = elapsed <= GOAL_SECS
  // Live colour ramp: green → amber (1–2× goal) → red (>2× goal).
  const tone = respondedAt
    ? (beat ? 'green' : 'gray')
    : beat ? 'green' : elapsed <= GOAL_SECS * 2 ? 'amber' : 'red'

  const colors: Record<string, string> = {
    green: 'bg-green-100 text-green-700 border-green-200',
    amber: 'bg-amber-100 text-amber-700 border-amber-200',
    red: 'bg-red-100 text-red-700 border-red-200',
    gray: 'bg-gray-100 text-gray-500 border-gray-200',
  }

  // Done state: show the achieved time + whether the goal was met.
  if (respondedAt || done) {
    const label = respondedAt ? `Replied in ${fmt(elapsed)}` : 'Replied'
    return (
      <span className={`inline-flex items-center gap-1 rounded-full border ${colors[tone]} ${size === 'lg' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]'} font-medium`}>
        {beat && respondedAt && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
        {label}
      </span>
    )
  }

  // Live, ticking, not yet replied.
  const remaining = GOAL_SECS - elapsed
  return (
    <span
      title="Speed to Lead — reply within 5 minutes for the best response rate"
      className={`inline-flex items-center gap-1 rounded-full border ${colors[tone]} ${size === 'lg' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]'} font-semibold tabular-nums ${tone === 'red' ? 'animate-pulse' : ''}`}>
      <svg width={size === 'lg' ? 12 : 10} height={size === 'lg' ? 12 : 10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M9 2h6"/></svg>
      {remaining > 0
        ? <>{fmt(remaining)} to goal</>
        : <>{fmt(elapsed)} · reply now</>}
    </span>
  )
}
