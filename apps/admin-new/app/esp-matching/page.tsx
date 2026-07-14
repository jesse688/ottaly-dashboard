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
    fetch('/api/data/combo-analysis/workspaces')
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

  const authHeaders = useCallback(
    () => ({ Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json' }),
    [token],
  )

  function buildPayload() {
    const cap = Number(dailyCap) || 0
    const esp_setting: EspSettingEntry[] = RECIPIENTS.map((r) => ({
      recipient_esp: r.recipient_esp,
      sender_esp: Array.from(picks[r.key]),
      tag_ids: '',
    }))
    return { esp_setting, is_max_lead_domain_per_day: cap > 0 ? 1 : 0, max_lead_domain_per_day: cap }
  }

  async function showCurrent() {
    if (!token.trim()) return addLog('Paste a token first.', 'err')
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
    if (!token.trim()) return addLog('Paste a token first.', 'err')
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
      <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
        <label className="mb-1 block text-xs font-medium text-gray-500">PlusVibe Bearer token (JWT)</label>
        <textarea
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="eyJhbGci…"
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
            DevTools → Network → any api.pipl.ai request → Authorization: Bearer … (token expires in hours)
          </span>
        </div>
      </div>

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
    </div>
  )
}
