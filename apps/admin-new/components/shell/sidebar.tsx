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

export function Sidebar() {
  const pathname = usePathname()
  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-[220px] flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
        <Image src="/logo-white.svg" alt="Ottaly" width={104} height={26} priority className="h-6 w-auto" />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {GROUPS.map(group => (
          <div key={group.label} className="mb-4">
            <div className="px-2.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-sidebar-foreground/40">
              {group.label}
            </div>
            {group.items.map(item => {
              const active = pathname === item.href || pathname.startsWith(item.href + '/')
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                    active
                      ? 'bg-sidebar-accent text-sidebar-foreground'
                      : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                  )}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-sidebar-primary" />
                  )}
                  <Icon size={16} className={active ? 'text-sidebar-primary' : ''} />
                  {item.label}
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="flex items-center justify-between border-t border-sidebar-border px-3 py-2.5">
        <span className="text-[11px] text-sidebar-foreground/40">Ottaly Admin</span>
        <ThemeToggle />
      </div>
    </aside>
  )
}
