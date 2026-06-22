import { cn } from '@/lib/utils'

export type StatusTone = 'ok' | 'warn' | 'error' | 'info' | 'paused' | 'neutral'

const TONES: Record<StatusTone, string> = {
  ok: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-emerald-500/25',
  warn: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-amber-500/25',
  error: 'bg-red-500/15 text-red-600 dark:text-red-400 ring-red-500/25',
  info: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 ring-blue-500/25',
  paused: 'bg-slate-500/15 text-slate-500 dark:text-slate-400 ring-slate-500/25',
  neutral: 'bg-muted text-muted-foreground ring-border',
}

export function StatusBadge({
  status,
  children,
  className,
}: {
  status: StatusTone
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset',
        TONES[status],
        className,
      )}
    >
      {children}
    </span>
  )
}
