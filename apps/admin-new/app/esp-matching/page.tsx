'use client'

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

// ── ESP Matching Manager ─────────────────────────────────────────────────────
// Bulk-set PlusVibe "Advanced ESP Matching" (recipient provider → allowed sender
// provider(s)) for one workspace or all. These endpoints are internal-only
// (api.pipl.ai), so the browser sends a short-lived Bearer JWT (pasted below)
// which the /api/data/esp-matching/setting proxy forwards to pipl.ai.

interface Workspace { id: string; name: string }

const SENDER_OPTIONS = [
  { label: 'Google Workspace', value: 'GOOGLE_WORKSPACE' },
  { label: 'Microsoft 365', value: 'MICROSOFT365' },
  { label: 'Other ESPs', value: 'REGULAR_ACCOUNT' },
] as const

const RECIPIENTS = [
  { key: 'google', recipient_esp: 'GOOGLE_WORKSPACE', label: 'Google Recipient Accounts' },
  { key: 'microsoft', recipient_esp: 'MICROSOFT365', label: 'Microsoft Recipient Accounts' },
  { key: 'other', recipient_esp: 'REGULAR_ACCOUNT', label: 'Other Recipient Provider Accounts' },
] as const

type RowKey = (typeof RECIPIENTS)[number]['key']

interface EspSettingEntry {
  recipient_esp: string
  sender_esp: string[]
  tag_ids: string
}

