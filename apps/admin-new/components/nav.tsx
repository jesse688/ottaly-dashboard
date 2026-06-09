'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const NAV_SECTIONS = [
  { label: 'Infra', items: [
    { href: '/domains',    label: 'Domains' },
    { href: '/mailboxes',  label: 'Mailboxes' },
  ]},
  { label: 'Outreach', items: [
    { href: '/campaigns',  label: 'Campaigns' },
    { href: '/copy',       label: 'Copy' },
  ]},
  { label: 'Data', items: [
    { href: '/contacts',     label: 'Contacts' },
    { href: '/leads',        label: 'Leads' },
    { href: '/data-sources', label: 'Data Sources' },
  ]},
  { label: 'Performance', items: [
    { href: '/stats',    label: 'Stats' },
    { href: '/health',   label: 'Health' },
    { href: '/finance',  label: 'Finance' },
    { href: '/revenue',  label: 'Revenue' },
    { href: '/metrics',  label: 'Metrics' },
  ]},
  { label: 'Intelligence', items: [
    { href: '/diagnostics',    label: 'Diagnostics' },
    { href: '/intelligence',   label: 'Intelligence' },
    { href: '/leads-analysis', label: 'Leads Analysis' },
    { href: '/combo-analysis', label: 'Combo Analysis' },
    { href: '/capacity',       label: 'Capacity' },
    { href: '/workload',       label: 'Workload' },
  ]},
  { label: 'Clients', items: [
    { href: '/clients', label: 'Clients' },
  ]},
  { label: 'Tools', items: [
    { href: '/actions',        label: 'Actions' },
    { href: '/apollo-prep',    label: 'Apollo Prep' },
    { href: '/audience',       label: 'Audience' },
    { href: '/commission',     label: 'Commission' },
    { href: '/database',       label: 'Database' },
    { href: '/verify-split',   label: 'Verify Split' },
    { href: '/admin-settings', label: 'Admin Settings' },
  ]},
]

export function Nav() {
  const pathname = usePathname()

  return (
    <nav className="h-screen w-52 bg-gray-900 flex flex-col shrink-0">
      <Link href="/" className="px-4 py-5 border-b border-gray-800 block hover:bg-gray-800 transition-colors">
        <span className="text-white font-semibold text-lg">Ottaly</span>
        <span className="text-gray-400 text-xs ml-2">Admin</span>
      </Link>
      <div className="flex-1 py-2 overflow-y-auto">
        {NAV_SECTIONS.map(section => (
          <div key={section.label} className="mb-1">
            <div className="px-4 py-1.5 text-[10px] font-bold text-gray-500 uppercase tracking-widest">
              {section.label}
            </div>
            {section.items.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center px-4 py-1.5 text-sm transition-colors',
                  pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                )}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </div>
      <div className="px-4 py-4 border-t border-gray-800">
        <button
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
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
