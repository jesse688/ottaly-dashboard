'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

interface Props {
  companyName: string
  children: React.ReactNode
}

const NAV = [
  { href: '/dashboard',  label: 'Overview',   icon: GridIcon },
  { href: '/campaigns',  label: 'Campaigns',  icon: SendIcon },
  { href: '/leads',      label: 'Leads',      icon: UsersIcon },
]

export function PortalLayout({ companyName, children }: Props) {
  const pathname = usePathname()
  const router = useRouter()

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST' })
    router.push('/login')
  }

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <header className="h-12 bg-slate-900 flex items-center px-4 shrink-0 gap-3">
        <span className="text-white font-bold text-sm tracking-wide">Ottaly</span>
        <span className="text-slate-500 text-xs">|</span>
        <span className="text-slate-300 text-sm">{companyName}</span>
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={handleLogout}
            className="text-slate-400 hover:text-white text-xs transition-colors"
          >
            Sign out
          </button>
          <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-semibold">
            {companyName.charAt(0).toUpperCase()}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <nav className="w-52 bg-white border-r border-gray-100 flex flex-col py-4 shrink-0">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-3 mx-2 px-3 py-2 rounded-lg text-sm transition-colors',
                  active
                    ? 'bg-indigo-50 text-indigo-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                )}
              >
                <Icon size={16} className={active ? 'text-indigo-600' : 'text-gray-400'} />
                {label}
              </Link>
            )
          })}
        </nav>

        {/* Main content */}
        <main className="flex-1 overflow-auto bg-gray-50">
          {children}
        </main>
      </div>
    </div>
  )
}

function GridIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
    </svg>
  )
}

function SendIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <line x1="22" y1="2" x2="11" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  )
}

function UsersIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  )
}