export default function EspMatchingPage() {
  const [token, setToken] = useState('')
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [mode, setMode] = useState<'single' | 'all'>('single')
  const [wsId, setWsId] = useState('')
  // per recipient row → set of ticked sender values (empty = Skip)
  const [picks, setPicks] = useState<Record<RowKey, Set<string>>>({
    google: new Set(),
    microsoft: new Set(),
    other: new Set(),
  })
  const [dailyCap, setDailyCap] = useState('0')
  const [log, setLog] = useState<Array<{ msg: string; kind: 'ok' | 'err' | 'info' }>>([
    { msg: 'Paste your PlusVibe Bearer token, then load a workspace.', kind: 'info' },
  ])
  const [busy, setBusy] = useState(false)

  const addLog = (msg: string, kind: 'ok' | 'err' | 'info' = 'info') =>
    setLog((l) => [...l, { msg, kind }])

  // Load workspace list (reuses the combo-analysis dropdown source).
  useEffect(() => {
    fetch('/api/data/esp-matching/workspaces')
      .then((r) => r.json())
      .then((d: { workspaces?: Workspace[] }) => {
        const ws = d.workspaces ?? []
        setWorkspaces(ws)
        if (ws.length && !wsId) setWsId(ws[0].id)
      })
      .catch(() => addLog('Could not load workspace list.', 'err'))
    // restore token from localStorage
    try {
      const t = localStorage.getItem('pv_token')
      if (t) setToken(t)
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function togglePick(row: RowKey, value: string) {
    setPicks((prev) => {
      const next = { ...prev, [row]: new Set(prev[row]) }
      if (value === 'SKIP') {
        next[row] = new Set() // Skip clears all
      } else {
        if (next[row].has(value)) next[row].delete(value)
        else next[row].add(value)
      }
      return next
    })
  }

  // Token is OPTIONAL now: the server logs in with its own creds. Only send an
  // Authorization header if the user pasted a token to override.
  const authHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token.trim()) h.Authorization = `Bearer ${token.trim()}`
    return h
  }, [token])

  function buildPayload() {
    const cap = Number(dailyCap) || 0
    const esp_setting: EspSettingEntry[] = RECIPIENTS.map((r) => ({
      recipient_esp: r.recipient_esp,
      sender_esp: Array.from(picks[r.key]),
      tag_ids: '',
    }))
    // PlusVibe rejects max_lead_domain_per_day when it's < 1 ("must be a number
    // greater than 0" → HTTP 500). Only include it when the cap is enabled.
    const payload: Record<string, unknown> = {
      esp_setting,
      is_max_lead_domain_per_day: cap >= 1 ? 1 : 0,
    }
    if (cap >= 1) payload.max_lead_domain_per_day = cap
    return payload
  }

  async function showCurrent() {
    if (!wsId) return addLog('Pick a workspace.', 'err')
    const ws = workspaces.find((w) => w.id === wsId)
    addLog(`Reading ${ws?.name ?? wsId}…`)
    try {
      const res = await fetch(`/api/data/esp-matching/setting?workspace_id=${wsId}`, {
        headers: authHeaders(),
      })
      const data = await res.json()
      if (!res.ok) return addLog(`Read failed (HTTP ${res.status}). ${res.status === 401 ? 'Token expired?' : ''}`, 'err')
      const esp = data?.esp_setting ? data : data?.data?.esp_setting ? data.data : data?.data || data
      const list: EspSettingEntry[] = esp?.esp_setting || []
      const byRec: Record<string, string[]> = {}
      list.forEach((s) => (byRec[s.recipient_esp] = s.sender_esp || []))
      setPicks({
        google: new Set(byRec['GOOGLE_WORKSPACE'] || []),
        microsoft: new Set(byRec['MICROSOFT365'] || []),
        other: new Set(byRec['REGULAR_ACCOUNT'] || []),
      })
      const cap = esp?.max_lead_domain_per_day ?? (esp?.is_max_lead_domain_per_day ? 1 : 0)
      setDailyCap(String(cap))
      list.forEach((s) =>
        addLog(`  ${s.recipient_esp} → ${s.sender_esp?.length ? s.sender_esp.join('+') : 'SKIP'}`, 'info'),
      )
      addLog('Checkboxes updated to match this workspace.', 'ok')
    } catch (e) {
      addLog(`Error: ${e instanceof Error ? e.message : 'unknown'}`, 'err')
    }
  }

  async function applyOne(id: string, name: string, payload: object) {
    try {
      const res = await fetch(`/api/data/esp-matching/setting?workspace_id=${id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        addLog(`✓ ${name}`, 'ok')
        return true
      }
      addLog(`✗ ${name} — HTTP ${res.status}`, 'err')
      return false
    } catch (e) {
      addLog(`✗ ${name} — ${e instanceof Error ? e.message : 'error'}`, 'err')
      return false
    }
  }

  async function apply() {
    const payload = buildPayload()
    addLog(`Payload: ${JSON.stringify(payload)}`, 'info')
    setBusy(true)
    try {
      if (mode === 'single') {
        if (!wsId) return addLog('Pick a workspace.', 'err')
        const ws = workspaces.find((w) => w.id === wsId)
        await applyOne(wsId, ws?.name ?? wsId, payload)
      } else {
        if (!confirm(`Apply this mapping to ALL ${workspaces.length} workspaces?`)) return
        addLog(`Applying to ${workspaces.length} workspaces…`)
        let ok = 0,
          fail = 0
        for (const w of workspaces) {
          // eslint-disable-next-line no-await-in-loop
          const r = await applyOne(w.id, w.name, payload)
          r ? ok++ : fail++
        }
        addLog(`Done. ${ok} ok, ${fail} failed.`, fail ? 'err' : 'ok')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-6">
      <div className="mb-4">
        <div className="text-xl font-bold text-gray-900">ESP Matching</div>
        <div className="mt-0.5 text-xs text-gray-500">
          Set which sender provider(s) send to each recipient provider — one workspace or all at once.
        </div>
      </div>

      {/* Auth */}
      <details className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
        <summary className="cursor-pointer text-xs font-medium text-gray-500">
          Auth: automatic (server login) — click to override with your own token
        </summary>
        <div className="mt-3">
          <label className="mb-1 block text-xs font-medium text-gray-500">PlusVibe Bearer token (JWT) — optional override</label>
          <textarea
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Leave blank to use the server's login"
            className="h-16 w-full rounded-md border border-gray-200 p-2 font-mono text-xs"
          />
          <div className="mt-1 flex items-center gap-3">
            <button
              className="rounded-md border border-gray-200 px-2.5 py-1 text-xs hover:bg-gray-50"
              onClick={() => {
                try {
                  localStorage.setItem('pv_token', token.trim())
                  addLog('Token saved in this browser.', 'ok')
                } catch {}
              }}
            >
              Remember on this device
            </button>
            <span className="text-[11px] text-gray-400">
              Normally not needed — the server authenticates itself. Paste a token only to act as a different account.
            </span>
          </div>
        </div>
      </details>

      {/* Target */}
      <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3 flex gap-2">
          {(['single', 'all'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium',
                mode === m ? 'bg-gray-900 text-white' : 'border border-gray-200 bg-white text-gray-700',
              )}
            >
              {m === 'single' ? 'Single workspace' : 'All workspaces'}
            </button>
          ))}
        </div>
        {mode === 'single' ? (
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={wsId}
              onChange={(e) => setWsId(e.target.value)}
              className="rounded-md border border-gray-200 px-2.5 py-1.5 text-sm"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <button
              onClick={showCurrent}
              className="rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              Show current settings
            </button>
          </div>
        ) : (
          <div className="text-xs text-amber-700">
            ⚠ This writes the SAME mapping to every workspace ({workspaces.length}).
          </div>
        )}
      </div>

      {/* Mapping */}
      <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3 text-[13px] font-bold text-gray-900">Mapping</div>
        <div className="space-y-3">
          {RECIPIENTS.map((r) => {
            const set = picks[r.key]
            const skip = set.size === 0
            return (
              <div key={r.key} className="flex flex-wrap items-center gap-2">
                <div className="w-56 text-sm text-gray-800">
                  {r.label}
                  <div className="text-[11px] text-gray-400">{r.recipient_esp}</div>
                </div>
                {SENDER_OPTIONS.map((o) => (
                  <label
                    key={o.value}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs',
                      set.has(o.value) ? 'border-gray-900 bg-gray-50' : 'border-gray-200',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={set.has(o.value)}
                      onChange={() => togglePick(r.key, o.value)}
                    />
                    {o.label}
                  </label>
                ))}
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs',
                    skip ? 'border-amber-500 bg-amber-50 text-amber-700' : 'border-gray-200 text-amber-700',
                  )}
                >
                  <input type="checkbox" checked={skip} onChange={() => togglePick(r.key, 'SKIP')} />
                  Skip
                </label>
              </div>
            )
          })}
        </div>
        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-gray-500">Daily cap per recipient domain</label>
          <input
            value={dailyCap}
            onChange={(e) => setDailyCap(e.target.value)}
            className="w-40 rounded-md border border-gray-200 px-2.5 py-1.5 text-sm"
          />
          <span className="ml-2 text-[11px] text-gray-400">0 = unlimited</span>
        </div>
      </div>

      {/* Apply */}
      <div className="mb-4 flex gap-2">
        <button
          onClick={apply}
          disabled={busy}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Applying…' : 'Apply mapping'}
        </button>
        <button
          onClick={() => setLog([])}
          className="rounded-md border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50"
        >
          Clear log
        </button>
      </div>

      {/* Log */}
      <div className="rounded-xl border border-gray-200 bg-[#0b0d11] p-3 font-mono text-xs">
        {log.map((l, i) => (
          <div
            key={i}
            className={cn(
              l.kind === 'ok' ? 'text-green-400' : l.kind === 'err' ? 'text-red-400' : 'text-gray-400',
            )}
          >
            {l.msg}
          </div>
        ))}
      </div>

      {/* Inboxing Test */}
      <InboxTest token={token} workspaces={workspaces} selectedWsId={wsId} />
    </div>
  )
}

// ── Inboxing Test panel ──────────────────────────────────────────────────────
// Flip a workspace to BROAD, wait a window, measure each combo's OOO/auto-reply
// rate (fast inboxing signal), then auto-flip to the best sender per recipient.
const ESP_LABEL: Record<string, string> = {
  GOOGLE_WORKSPACE: 'Google',
  MICROSOFT365: 'Microsoft',
  REGULAR_ACCOUNT: 'Other',
}

interface RecRow { recp_provider: string; winner: string | null; ooo_rate: number; sent: number; confident: boolean }
interface ComboRow { provider: string; recp_provider: string; sent: number; ooo: number; bounces: number; ooo_rate: number }
interface TestRow {
  id: string
  workspace_id: string
  workspace_name: string | null
  status: 'running' | 'done' | 'error'
  started_at: number
  ends_at: number
  window_hours: number
  result: { combos: ComboRow[]; recommendations: RecRow[] } | null
  error: string | null
}

function InboxTest({
  token,
  workspaces,
  selectedWsId,
}: {
  token: string
  workspaces: Workspace[]
  selectedWsId: string
}) {
  const [tests, setTests] = useState<TestRow[]>([])
  const [windowHours, setWindowHours] = useState('1')
  const [scope, setScope] = useState<'single' | 'all'>('single')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await fetch('/api/data/esp-matching/inbox-test').then((x) => x.json()).catch(() => ({ tests: [] }))
    setTests(r.tests ?? [])
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30000) // refresh running-test status
    return () => clearInterval(t)
  }, [load])

  async function post(body: object) {
    setBusy(true)
    setMsg(null)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`
      const r = await fetch('/api/data/esp-matching/inbox-test', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }).then((x) => x.json())
      if (r.error) setMsg(`Error: ${r.error}`)
      else if (typeof r.started !== 'undefined')
        setMsg(`Started ${r.started.length} test(s)${r.failed?.length ? `, ${r.failed.length} failed` : ''}.`)
      else if (r.ok) setMsg('Done.')
      await load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'request failed')
    } finally {
      setBusy(false)
    }
  }

  function startTests() {
    const wss =
      scope === 'single'
        ? workspaces.filter((w) => w.id === selectedWsId)
        : workspaces
    if (!wss.length) return setMsg('No workspace selected.')
    if (scope === 'all' && !confirm(`Start an inboxing test on ALL ${wss.length} workspaces? Each is flipped to broad for ${windowHours}h.`))
      return
    post({ action: 'start', workspaces: wss.map((w) => ({ id: w.id, name: w.name })), window_hours: Number(windowHours) })
  }

  const running = tests.filter((t) => t.status === 'running')
  const errored = tests.filter((t) => t.status === 'error')

  return (
    <div className="mt-8">
      <div className="mb-2 text-lg font-bold text-gray-900">Inboxing Test</div>
      <div className="mb-3 text-xs text-gray-500">
        Flips a workspace to <b>send-to-all</b> for a window, measures each sender→recipient combo&apos;s
        out-of-office/auto-reply rate (a fast inboxing signal), then auto-sets the best sender per
        recipient. Recipients without enough signal stay on their prior setting (shown as &quot;inconclusive&quot;).
      </div>

      {/* Controls */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex rounded-md border border-gray-200 overflow-hidden">
          {(['single', 'all'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={cn('px-3 py-1.5 text-sm', scope === s ? 'bg-gray-900 text-white' : 'bg-white text-gray-700')}
            >
              {s === 'single' ? 'Selected workspace' : 'All workspaces'}
            </button>
          ))}
        </div>
        <label className="text-xs text-gray-500">Window (hours)</label>
        <input
          value={windowHours}
          onChange={(e) => setWindowHours(e.target.value)}
          className="w-20 rounded-md border border-gray-200 px-2 py-1.5 text-sm"
        />
        <button
          onClick={startTests}
          disabled={busy}
          className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Run test'}
        </button>
        <button
          onClick={() => post({ action: 'retest_inconclusive', window_hours: Number(windowHours) })}
          disabled={busy}
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
          title="Re-run only workspaces whose last test left a recipient inconclusive"
        >
          Retest inconclusive
        </button>
        {msg && <span className="text-xs text-gray-600">{msg}</span>}
      </div>

      {/* Stuck-on-broad alerts */}
      {errored.length > 0 && (
        <div className="mb-3 rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-800">
          ⚠ {errored.length} test(s) errored and may be <b>stuck on send-to-all</b> (token likely expired).
          Paste a fresh token above, then click Restore:
          <div className="mt-2 flex flex-col gap-1">
            {errored.map((t) => (
              <div key={t.id} className="flex items-center gap-2">
                <span>{t.workspace_name || t.workspace_id} — {t.error}</span>
                <button
                  onClick={() => post({ action: 'restore', id: t.id })}
                  className="rounded border border-red-400 px-2 py-0.5 text-red-700 hover:bg-red-100"
                >
                  Restore prior
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Running */}
      {running.length > 0 && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          {running.length} test(s) running (broad sending). Winners apply automatically when each window ends.
          {running.map((t) => (
            <div key={t.id}>
              {t.workspace_name || t.workspace_id} — ends {new Date(Number(t.ends_at)).toLocaleTimeString()}
            </div>
          ))}
        </div>
      )}

      {/* Results */}
      <div className="space-y-4">
        {tests
          .filter((t) => t.status === 'done' && t.result)
          .slice(0, 20)
          .map((t) => (
            <div key={t.id} className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="mb-2 flex items-baseline justify-between">
                <div className="text-sm font-semibold text-gray-900">{t.workspace_name || t.workspace_id}</div>
                <div className="text-[11px] text-gray-400">
                  {t.window_hours}h test · {new Date(Number(t.started_at)).toLocaleString()}
                </div>
              </div>
              {/* Recommendation per recipient */}
              <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(t.result?.recommendations ?? []).map((r) => (
                  <div key={r.recp_provider} className="rounded-lg border border-gray-200 p-2">
                    <div className="text-[11px] uppercase text-gray-500">To {ESP_LABEL[r.recp_provider]}</div>
                    {r.confident && r.winner ? (
                      <>
                        <div className="text-sm font-bold text-gray-900">Use {ESP_LABEL[r.winner]}</div>
                        <div className="text-[11px] text-gray-500">
                          {(r.ooo_rate * 100).toFixed(1)}% OOO · {r.sent} sent
                        </div>
                      </>
                    ) : (
                      <div className="text-sm font-medium text-amber-600">
                        Inconclusive
                        <div className="text-[11px] font-normal text-gray-400">only {r.sent} sent — retest longer</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {/* Per-combo detail */}
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase text-gray-400">
                      <th className="py-1">Sender → Recipient</th>
                      <th className="py-1 text-right">Sent</th>
                      <th className="py-1 text-right">OOO/Auto</th>
                      <th className="py-1 text-right">OOO Rate</th>
                      <th className="py-1 text-right">Bounces</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(t.result?.combos ?? [])
                      .filter((c) => c.sent > 0)
                      .sort((a, b) => b.sent - a.sent)
                      .map((c) => (
                        <tr key={`${c.provider}-${c.recp_provider}`} className="border-t border-gray-100">
                          <td className="py-1">
                            {ESP_LABEL[c.provider]} → {ESP_LABEL[c.recp_provider]}
                          </td>
                          <td className="py-1 text-right">{c.sent}</td>
                          <td className="py-1 text-right">{c.ooo}</td>
                          <td className="py-1 text-right font-medium">{(c.ooo_rate * 100).toFixed(1)}%</td>
                          <td className="py-1 text-right text-gray-500">{c.bounces}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}
