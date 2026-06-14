'use client'

import { useEffect, useState } from 'react'

interface Warmup {
  active: boolean
  complete?: boolean
  phase?: 'warming' | 'live'
  dayCurrent?: number
  totalDays?: number
  daysLeft?: number
  pct?: number
}

// Top-of-portal warmup status. We KNOW when warmup finishes (admin sets start +
// duration) but NOT when the first lead lands — so we never promise a lead date.
// Phases: "warming up" (progress bar) → "campaign live, leads shortly" → hidden.
export function WarmupBar() {
  const [w, setW] = useState<Warmup | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    fetch('/api/portal/warmup').then(r => r.json()).then(setW).catch(() => setW({ active: false }))
  }, [])

  if (!w?.active || dismissed) return null

  // ── Phase 2: warmup finished, campaign now sending ──
  if (w.phase === 'live') {
    return (
      <div className="bg-gradient-to-r from-emerald-600 to-teal-600 text-white px-5 py-3 relative">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0"><polyline points="20 6 9 17 4 12"/></svg>
            <span className="text-sm font-semibold">Warmup complete — your campaign is now live</span>
            <span className="text-xs text-white/70 hidden sm:inline">Leads will start arriving here shortly.</span>
          </div>
          <button onClick={() => setDismissed(true)} className="text-white/60 hover:text-white text-lg leading-none" aria-label="Dismiss">×</button>
        </div>
      </div>
    )
  }

  // ── Phase 1: warming up (progress) ──
  return (
    <div className="bg-gradient-to-r from-[#050C29] to-[#0d1b4c] text-white px-5 py-3.5 relative">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-sm font-semibold">Your campaign is warming up</span>
            <span className="text-xs text-white/60 hidden sm:inline">— we&apos;re preparing your inboxes so emails land in the primary inbox, not spam.</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-white/80">Day {w.dayCurrent} of {w.totalDays}</span>
            <button onClick={() => setDismissed(true)} className="text-white/50 hover:text-white text-lg leading-none" aria-label="Dismiss">×</button>
          </div>
        </div>

        <div className="h-2.5 rounded-full bg-white/15 overflow-hidden">
          <div className="h-full rounded-full bg-gradient-to-r from-teal-400 to-emerald-400 transition-all duration-700" style={{ width: `${w.pct ?? 0}%` }} />
        </div>

        <div className="flex items-center justify-between mt-1.5 text-xs text-white/70">
          <span>{w.pct}% warmed up</span>
          <span>{w.daysLeft === 1 ? '1 day until your campaign goes live' : `${w.daysLeft} days until your campaign goes live`}</span>
        </div>
      </div>
    </div>
  )
}
