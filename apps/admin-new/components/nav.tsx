'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useRef, useCallback } from 'react'

interface Page { href: string; label: string }
interface Section {
  label: string
  color: string
  icon: React.ReactNode
  pages: Page[]
}

const SECTIONS: Section[] = [
  {
    label: 'Infra',
    color: '#60A5FA',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
      </svg>
    ),
    pages: [
      { href: '/domains',   label: 'Domains' },
      { href: '/mailboxes', label: 'Mailboxes' },
      { href: '/capacity',  label: 'Capacity' },
    ],
  },
  {
    label: 'Copy',
    color: '#A78BFA',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
    ),
    pages: [
      { href: '/campaigns',     label: 'Campaigns' },
      { href: '/copy',          label: 'Copy Analytics' },
      { href: '/leads-analysis',label: 'Leads Analysis' },
    ],
  },
  {
    label: 'Data',
    color: '#22D3EE',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
      </svg>
    ),
    pages: [
      { href: '/contacts',      label: 'Contacts' },
      { href: '/leads',         label: 'Leads' },
      { href: '/database',      label: 'Database' },
      { href: '/apollo-prep',   label: 'Apollo Prep' },
      { href: '/verify-split',  label: 'Verify Split' },
      { href: '/combo-analysis',label: 'Combo Analysis' },
    ],
  },
  {
    label: 'Stats',
    color: '#FBBF24',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
      </svg>
    ),
    pages: [
      { href: '/actions',      label: 'Actions' },
      { href: '/stats',        label: 'Stats' },
      { href: '/health',       label: 'Health' },
      { href: '/metrics',      label: 'Metrics' },
      { href: '/audience',     label: 'Audience' },
      { href: '/diagnostics',  label: 'Diagnostics' },
      { href: '/intelligence', label: 'Intelligence' },
      { href: '/gateway-analysis', label: 'Gateways' },
    ],
  },
  {
    label: 'Finance',
    color: '#4ADE80',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
      </svg>
    ),
    pages: [
      { href: '/finance',  label: 'Finance' },
      { href: '/revenue',  label: 'Revenue' },
    ],
  },
  {
    label: 'Clients',
    color: '#FB923C',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
      </svg>
    ),
    pages: [
      { href: '/clients', label: 'Clients' },
    ],
  },
  {
    label: 'Admin',
    color: '#F87171',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M4.93 19.07l1.41-1.41M19.07 19.07l-1.41-1.41M12 2v2M12 20v2M2 12h2M20 12h2"/>
      </svg>
    ),
    pages: [
      { href: '/admin-settings', label: 'Admin Settings' },
      { href: '/workload',       label: 'CM Workload' },
      { href: '/commission',     label: 'Commission' },
    ],
  },
]

