'use client'

import { useState } from 'react'

// Shows /ottaly-logo.png if present; otherwise a clean "Ottaly · Predictable
// Pipeline" wordmark so the brand always looks polished.
export function Logo({ size = 'sm', onDark = false }: { size?: 'sm' | 'lg'; onDark?: boolean }) {
  const [imgOk, setImgOk] = useState(true)
  const h = size === 'lg' ? 'h-12' : 'h-8'

  if (imgOk) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/ottaly-logo.png" alt="Ottaly" className={`${h} w-auto`} onError={() => setImgOk(false)} />
    )
  }
  return (
    <div className="flex flex-col leading-none">
      <span className={`font-extrabold tracking-tight ${onDark ? 'text-white' : 'text-[#111827]'} ${size === 'lg' ? 'text-3xl' : 'text-xl'}`}>Ottaly</span>
      <span className={`uppercase ${onDark ? 'text-gray-300' : 'text-gray-400'} ${size === 'lg' ? 'text-[10px] tracking-[0.28em] mt-1' : 'text-[7px] tracking-[0.2em] mt-0.5'}`}>Predictable Pipeline</span>
    </div>
  )
}
