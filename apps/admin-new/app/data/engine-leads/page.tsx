'use client'

import { useCallback, useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface EngineLead {
  domain: string
  company_name: string | null
  email_primary: string | null
  director_name: string | null
  industry: string | null
  region: string | null
  company_size: string | null
  platform: string | null
  has_products: boolean | null
  product_count: number | null
  page_count: number | null
  postcode: string | null
  linkedin_url: string | null
  promoted_at: string | null
}

interface EngineLeadsResponse {
  total: number
  limit: number
  offset: number
  count: number
  leads: EngineLead[]
}

const PAGE_SIZE = 50

interface Filters {
  search: string
  industry: string
  region: string
  platform: string
  has_products: string
}

const EMPTY_FILTERS: Filters = { search: '', industry: '', region: '', platform: '', has_products: 'any' }

function buildQuery(f: Filters, extra: Record<string, string> = {}) {
  const p = new URLSearchParams()
  if (f.search) p.set('search', f.search)
  if (f.industry) p.set('industry', f.industry)
  if (f.region) p.set('region', f.region)
  if (f.platform) p.set('platform', f.platform)
  if (f.has_products !== 'any') p.set('has_products', f.has_products)
  for (const [k, v] of Object.entries(extra)) p.set(k, v)
  return p.toString()
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  try {
    return new Date(d).toISOString().slice(0, 10)
  } catch {
    return d
  }
}

export default function EngineLeadsPage() {
  // Draft filters bound to inputs; applied filters drive the fetch.
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS)
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<EngineLeadsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = buildQuery(applied, { limit: String(PAGE_SIZE), offset: String(offset) })
      const res = await fetch(`/api/data/engine-leads?${qs}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      setData(await res.json())
    } catch (e) {
      setData(null)
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [applied, offset])

  useEffect(() => {
    load()
  }, [load])

  const apply = () => {
    setOffset(0)
    setApplied(draft)
  }
  const reset = () => {
    setDraft(EMPTY_FILTERS)
    setOffset(0)
    setApplied(EMPTY_FILTERS)
  }
  const exportCsv = () => {
    window.location.href = `/api/data/engine-leads/export?${buildQuery(applied)}`
  }

  const total = data?.total ?? 0
  const leads = data?.leads ?? []
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(offset + PAGE_SIZE, total)

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Engine Leads</h1>
        <p className="text-sm text-gray-500">
          Clean B2B leads promoted by the autonomous data engine — read-only
        </p>
      </div>

      <div className="bg-white border-b px-6 py-3 flex items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-gray-500 uppercase tracking-wide">Search</Label>
          <Input
            className="w-56"
            placeholder="domain or company…"
            value={draft.search}
            onChange={(e) => setDraft({ ...draft, search: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-gray-500 uppercase tracking-wide">Industry</Label>
          <Input
            className="w-40"
            placeholder="e.g. dental"
            value={draft.industry}
            onChange={(e) => setDraft({ ...draft, industry: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-gray-500 uppercase tracking-wide">Region</Label>
          <Input
            className="w-40"
            placeholder="e.g. London"
            value={draft.region}
            onChange={(e) => setDraft({ ...draft, region: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-gray-500 uppercase tracking-wide">Platform</Label>
          <Input
            className="w-40"
            placeholder="e.g. shopify"
            value={draft.platform}
            onChange={(e) => setDraft({ ...draft, platform: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-gray-500 uppercase tracking-wide">Has Products</Label>
          <Select value={draft.has_products ?? 'any'} onValueChange={(v) => setDraft({ ...draft, has_products: v ?? 'any' })}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="true">Yes</SelectItem>
              <SelectItem value="false">No</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={apply}>Apply</Button>
        <Button variant="outline" onClick={reset}>
          Reset
        </Button>
        <div className="flex-1" />
        <Button variant="outline" onClick={exportCsv}>
          Export CSV
        </Button>
      </div>

      <div className="bg-white border-b px-6 py-2 text-sm text-gray-500">
        {loading ? (
          'Loading…'
        ) : (
          <>
            <strong className="text-gray-900">{total.toLocaleString()}</strong> lead{total === 1 ? '' : 's'} match
          </>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="bg-white rounded-lg border overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Director</TableHead>
                <TableHead>Industry</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Products</TableHead>
                <TableHead>Pages</TableHead>
                <TableHead>Postcode</TableHead>
                <TableHead>LinkedIn</TableHead>
                <TableHead>Promoted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 13 }).map((_, j) => (
                      <TableCell key={j}>
                        <div className="h-4 bg-gray-100 rounded animate-pulse" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : error ? (
                <TableRow>
                  <TableCell colSpan={13} className="text-center py-12 text-red-600">
                    Error: {error}
                  </TableCell>
                </TableRow>
              ) : leads.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={13} className="text-center py-12 text-gray-500">
                    No leads match these filters.
                  </TableCell>
                </TableRow>
              ) : (
                leads.map((l, i) => (
                  <TableRow key={`${l.domain}-${i}`} className="hover:bg-gray-50">
                    <TableCell className="text-sm">
                      <a
                        href={`https://${l.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {l.domain}
                      </a>
                    </TableCell>
                    <TableCell className="text-sm text-gray-600 max-w-[220px] truncate">
                      {l.company_name ?? '—'}
                    </TableCell>
                    <TableCell className="text-sm">
                      {l.email_primary ? (
                        <a href={`mailto:${l.email_primary}`} className="text-blue-600 hover:underline">
                          {l.email_primary}
                        </a>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-gray-600">{l.director_name ?? '—'}</TableCell>
                    <TableCell className="text-sm text-gray-600">{l.industry ?? '—'}</TableCell>
                    <TableCell className="text-sm text-gray-600">{l.region ?? '—'}</TableCell>
                    <TableCell className="text-sm text-gray-600">{l.company_size ?? '—'}</TableCell>
                    <TableCell className="text-sm text-gray-600">{l.platform ?? '—'}</TableCell>
                    <TableCell>
                      {l.has_products ? (
                        <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-green-100 text-green-800">
                          {l.product_count ?? 0}
                        </span>
                      ) : (
                        <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-gray-100 text-gray-500">
                          no
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-gray-600">{l.page_count ?? '—'}</TableCell>
                    <TableCell className="text-sm text-gray-600">{l.postcode ?? '—'}</TableCell>
                    <TableCell className="text-sm">
                      {l.linkedin_url ? (
                        <a
                          href={l.linkedin_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          view
                        </a>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-gray-500">{fmtDate(l.promoted_at)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-center gap-4 mt-4 text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={offset <= 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          >
            ← Prev
          </Button>
          <span className="text-gray-500">
            {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            Next →
          </Button>
        </div>
      </div>
    </div>
  )
}
