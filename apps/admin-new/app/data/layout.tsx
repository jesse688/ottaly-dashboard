'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

// The Engine (scraper-service) runs as its own app on Easypanel — link out.
const ENGINE_UI_URL =
  process.env.NEXT_PUBLIC_ENGINE_UI_URL ??
  'https://ottaly-ottaly-engine-ui.oix3xv.easypanel.host'

type Tab = { href: string; label: string; group: 'pool' | 'sources' | 'tools' }

const TABS: Tab[] = [
  { href: '/data',                 label: 'Contacts',       group: 'pool' },
  { href: '/data/engine-leads',    label: 'Engine Leads',   group: 'pool' },
  { href: '/data/database',        label: 'Database',       group: 'pool' },
  { href: '/data/ch-pipeline',     label: 'CH Pipeline',    group: 'sources' },
  { href: '/data/enrichment',      label: 'Enrichment',     group: 'sources' },
  { href: '/data/apollo-prep',     label: 'Apollo Prep',    group: 'tools' },
  { href: '/data/verify-split',    label: 'Verify Split',   group: 'tools' },
  { href: '/data/combo-analysis',  label: 'Combo Analysis', group: 'tools' },
]

const GROUP_LABEL: Record<Tab['group'], string> = {
  pool: 'Pool',
  sources: 'Sources',
  tools: 'Tools',
}

function isActive(pathname: string, href: string) {
  return href === '/data' ? pathname === '/data' : pathname.startsWith(href)
}

export default function DataLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const groups: Tab['group'][] = ['pool', 'sources', 'tools']

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-gray-200 bg-white px-6 pt-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">Data</h1>
          <a
            href={ENGINE_UI_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            Engine ↗
          </a>
        </div>
        <nav className="mt-3 flex items-end gap-6 overflow-x-auto">
          {groups.map(group => (
            <div key={group} className="flex flex-col">
              <span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                {GROUP_LABEL[group]}
              </span>
              <div className="flex">
                {TABS.filter(t => t.group === group).map(tab => {
                  const active = isActive(pathname, tab.href)
                  return (
                    <Link
                      key={tab.href}
                      href={tab.href}
                      className={cn(
                        'whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
                        active
                          ? 'border-blue-600 font-medium text-blue-700'
                          : 'border-transparent text-gray-500 hover:text-gray-900'
                      )}
                    >
                      {tab.label}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
      </header>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  )
}
