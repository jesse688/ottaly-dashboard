'use client'

import { useState } from 'react'
import logoNavy from '@/public/ottaly-logo.svg'
import logoWhite from '@/public/ottaly-logo-dark.svg'

// The real Ottaly logo (otter mark + "OTTALY · PREDICTABLE PIPELINE" wordmark),
// imported as a bundled static asset so it can never 404 (a hardcoded /path
// would silently fall back to the text wordmark if the deploy was stale). Falls
// back to a clean text wordmark only if the image genuinely fails to render.
export function Logo({ size = 'sm', onDark = false }: { size?: 'sm' | 'lg'; onDark?: boolean }) {
  const [imgOk, setImgOk] = useState(true)
  const h = size === 'lg' ? 'h-12' : 'h-8'
  const src = (onDark ? logoWhite : logoNavy) as unknown as string

  if (imgOk) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="Ottaly — Predictable Pipeline" className={`${h} w-auto`} onError={() => setImgOk(false)} />
    )
  }
  return (
    <div className="flex flex-col leading-none select-none">
      <span className={`font-extrabold ${onDark ? 'text-white' : 'text-[#0b0b0c]'} ${size === 'lg' ? 'text-[34px] tracking-[-0.01em]' : 'text-[22px] tracking-[-0.01em]'}`}>OTTALY</span>
      <span className={`font-medium uppercase ${onDark ? 'text-gray-300' : 'text-[#0b0b0c]'} ${size === 'lg' ? 'text-[12px] tracking-[0.34em] mt-1.5' : 'text-[8px] tracking-[0.28em] mt-1'}`}>Predictable Pipeline</span>
    </div>
  )
}
