'use client'

import { Checkbox } from '@/components/ui/checkbox'
import { FIELD_CATALOG } from '@/lib/enrich-fields'

export function FieldPicker({
  value,
  onChange,
  className = '',
}: {
  value: string[]
  onChange: (next: string[]) => void
  className?: string
}) {
  const selected = new Set(value)
  const toggle = (key: string) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(Array.from(next))
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {FIELD_CATALOG.map((f) => (
          <label key={f.key} className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <Checkbox checked={selected.has(f.key)} onCheckedChange={() => toggle(f.key)} aria-label={f.label} />
            <span>{f.label}</span>
            {f.claude && (
              <span className="text-[10px] font-bold uppercase tracking-wide text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded">AI</span>
            )}
          </label>
        ))}
      </div>
    </div>
  )
}
