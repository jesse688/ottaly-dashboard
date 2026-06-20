'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import {
  BarChart3, Activity, AlertTriangle, ShieldCheck, Users, Globe, Inbox,
  Flame, Database, Target, HeartPulse, Briefcase, Wallet, PoundSterling,
  Settings, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/ui/theme-toggle'

interface NavItem { href: string; label: string; icon: LucideIcon }
interface NavGroup { label: string; items: NavItem[] }

// Scope = admin 2.0 only. Dropped: Copy, Verify-split, Database-tools, etc.
const GROUPS: NavGroup[] = [
  {
    label: 'Performance',
    items: [
      { href: '/stats', label: 'Stats', icon: BarChart3 },
      { href: '/actions', label: 'Actions', icon: Activity },
      { href: '/bounces', label: 'Bounces', icon: AlertTriangle },
      { href: '/gateways', label: 'Gateways', icon: ShieldCheck },
      { href: '/audience', label: 'Audience', icon: Target },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { href: '/domains', label: 'Domains', icon: Globe },
      { href: '/mailboxes', label: 'Mailboxes', icon: Inbox },
      { href: '/warmup', label: 'Warmup', icon: Flame },
      { href: '/apollo-prep', label: 'Apollo Prep', icon: Database },
    ],
  },
  {
    label: 'Clients',
    items: [
      { href: '/clients', label: 'Clients', icon: Users },
      { href: '/health', label: 'Health', icon: HeartPulse },
      { href: '/workload', label: 'Workload', icon: Briefcase },
      { href: '/commission', label: 'Commission', icon: PoundSterling },
    ],
  },
  {
    label: 'Finance',
    items: [
      { href: '/finance', label: 'Finance', icon: Wallet },
      { href: '/revenue', label: 'Revenue', icon: PoundSterling },
    ],
  },
  {
    label: 'Admin',
    items: [{ href: '/admin', label: 'Settings', icon: Settings }],
  },
]

/** Narrow ~84px rail — light surface, otter mark, icon + small label per item (like legacy). */
export function Sidebar() {
  const pathname = usePathname()
  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-[84px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center justify-center border-b border-sidebar-border">
        <Image src="/favicon.svg" alt="Ottaly" width={30} height={30} priority className="h-[30px] w-[30px]" />
      </div>

      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2 [scrollbar-width:none]">
        {GROUPS.map((group, gi) => (
          <div key={group.label} className={cn('flex flex-col items-center gap-0.5 px-1.5', gi > 0 && 'mt-1.5 border-t border-sidebar-border/70 pt-1.5')}>
            {group.items.map(item => {
              const active = pathname === item.href || pathname.startsWith(item.href + '/')
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'group relative flex w-full flex-col items-center gap-1 rounded-md py-2 transition-colors',
                    active
                      ? 'bg-sidebar-accent text-sidebar-primary'
                      : 'text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground',
                  )}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-full bg-sidebar-primary" />
                  )}
                  <Icon size={19} strokeWidth={active ? 2.3 : 1.9} />
                  <span className="text-[9px] font-semibold uppercase leading-none tracking-wide">{item.label}</span>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="flex items-center justify-center border-t border-sidebar-border py-2">
        <ThemeToggle />
      </div>
    </aside>
  )
}
