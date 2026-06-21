'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import {
  Server, BarChart3, Users, Wallet, Settings, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/ui/theme-toggle'

interface NavItem { href: string; label: string }
interface Category {
  key: string
  label: string
  icon: LucideIcon
  color: string // category accent (legacy palette)
  items: NavItem[]
}

// Legacy category structure + colours, filled with admin-2.0 scope pages only.
const CATEGORIES: Category[] = [
  {
    key: 'infra', label: 'Infra', icon: Server, color: '#3B82F6', // blue
    items: [
      { href: '/domains', label: 'Domains' },
      { href: '/mailboxes', label: 'Mailboxes' },
      { href: '/warmup', label: 'Warmup' },
      { href: '/apollo-prep', label: 'Apollo Prep' },
    ],
  },
  {
    key: 'stats', label: 'Stats', icon: BarChart3, color: '#F59E0B', // gold
    items: [
      { href: '/stats', label: 'Stats' },
      { href: '/actions', label: 'Actions' },
      { href: '/audience', label: 'Audience' },
      { href: '/gateways', label: 'Gateways' },
      { href: '/bounces', label: 'Bounces' },
    ],
  },
  {
    key: 'clients', label: 'Clients', icon: Users, color: '#FB923C', // orange
    items: [
      { href: '/clients', label: 'Clients' },
      { href: '/health', label: 'Health' },
      { href: '/workload', label: 'Workload' },
    ],
  },
  {
    key: 'finance', label: 'Finance', icon: Wallet, color: '#22C55E', // green
    items: [
      { href: '/finance', label: 'Finance' },
      { href: '/revenue', label: 'Revenue' },
      { href: '/commission', label: 'Commission' },
    ],
  },
  {
    key: 'admin', label: 'Admin', icon: Settings, color: '#F87171', // red
    items: [{ href: '/admin', label: 'Settings' }],
  },
]

/** Legacy-style rail: colored category groups, hover reveals a dropdown of its pages.
 *  The dropdown is rendered as a fixed-position layer so the rail's scroll/overflow
 *  can never clip it (the bug where the flyout was hidden). */
export function Sidebar() {
  const pathname = usePathname()
  const [open, setOpen] = useState<string | null>(null)
  const [flyTop, setFlyTop] = useState(0)

  const openCat = CATEGORIES.find(c => c.key === open) ?? null

  function handleEnter(key: string, e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    setFlyTop(rect.top)
    setOpen(key)
  }

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 flex w-[84px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="flex h-14 items-center justify-center border-b border-sidebar-border">
          <Image src="/favicon.svg" alt="Ottaly" width={30} height={30} priority className="h-[30px] w-[30px]" />
        </div>

        <nav className="flex-1 overflow-y-auto py-2 [scrollbar-width:none]">
          {CATEGORIES.map(cat => {
            const Icon = cat.icon
            const activeInCat = cat.items.some(i => pathname === i.href || pathname.startsWith(i.href + '/'))
            const isOpen = open === cat.key
            return (
              <div
                key={cat.key}
                className="px-1.5"
                onMouseEnter={(e) => handleEnter(cat.key, e)}
                onMouseLeave={() => setOpen(null)}
              >
                <button
                  type="button"
                  className={cn(
                    'flex w-full flex-col items-center gap-1 rounded-md py-2.5 transition-colors',
                    activeInCat || isOpen ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent',
                  )}
                >
                  <Icon size={20} strokeWidth={2} style={{ color: cat.color }} />
                  <span
                    className="text-[9px] font-bold uppercase leading-none tracking-wide"
                    style={{ color: activeInCat || isOpen ? cat.color : undefined }}
                  >
                    {cat.label}
                  </span>
                </button>
              </div>
            )
          })}
        </nav>

        <div className="flex items-center justify-center border-t border-sidebar-border py-2">
          <ThemeToggle />
        </div>
      </aside>

      {/* Fixed flyout — sits above everything, bridges the gap back to the rail so it
          doesn't close while the cursor travels across. */}
      {openCat && (
        <div
          className="fixed left-[84px] z-50"
          style={{ top: flyTop }}
          onMouseEnter={() => setOpen(openCat.key)}
          onMouseLeave={() => setOpen(null)}
        >
          <div className="min-w-[200px] overflow-hidden rounded-lg border border-border bg-popover py-1.5 shadow-2xl">
            <div
              className="px-3 pb-1.5 pt-1 text-[10px] font-bold uppercase tracking-wider"
              style={{ color: openCat.color }}
            >
              {openCat.label}
            </div>
            {openCat.items.map(item => {
              const active = pathname === item.href || pathname.startsWith(item.href + '/')
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(null)}
                  className={cn(
                    'block px-3 py-1.5 text-[13px] font-medium transition-colors',
                    active
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {item.label}
                </Link>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
