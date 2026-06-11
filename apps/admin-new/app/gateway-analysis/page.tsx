'use client'

import { useEffect, useState } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface Gateway {
  gateway: string
  domains: number
  sent: number
  replyRate: number
  replyRateNoOoo: number
  leadRate: number
  rtl: number
  bounceRate: number
  replied: number
  leads: number
  bounced: number
}

interface Payload {
  gateways: Gateway[]
  coverage: { resolved: number; total: number }
}

// Heat a cell green→red based on where the value sits in the column's range.
// `invert` for metrics where lower is better (bounce).
function heat(value: number, min: number, max: number, invert = false) {
  if (max === min) return ''
  let t = (value - min) / (max - min)
  if (invert) t = 1 - t
  if (t >= 0.66) return 'text-green-700 font-semibold'
  if (t >= 0.33) return 'text-amber-600'
  return 'text-red-600'
}

const MIN_SENT = 100 // hide long-tail gateways with too little volume to trust

export default function GatewayAnalysisPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/gateway-analysis')
      .then((r) => r.json())
      .then((d) => setData(d?.gateways ? d : null))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const all = data?.gateways ?? []
  const rows = all.filter((g) => g.sent >= MIN_SENT)
  const hidden = all.length - rows.length

  // column ranges for heat-mapping (only over the shown rows)
  const range = (sel: (g: Gateway) => number) => {
    const v = rows.map(sel)
    return { min: Math.min(...v), max: Math.max(...v) }
  }
  const rReply = range((g) => g.replyRateNoOoo)
  const rRtl = range((g) => g.rtl)
  const rBounce = range((g) => g.bounceRate)

  const cov = data?.coverage
  const covPct = cov && cov.total ? (100 * cov.resolved) / cov.total : 0

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Gateway Deliverability</h1>
        <p className="text-sm text-gray-500">
          Reply / lead / bounce performance by inbound email gateway (Mimecast, Proofpoint, Google, …).
          {cov && (
            <span className={covPct < 95 ? 'text-amber-600' : ''}>
              {' '}MX resolved for {cov.resolved.toLocaleString()} / {cov.total.toLocaleString()} domains ({covPct.toFixed(0)}%).
            </span>
          )}
        </p>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Gateway</TableHead>
                <TableHead className="text-right">Domains</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Reply %</TableHead>
                <TableHead className="text-right">Reply % (no OOO)</TableHead>
                <TableHead className="text-right">Lead %</TableHead>
                <TableHead className="text-right">RTL</TableHead>
                <TableHead className="text-right">Bounce %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 8 }).map((_, j) => (
                      <TableCell key={j}>
                        <div className="h-4 bg-gray-100 rounded animate-pulse" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12 text-gray-500">
                    No gateway data yet — run the MX resolution sweep.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((g) => (
                  <TableRow key={g.gateway} className="hover:bg-gray-50">
                    <TableCell className="font-medium">{g.gateway}</TableCell>
                    <TableCell className="text-right text-sm text-gray-500">{g.domains.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-sm">{g.sent.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-sm text-gray-600">{g.replyRate.toFixed(2)}</TableCell>
                    <TableCell className={`text-right text-sm ${heat(g.replyRateNoOoo, rReply.min, rReply.max)}`}>
                      {g.replyRateNoOoo.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right text-sm text-gray-600">{g.leadRate.toFixed(2)}</TableCell>
                    <TableCell className={`text-right text-sm ${heat(g.rtl, rRtl.min, rRtl.max)}`}>
                      {g.rtl.toFixed(1)}
                    </TableCell>
                    <TableCell className={`text-right text-sm ${heat(g.bounceRate, rBounce.min, rBounce.max, true)}`}>
                      {g.bounceRate.toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-gray-500 mt-3 max-w-3xl">
          Reply % = any reply / sent. Reply % (no OOO) = replies excluding out-of-office &amp; automatic replies — the
          truer engagement signal. Lead % = positive leads / sent. RTL = leads per 1,000 sent. Bounce % = bounced /
          sent (lower is better). Gateways with under {MIN_SENT} sends are hidden{hidden > 0 ? ` (${hidden} hidden)` : ''}.
          Green = best in column, red = worst.
        </p>
      </div>
    </div>
  )
}