export function Nav() {
  const pathname = usePathname()
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [flyoutTop, setFlyoutTop] = useState(0)
  const wrapRefs = useRef<(HTMLDivElement | null)[]>([])

  const handleEnter = useCallback((idx: number) => {
    const el = wrapRefs.current[idx]
    if (el) {
      const rect = el.getBoundingClientRect()
      setFlyoutTop(rect.top)
    }
    setHoveredIdx(idx)
  }, [])

  const handleLeave = useCallback(() => {
    setHoveredIdx(null)
  }, [])

  function sectionHasActive(section: Section) {
    return section.pages.some(p => pathname === p.href || (p.href !== '/' && pathname.startsWith(p.href)))
  }

  const activeSection = SECTIONS.findIndex(s => sectionHasActive(s))
  const hovered = hoveredIdx !== null ? SECTIONS[hoveredIdx] : null

  return (
    <>
      <aside
        style={{ width: 65, background: '#050C29', borderRight: '1px solid rgba(255,255,255,0.07)' }}
        className="h-screen fixed top-0 left-0 flex flex-col z-[10000]"
      >
        {/* Logo */}
        <Link
          href="/"
          className="flex items-center justify-center py-3 shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}
        >
          <span style={{ color: '#1F6F78', fontWeight: 800, fontSize: 18, letterSpacing: -0.5 }}>O</span>
        </Link>

        {/* Section icons */}
        <div className="flex-1 flex flex-col py-1.5 overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
          {SECTIONS.map((section, idx) => {
            const isActive = activeSection === idx
            const isHovered = hoveredIdx === idx
            const color = section.color

            return (
              <div
                key={section.label}
                ref={el => { wrapRefs.current[idx] = el }}
                onMouseEnter={() => handleEnter(idx)}
                onMouseLeave={handleLeave}
                className="relative"
              >
                <button
                  className="w-full flex flex-col items-center justify-center gap-1 py-2.5 px-1 border-0 cursor-pointer transition-all duration-150"
                  style={{
                    background: isActive || isHovered ? `color-mix(in srgb, ${color} 12%, transparent)` : 'none',
                    borderLeft: `3px solid ${isActive ? color : 'transparent'}`,
                    color: isActive || isHovered ? color : 'rgba(255,255,255,0.35)',
                  }}
                >
                  <span style={{ color: isActive ? '#fff' : isHovered ? color : 'rgba(255,255,255,0.4)', display: 'flex' }}>
                    {section.icon}
                  </span>
                  <span style={{
                    font: `700 8px/1 Inter, sans-serif`,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    color: isActive ? color : isHovered ? color : 'rgba(255,255,255,0.3)',
                    fontWeight: isActive ? 800 : 700,
                  }}>
                    {section.label}
                  </span>
                </button>
              </div>
            )
          })}
        </div>

        {/* Sign out */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', padding: '10px 0', flexShrink: 0 }}>
          <button
            className="w-full flex flex-col items-center gap-1 py-2 px-1 border-0 cursor-pointer transition-colors"
            style={{ color: 'rgba(255,255,255,0.3)', background: 'none' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.7)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
            onClick={async () => {
              await fetch('/api/auth', { method: 'DELETE' })
              window.location.href = '/login'
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            <span style={{ font: '700 8px/1 Inter, sans-serif', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Out</span>
          </button>
        </div>
      </aside>

      {/* Flyout panel — rendered outside sidebar to avoid clipping */}
      {hovered && (
        <div
          onMouseEnter={() => setHoveredIdx(hoveredIdx)}
          onMouseLeave={handleLeave}
          style={{
            position: 'fixed',
            top: flyoutTop,
            left: 65,
            minWidth: 170,
            background: '#0d1b3e',
            border: '1px solid rgba(255,255,255,0.1)',
            borderLeft: `3px solid ${hovered.color}`,
            borderRadius: '0 8px 8px 0',
            padding: '6px 0',
            zIndex: 10001,
            boxShadow: '4px 4px 20px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{
            padding: '6px 14px 8px',
            font: '700 10px/1 Inter, sans-serif',
            textTransform: 'uppercase',
            letterSpacing: '0.6px',
            color: 'rgba(255,255,255,0.35)',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            marginBottom: 4,
          }}>
            {hovered.label}
          </div>
          {hovered.pages.map(page => {
            const isActive = pathname === page.href || (page.href !== '/' && pathname.startsWith(page.href))
            return (
              <Link
                key={page.href}
                href={page.href}
                style={{
                  display: 'block',
                  padding: isActive ? '8px 13px' : '8px 16px',
                  font: '500 13px/1 Inter, sans-serif',
                  color: isActive ? '#fff' : 'rgba(255,255,255,0.6)',
                  textDecoration: 'none',
                  background: isActive ? 'rgba(31,111,120,0.25)' : 'transparent',
                  borderLeft: isActive ? `3px solid #1F6F78` : '3px solid transparent',
                  whiteSpace: 'nowrap',
                  transition: 'color .1s, background .1s',
                }}
                onMouseEnter={e => {
                  if (!isActive) {
                    e.currentTarget.style.color = '#fff'
                    e.currentTarget.style.background = 'rgba(255,255,255,0.07)'
                  }
                }}
                onMouseLeave={e => {
                  if (!isActive) {
                    e.currentTarget.style.color = 'rgba(255,255,255,0.6)'
                    e.currentTarget.style.background = 'transparent'
                  }
                }}
              >
                {page.label}
              </Link>
            )
          })}
        </div>
      )}

      {/* Body offset */}
      <div style={{ width: 65, flexShrink: 0 }} />
    </>
  )
}
