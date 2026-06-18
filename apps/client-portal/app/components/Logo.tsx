'use client'

import { useState } from 'react'

// The logo files live in /public and are served at these URLs. We reference them
// as plain public paths (NOT `import logo from '...svg'`, which Next turns into a
// StaticImageData object — passing that object to <img src> renders
// "[object Object]" and the image breaks). Falls back to a text wordmark only if
// the file genuinely 404s.
const SRC = { navy: '/ottaly-logo.svg', white: '/ottaly-logo-dark.svg' }

export function Logo({ size = 'sm', onDark = false }: { size?: 'sm' | 'lg'; onDark?: boolean }) {
  const [imgOk, setImgOk] = useState(true)
  const h = size === 'lg' ? 'h-12' : 'h-8'
  const src = onDark ? SRC.white : SRC.navy

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
