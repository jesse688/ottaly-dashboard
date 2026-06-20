import { cn } from '@/lib/utils'

type Tone = 'teal' | 'navy' | 'purple' | 'yellow' | 'green' | 'red'

const TOP_BORDER: Record<Tone, string> = {
  teal: 'border-t-[var(--chart-1)]',
  navy: 'border-t-[var(--chart-2)]',
  purple: 'border-t-[var(--chart-3)]',
  yellow: 'border-t-[var(--chart-4)]',
  green: 'border-t-[var(--chart-5)]',
  red: 'border-t-destructive',
}

export function KpiCard({
  label,
  value,
  sub,
  delta,
  deltaLabel,
  tone = 'teal',
  loading = false,
}: {
  label: string
  value: string | number
  sub?: string
  /** signed percentage; green when >=0, red when <0 */
  delta?: number
  deltaLabel?: string
  tone?: Tone
  loading?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-t-[3px] bg-card p-4 shadow-sm',
        TOP_BORDER[tone],
      )}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {loading ? (
        <div className="mt-2 h-7 w-20 animate-pulse rounded bg-muted" />
      ) : (
        <div className="mt-1 font-[family-name:var(--font-display)] text-[2rem] font-bold leading-none tabular-nums text-foreground">{value}</div>
      )}
      <div className="mt-0.5 flex items-center gap-2">
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
        {typeof delta === 'number' && (
          <span
            className={cn(
              'text-xs font-semibold tabular-nums',
              delta >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
            )}
          >
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}%{deltaLabel ? ` ${deltaLabel}` : ''}
          </span>
        )}
      </div>
    </div>
  )
}
