import { FreshnessBadge } from '@/components/ui/freshness-badge'
import type { FreshnessMeta } from '@/lib/freshness'

/**
 * Consistent page frame: title band with a teal underline accent, optional
 * subtitle, right-aligned actions, and an optional freshness badge. Every
 * scope page renders inside one of these so the app reads as one product.
 */
export function PageShell({
  title,
  subtitle,
  actions,
  freshness,
  children,
}: {
  title: string
  subtitle?: string
  actions?: React.ReactNode
  freshness?: FreshnessMeta | null
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="font-[family-name:var(--font-display)] text-[1.7rem] font-bold leading-none text-foreground">{title}</h1>
            {freshness !== undefined && <FreshnessBadge syncedAt={freshness?.syncedAt ?? null} />}
          </div>
          {subtitle && <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>}
          <div className="mt-2 h-[3px] w-10 rounded-full bg-[var(--chart-1)]" />
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  )
}
