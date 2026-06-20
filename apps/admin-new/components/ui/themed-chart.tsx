'use client'

import { useEffect, useRef } from 'react'

/** Reads a CSS custom property (e.g. --chart-1) resolved to a real color. */
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export interface LineSeries {
  label: string
  data: (number | null)[]
  /** chart palette slot 1-5; maps to --chart-N */
  tone?: 1 | 2 | 3 | 4 | 5
  percent?: boolean
}

/**
 * Thin chart.js line-chart wrapper that inherits the Ottaly theme — colors come
 * from --chart-1..5 CSS vars so charts match dark/light automatically. Dynamic
 * import keeps chart.js out of the SSR bundle.
 */
export function LineChart({
  labels,
  series,
  height = 240,
}: {
  labels: string[]
  series: LineSeries[]
  height?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<{ destroy(): void } | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    let cancelled = false
    import('chart.js/auto').then(({ default: Chart }) => {
      if (cancelled || !canvasRef.current) return
      chartRef.current?.destroy()
      const slot = (n?: number) => cssVar(`--chart-${n ?? 1}`, '#1F6F78')
      const grid = cssVar('--border', 'rgba(120,120,140,0.2)')
      const text = cssVar('--muted-foreground', '#6B7280')
      const hasPct = series.some(s => s.percent)
      const hasCount = series.some(s => !s.percent)
      chartRef.current = new Chart(canvasRef.current, {
        type: 'line',
        data: {
          labels,
          datasets: series.map(s => ({
            label: s.label,
            data: s.data,
            borderColor: slot(s.tone),
            backgroundColor: slot(s.tone) + '22',
            borderWidth: 2,
            pointRadius: labels.length <= 14 ? 3 : 1,
            tension: 0.3,
            spanGaps: true,
            fill: false,
            yAxisID: s.percent ? 'yPct' : 'yCount',
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: text, font: { size: 11 } } },
            yPct: {
              display: hasPct, position: 'left', beginAtZero: true,
              grid: { color: grid }, ticks: { color: text, font: { size: 11 }, callback: v => v + '%' },
            },
            yCount: {
              display: hasCount, position: 'right', beginAtZero: true,
              grid: { drawOnChartArea: false }, ticks: { color: text, font: { size: 11 } },
            },
          },
        },
      }) as unknown as { destroy(): void }
    })
    return () => { cancelled = true; chartRef.current?.destroy(); chartRef.current = null }
  }, [labels, series])

  return <div style={{ height }}><canvas ref={canvasRef} /></div>
}
