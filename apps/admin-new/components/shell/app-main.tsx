'use client'

import { cn } from '@/lib/utils'
import { useSidebar } from '@/components/shell/sidebar-state'

/** Main content area whose left offset follows the sidebar hidden/shown state. */
export function AppMain({ children }: { children: React.ReactNode }) {
  const { hidden } = useSidebar()
  return (
    <main className={cn('min-h-screen transition-[padding] duration-200', hidden ? 'pl-0' : 'pl-[84px]')}>
      {children}
    </main>
  )
}
