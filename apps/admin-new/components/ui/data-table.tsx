'use client'

import { useState, useMemo } from 'react'
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface Column<T> {
  key: string
  header: string
  /** cell renderer */
  cell: (row: T) => React.ReactNode
  /** value used for sorting; omit to disable sort on this column */
  sortValue?: (row: T) => string | number
  /** right-align + tabular-nums for numeric columns */
  numeric?: boolean
  className?: string
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  onRowClick,
  empty = 'No data.',
  dense = true,
  footer,
}: {
  columns: Column<T>[]
  rows: T[]
  getRowKey: (row: T, i: number) => string
  onRowClick?: (row: T) => void
  empty?: React.ReactNode
  dense?: boolean
  /** optional totals/summary row rendered after the body */
  footer?: React.ReactNode
}) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')

  const sorted = useMemo(() => {
    if (!sortKey) return rows
    const col = columns.find(c => c.key === sortKey)
    if (!col?.sortValue) return rows
    const sv = col.sortValue
    return [...rows].sort((a, b) => {
      const av = sv(a), bv = sv(b)
      if (av < bv) return dir === 'asc' ? -1 : 1
      if (av > bv) return dir === 'asc' ? 1 : -1
      return 0
    })
  }, [rows, sortKey, dir, columns])

  function toggleSort(col: Column<T>) {
    if (!col.sortValue) return
    if (sortKey === col.key) setDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(col.key); setDir('desc') }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur">
            <tr>
              {columns.map(col => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col)}
                  className={cn(
                    'whitespace-nowrap border-b border-border px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
                    col.numeric ? 'text-right' : 'text-left',
                    col.sortValue && 'cursor-pointer select-none hover:text-foreground',
                    col.className,
                  )}
                >
                  <span className={cn('inline-flex items-center gap-1', col.numeric && 'flex-row-reverse')}>
                    {col.header}
                    {col.sortValue && (
                      sortKey === col.key
                        ? (dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
                        : <ChevronsUpDown size={12} className="opacity-40" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3.5 py-12 text-center text-muted-foreground">
                  {empty}
                </td>
              </tr>
            ) : (
              sorted.map((row, i) => (
                <tr
                  key={getRowKey(row, i)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'border-b border-border/60 last:border-0 transition-colors',
                    onRowClick && 'cursor-pointer hover:bg-accent/50',
                  )}
                >
                  {columns.map(col => (
                    <td
                      key={col.key}
                      className={cn(
                        dense ? 'px-3.5 py-2' : 'px-3.5 py-3',
                        col.numeric ? 'text-right tabular-nums' : 'text-left',
                        col.className,
                      )}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {footer && sorted.length > 0 && <tfoot>{footer}</tfoot>}
        </table>
      </div>
    </div>
  )
}
