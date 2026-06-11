'use client'

import { useState } from 'react'

// Shows /ottaly-logo.png (or .svg) if present; otherwise a clean uppercase
// "OTTALY · PREDICTABLE PIPELINE" wordmark matching the brand, so it always
// looks polished even before the asset is added.
export function Logo({ size = 'sm', onDark = false }: { size?: 'sm' | 'lg'; onDark?: boolean }) {
  const [imgOk, setImgOk] = useState(true)
  const h = size === 'lg' ? 'h-12' : 'h-8'

  if (imgOk) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/ottaly-logo.png" alt="Ottaly — Predictable Pipeline" className={`${h} w-auto`} onError={() => setImgOk(false)} />
    )
  }
  return (
    <div className="flex flex-col leading-none select-none">
      <span className={`font-extrabold ${onDark ? 'text-white' : 'text-[#0b0b0c]'} ${size === 'lg' ? 'text-[34px] tracking-[-0.01em]' : 'text-[22px] tracking-[-0.01em]'}`}>OTTALY</span>
      <span className={`font-medium uppercase ${onDark ? 'text-gray-300' : 'text-[#0b0b0c]'} ${size === 'lg' ? 'text-[12px] tracking-[0.34em] mt-1.5' : 'text-[8px] tracking-[0.28em] mt-1'}`}>Predictable Pipeline</span>
    </div>
  )
}
