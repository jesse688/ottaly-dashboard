'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { href: '/contacts',  label: 'Contacts' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/mailboxes', label: 'Mailboxes' },
  { href: '/clients',   label: 'Clients' },
  { href: '/domains',   label: 'Domains' },
  { href: '/health',    label: 'Health' },
  { href: '/finance',   label: 'Finance' },
  { href: '/stats',     label: 'Stats' },
  { href: '/leads',     label: 'Leads' },
]

export function Nav() {
  const pathname = usePathname()

  return (
    <nav className="h-screen w-56 bg-gray-900 flex flex-col shrink-0">
      <div className="px-4 py-5 border-b border-gray-800">
        <span className="text-white font-semibold text-lg">Ottaly</span>
        <span className="text-gray-400 text-xs ml-2">Admin</span>
      </div>
      <div className="flex-1 py-4 overflow-y-auto">
        {NAV_ITEMS.map(item => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center px-4 py-2.5 text-sm transition-colors',
              pathname.startsWith(item.href)
                ? 'bg-gray-800 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            )}
          >
            {item.label}
          </Link>
        ))}
      </div>
      <div className="px-4 py-4 border-t border-gray-800">
        <button
          className="text-xs text-gray-500 hover:text-gray-300"
          onClick={async () => {
            await fetch('/api/auth', { method: 'DELETE' })
            window.location.href = '/login'
          }}
        >
          Sign out
        </button>
      </div>
    </nav>
  )
}
