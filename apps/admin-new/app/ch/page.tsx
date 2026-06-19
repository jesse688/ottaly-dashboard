'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { FieldPicker } from '@/components/field-picker'
import { DEFAULT_FIELD_KEYS } from '@/lib/enrich-fields'

interface Company {
  company_number: string
  company_name: string
  company_status: string | null
  sic_codes: string | null
  postcode: string | null
  website: string | null
  scraped_domain: string | null
  emails: string[] | null
  phones: string[] | null
  address: string | null
  business_type: string | null
  industry: string | null
  keywords: string[] | null
  description: string | null
  socials: Record<string, string> | null
  scrape_status: string | null
  scraped_at: string | null
}

interface Job {
  id: number
  label: string | null
  status: 'queued' | 'running' | 'done' | 'failed'
  total: number
  done: number
  ok: number
  failed: number
  error: string | null
  created_at: string
}

const SCRAPE_PILL: Record<string, string> = {
  ok: 'bg-green-100 text-green-700',
  no_contact: 'bg-yellow-100 text-yellow-800',
  error: 'bg-red-100 text-red-700',
}

function ScrapePill({ company }: { company: Company }) {
  if (!company.scrape_status) {
    return <span className="text-xs text-gray-400">not scraped</span>
  }
  const cls = SCRAPE_PILL[company.scrape_status] || 'bg-gray-100 text-gray-700'
  const label = company.scrape_status === 'no_contact' ? 'no contact' : company.scrape_status
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold uppercase ${cls}`}>{label}</span>
}

export default function ChPage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(300)
  const [loading, setLoading] = useState(true)

  const [q, setQ] = useState('')
  const [sic, setSic] = useState('')
  const [status, setStatus] = useState('')
  const [hasWebsite, setHasWebsite] = useState<'' | 'yes' | 'no'>('')
  const [scraped, setScraped] = useState<'' | 'yes' | 'no'>('')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [fields, setFields] = useState<string[]>(DEFAULT_FIELD_KEYS)
  const [activeJob, setActiveJob] = useState<Job | null>(null)
  const [toast, setToast] = useState('')

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  const filterParams = useCallback(() => {
    const p = new URLSearchParams()
    if (q.trim()) p.set('q', q.trim())
    if (sic.trim()) p.set('sic', sic.trim())
    if (status) p.set('status', status)
    if (hasWebsite) p.set('hasWebsite', hasWebsite)
    if (scraped) p.set('scraped', scraped)
    return p
  }, [q, sic, status, hasWebsite, scraped])

  const loadCompanies = useCallback(async () => {
    try {
      const res = await fetch('/api/ch/companies?' + filterParams().toString())
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Load failed')
      setCompanies(data.rows || [])
      setTotal(data.total || 0)
      setLimit(data.limit || 300)
    } catch (err) {
      showToast('Failed to load: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [filterParams])

  // Debounced reload whenever filters change.
  useEffect(() => {
    const t = setTimeout(loadCompanies, 350)
    return () => clearTimeout(t)
  }, [loadCompanies])

  // Poll the active job until it finishes, then refresh the table.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startPolling = useCallback((jobId: number) => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/ch/jobs')
        const data = await res.json()
        const job: Job | undefined = (data.rows || []).find((j: Job) => j.id === jobId)
        if (!job) return
        setActiveJob(job)
        if (job.status === 'done' || job.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          await loadCompanies()
          showToast(
            job.status === 'done'
              ? `Job #${job.id} finished — ${job.ok} with contacts, ${job.failed} failed`
              : `Job #${job.id} failed: ${job.error || 'unknown error'}`
          )
        }
      } catch {
        /* keep polling */
      }
    }, 5000)
  }, [loadCompanies])

  // Resume polling if a job is already running when the page loads.
  useEffect(() => {
    ;(async () => {
      const res = await fetch('/api/ch/jobs')
      const data = await res.json()
      const live: Job | undefined = (data.rows || []).find(
        (j: Job) => j.status === 'queued' || j.status === 'running'
      )
      if (live) {
        setActiveJob(live)
        startPolling(live.id)
      }
    })().catch(() => {})
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [startPolling])

  const toggle = (num: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(num)) next.delete(num)
      else next.add(num)
      return next
    })
  }
  const allVisibleSelected = companies.length > 0 && companies.every(c => selected.has(c.company_number))
  const toggleAllVisible = () => {
    setSelected(prev => {
      const next = new Set(prev)
      if (allVisibleSelected) companies.forEach(c => next.delete(c.company_number))
      else companies.forEach(c => next.add(c.company_number))
      return next
    })
  }

  const queueJob = async (body: object, optimisticTotal: number) => {
    try {
      const res = await fetch('/api/ch/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Queue failed')
      setActiveJob({
        id: data.jobId, label: null, status: 'queued',
        total: data.total ?? optimisticTotal, done: 0, ok: 0, failed: 0,
        error: null, created_at: new Date().toISOString(),
      })
      setSelected(new Set())
      startPolling(data.jobId)
      showToast(`Queued job #${data.jobId} — ${data.total} companies`)
    } catch (err) {
      showToast('Could not queue: ' + (err as Error).message)
    }
  }

  const scrapeSelected = () => {
    if (selected.size === 0) return
    queueJob(
      { mode: 'selected', companyNumbers: Array.from(selected), fields, label: `${selected.size} selected` },
      selected.size
    )
  }

  const scrapeAllFiltered = () => {
    const desc = total > limit ? `all ${total} companies matching the current filters` : `these ${total} companies`
    if (!confirm(`Queue a scrape job for ${desc}?\n\nThe worker discovers any missing domains, then scrapes each site for emails and phones.`)) return
    queueJob(
      {
        mode: 'filtered',
        filter: { q, sic, status, hasWebsite, scraped },
        fields,
        label: `filtered: ${total}`,
      },
      total
    )
  }

  const jobRunning = activeJob && (activeJob.status === 'queued' || activeJob.status === 'running')
  const pct = activeJob && activeJob.total > 0 ? Math.round((activeJob.done / activeJob.total) * 100) : 0

  const summary = {
    shown: companies.length,
    withContacts: companies.filter(c => (c.emails?.length || 0) > 0 || (c.phones?.length || 0) > 0).length,
    notScraped: companies.filter(c => !c.scrape_status).length,
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-8 py-6">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Companies House — Contact Scraper</h1>
            <p className="text-sm text-gray-600 mt-1">
              Filter CH businesses, then queue a scrape. The worker finds each company&apos;s website
              (discovering missing domains), and pulls emails &amp; phones into the database.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={scrapeSelected} disabled={selected.size === 0 || !!jobRunning}>
              Scrape selected ({selected.size})
            </Button>
            <Button size="sm" onClick={scrapeAllFiltered} disabled={total === 0 || !!jobRunning}>
              Scrape all filtered ({total})
            </Button>
          </div>
        </div>
      </div>

      {/* Active job banner */}
      {activeJob && (
        <div className="bg-white border-b px-8 py-4">
          <div className="max-w-7xl mx-auto">
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="font-semibold">
                Job #{activeJob.id} · {activeJob.status}
                {activeJob.label ? ` · ${activeJob.label}` : ''}
              </span>
              <span className="text-gray-600">
                {activeJob.done}/{activeJob.total} done · {activeJob.ok} with contacts · {activeJob.failed} failed
              </span>
            </div>
            <div className="h-2 w-full bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all ${activeJob.status === 'failed' ? 'bg-red-500' : 'bg-blue-600'}`}
                style={{ width: `${activeJob.status === 'done' ? 100 : pct}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Summary */}
      <div className="bg-white border-b px-8 py-4">
        <div className="max-w-7xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-gray-900">
            <div className="text-xs font-bold uppercase text-gray-600">Matching</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">{total}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-blue-500">
            <div className="text-xs font-bold uppercase text-gray-600">Shown</div>
            <div className="text-2xl font-bold text-blue-600 mt-1">{summary.shown}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-green-500">
            <div className="text-xs font-bold uppercase text-gray-600">With contacts</div>
            <div className="text-2xl font-bold text-green-600 mt-1">{summary.withContacts}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-yellow-500">
            <div className="text-xs font-bold uppercase text-gray-600">Not scraped</div>
            <div className="text-2xl font-bold text-yellow-600 mt-1">{summary.notScraped}</div>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="bg-white border-b px-8 py-4">
        <div className="max-w-7xl mx-auto flex items-center gap-3 flex-wrap">
          <input
            type="text"
            placeholder="Search name, number, website, postcode…"
            value={q}
            onChange={e => setQ(e.target.value)}
            className="flex-1 min-w-64 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:border-blue-500"
          />
          <input
            type="text"
            placeholder="SIC code (e.g. 86900)"
            value={sic}
            onChange={e => setSic(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm focus:outline-none focus:border-blue-500 w-44"
          />
          <select value={status} onChange={e => setStatus(e.target.value)} className="px-3 py-2 border rounded-lg text-sm min-w-36">
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="dissolved">Dissolved</option>
            <option value="liquidation">Liquidation</option>
          </select>
          <select value={hasWebsite} onChange={e => setHasWebsite(e.target.value as '' | 'yes' | 'no')} className="px-3 py-2 border rounded-lg text-sm min-w-40">
            <option value="">Website: any</option>
            <option value="yes">Has website</option>
            <option value="no">No website</option>
          </select>
          <select value={scraped} onChange={e => setScraped(e.target.value as '' | 'yes' | 'no')} className="px-3 py-2 border rounded-lg text-sm min-w-40">
            <option value="">Scraped: any</option>
            <option value="no">Not scraped yet</option>
            <option value="yes">Already scraped</option>
          </select>
        </div>
      </div>

      {/* What to extract */}
      <div className="bg-white border-b px-8 py-4">
        <div className="max-w-7xl mx-auto">
          <div className="text-xs font-bold uppercase tracking-wider text-gray-600 mb-2">What to extract when scraping</div>
          <FieldPicker value={fields} onChange={setFields} />
        </div>
      </div>

      {/* Table */}
      <div className="px-8 py-6">
        <div className="max-w-7xl mx-auto bg-white rounded-lg border overflow-x-auto">
          {companies.length === 0 ? (
            <div className="py-12 text-center text-gray-600">
              {loading ? 'Loading…' : 'No companies match these filters.'}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow className="bg-gray-50 hover:bg-gray-50">
                    <TableHead className="w-10">
                      <Checkbox checked={allVisibleSelected} onCheckedChange={toggleAllVisible} aria-label="Select all" />
                    </TableHead>
                    <TableHead className="text-xs font-bold uppercase">Company</TableHead>
                    <TableHead className="text-xs font-bold uppercase">Website / Domain</TableHead>
                    <TableHead className="text-xs font-bold uppercase">Emails</TableHead>
                    <TableHead className="text-xs font-bold uppercase">Phones</TableHead>
                    <TableHead className="text-xs font-bold uppercase">Type</TableHead>
                    <TableHead className="text-xs font-bold uppercase">Industry</TableHead>
                    <TableHead className="text-xs font-bold uppercase">Scrape</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {companies.map(c => {
                    const domain = c.scraped_domain || c.website
                    return (
                      <TableRow key={c.company_number} className="hover:bg-blue-50">
                        <TableCell>
                          <Checkbox
                            checked={selected.has(c.company_number)}
                            onCheckedChange={() => toggle(c.company_number)}
                            aria-label={`Select ${c.company_name}`}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="font-semibold">{c.company_name}</div>
                          <div className="text-xs text-gray-500">
                            {c.company_number}{c.postcode ? ` · ${c.postcode}` : ''}{c.company_status ? ` · ${c.company_status}` : ''}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {domain ? (
                            <span className={c.website ? 'text-gray-900' : 'text-blue-700'}>
                              {domain}{!c.website && c.scraped_domain ? ' (found)' : ''}
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {c.emails && c.emails.length > 0 ? (
                            <span title={c.emails.join(', ')}>
                              <span className="font-semibold">{c.emails[0]}</span>
                              {c.emails.length > 1 ? <span className="text-gray-500"> +{c.emails.length - 1}</span> : null}
                            </span>
                          ) : <span className="text-gray-400">—</span>}
                        </TableCell>
                        <TableCell className="text-sm">
                          {c.phones && c.phones.length > 0 ? (
                            <span title={c.phones.join(', ')}>
                              {c.phones[0]}
                              {c.phones.length > 1 ? <span className="text-gray-500"> +{c.phones.length - 1}</span> : null}
                            </span>
                          ) : <span className="text-gray-400">—</span>}
                        </TableCell>
                        <TableCell className="text-sm">{c.business_type || <span className="text-gray-400">—</span>}</TableCell>
                        <TableCell className="text-sm">{c.industry || <span className="text-gray-400">—</span>}</TableCell>
                        <TableCell><ScrapePill company={c} /></TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              {total > companies.length && (
                <div className="px-4 py-3 text-xs text-gray-500 border-t bg-gray-50">
                  Showing {companies.length} of {total} — narrow filters to see more, or use “Scrape all filtered” to queue the whole set.
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-6 right-6 bg-gray-900 text-white px-4 py-3 rounded-lg text-sm font-medium shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
