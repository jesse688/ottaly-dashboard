'use client'

import { useCallback, useEffect, useState } from 'react'

type Followup = {
  id: string
  source_reply_id: string
  client_id: string | null
  client_name: string | null
  lead_email: string
  action_type: 'recontact_on' | 'referral' | 'send_info' | 'call' | 'none'
  reason: string | null
  due_at: string | null
  target_name: string | null
  target_email: string | null
  draft_subject: string | null
  draft_body: string | null
  confidence: string | null
  status: string
  status_note: string | null
  reply_subject: string | null
  reply_preview: string | null
  reply_received_at: string | null
  from_mailbox: string | null
  sent_at: string | null
}

const ACTION_LABEL: Record<Followup['action_type'], string> = {
  recontact_on: 'Email again later',
  referral: 'Speak to someone else',
  send_info: 'Send info',
  call: 'Call them',
  none: 'No action',
}
const ACTION_COLOUR: Record<Followup['action_type'], string> = {
  recontact_on: 'bg-blue-50 text-blue-700',
  referral: 'bg-purple-50 text-purple-700',
  send_info: 'bg-green-50 text-green-700',
  call: 'bg-amber-50 text-amber-700',
  none: 'bg-gray-100 text-gray-600',
}

function fmt(d: string | null) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function AdminFollowupsClient() {
  const [view, setView] = useState<'due' | 'upcoming' | 'done'>('due')
  const [rows, setRows] = useState<Followup[] | null>(null)
  const [counts, setCounts] = useState<{ due: string; upcoming: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [edits, setEdits] = useState<Record<string, Partial<Followup>>>({})

  const load = useCallback(async () => {
    setRows(null)
    const r = await fetch(`/api/admin/followups?view=${view}`)
    const d = await r.json()
    if (r.ok) { setRows(d.rows); setCounts(d.counts) } else setRows([])
  }, [view])
  useEffect(() => { load() }, [load])

  const field = (f: Followup, k: keyof Followup) => (edits[f.id]?.[k] ?? f[k] ?? '') as string
  const edit = (id: string, k: keyof Followup, v: string) => setEdits(e => ({ ...e, [id]: { ...e[id], [k]: v } }))

  async function save(f: Followup) {
    const e = edits[f.id]
    if (!e) return true
    const r = await fetch('/api/admin/followups', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: f.id, ...e }),
    })
    const d = await r.json()
    if (!r.ok) { setMsg(m => ({ ...m, [f.id]: d.error ?? 'Save failed' })); return false }
    setEdits(x => { const y = { ...x }; delete y[f.id]; return y })
    setRows(rs => rs?.map(x => x.id === f.id ? { ...x, ...d } : x) ?? rs)
    return true
  }

  async function send(f: Followup) {
    setBusy(f.id)
    if (!await save(f)) { setBusy(null); return }
    const r = await fetch(`/api/admin/followups/${f.id}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved_by: 'admin' }),
    })
    const d = await r.json()
    setBusy(null)
    if (r.ok) { setMsg(m => ({ ...m, [f.id]: `Sent to ${d.to} from ${d.from}` })); setTimeout(load, 900) }
    else setMsg(m => ({ ...m, [f.id]: d.reason ?? d.error ?? 'Send failed' }))
  }

  async function setStatus(f: Followup, status: 'dismissed' | 'done') {
    setBusy(f.id)
    await fetch('/api/admin/followups', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: f.id, status }),
    })
    setBusy(null)
    setRows(rs => rs?.filter(x => x.id !== f.id) ?? rs)
  }

  // A follow-up turned into a real lead: bill it via the normal Unibox
  // mark-as-lead (same path Jamie uses there), then close the card.
  async function markLead(f: Followup) {
    if (!confirm(`Mark ${f.lead_email} as a lead for ${f.client_name ?? 'this client'}? This bills the client.`)) return
    setBusy(f.id)
    const r = await fetch(`/api/admin/unibox/${f.source_reply_id}/mark-as-lead`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(f.client_id ? { clientId: f.client_id } : {}),
    })
    const d = await r.json().catch(() => ({})) as { ok?: boolean; already?: boolean; error?: string }
    if (!r.ok || !d.ok) { setBusy(null); setMsg(m => ({ ...m, [f.id]: d.error ?? 'Mark as lead failed' })); return }
    await fetch('/api/admin/followups', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: f.id, status: 'lead', status_note: d.already ? 'already a lead' : 'marked as lead from follow-ups' }),
    })
    setBusy(null)
    setRows(rs => rs?.filter(x => x.id !== f.id) ?? rs)
  }

  async function pushBack(f: Followup, days: number) {
    const d = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
    setBusy(f.id)
    await fetch('/api/admin/followups', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: f.id, due_at: d }),
    })
    setBusy(null)
    setRows(rs => rs?.filter(x => x.id !== f.id) ?? rs)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-slate-900 text-white px-6 py-3 flex items-center gap-4">
        <a href="/admin/clients" className="text-slate-300 hover:text-white text-sm">← Portal Admin</a>
        <span className="font-semibold">Follow-ups</span>
        <a href="/admin/unibox" className="ml-auto text-slate-400 hover:text-white text-xs">Unibox</a>
      </div>

      <div className="border-b border-gray-200 bg-white px-6">
        <nav className="flex -mb-px">
          {([
            { key: 'due', label: 'Due now', badge: counts?.due },
            { key: 'upcoming', label: 'Upcoming', badge: counts?.upcoming },
            { key: 'done', label: 'Done' },
          ] as { key: 'due' | 'upcoming' | 'done'; label: string; badge?: string }[]).map(t => (
            <button key={t.key} onClick={() => setView(t.key)}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 ${view === t.key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {t.label}
              {t.badge !== undefined && <span className="px-1.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">{t.badge}</span>}
            </button>
          ))}
        </nav>
      </div>

      <div className="max-w-4xl mx-auto p-3 sm:p-6 space-y-4">
        <p className="text-sm text-gray-500">
          Replies you marked as FW in the Unibox. Billable leads are left out automatically.
          Check the draft, edit if needed, then send. It goes from the client&apos;s own mailbox.
        </p>
        {rows === null && <p className="text-sm text-gray-400">Loading…</p>}
        {rows?.length === 0 && <p className="text-sm text-gray-400">Nothing here.</p>}
        {rows?.map(f => {
          const isRef = f.action_type === 'referral'
          const open = f.status === 'new' || f.status === 'needs_email'
          return (
            <div key={f.id} className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-gray-900">{f.client_name ?? '—'}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ACTION_COLOUR[f.action_type]}`}>{ACTION_LABEL[f.action_type]}</span>
                {f.due_at && <span className="text-xs text-gray-500">Due {fmt(f.due_at)}</span>}
                {f.status !== 'new' && <span className="text-xs text-gray-500">· {f.status}{f.status_note ? `: ${f.status_note}` : ''}</span>}
                <span className="ml-auto text-xs text-gray-400">Replied {fmt(f.reply_received_at)}</span>
              </div>
              {f.reason && <p className="text-sm text-gray-800"><span className="text-gray-500">They said:</span> {f.reason}</p>}

              <details className="text-sm">
                <summary className="cursor-pointer text-gray-500">Their reply from {f.lead_email}</summary>
                <div className="mt-2 whitespace-pre-wrap text-gray-700 bg-gray-50 rounded-lg p-3 text-xs max-h-64 overflow-auto">
                  {f.reply_subject ? `Subject: ${f.reply_subject}\n\n` : ''}{f.reply_preview}
                </div>
              </details>

              {isRef && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className="text-xs text-gray-500">Send to (name)
                    <input className="mt-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-900" value={field(f, 'target_name')}
                      onChange={e => edit(f.id, 'target_name', e.target.value)} disabled={!open} />
                  </label>
                  <label className="text-xs text-gray-500">Send to (email){f.status === 'needs_email' && <span className="text-amber-600"> — needed</span>}
                    <input className="mt-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-900" value={field(f, 'target_email')}
                      placeholder="name@company.co.uk" onChange={e => edit(f.id, 'target_email', e.target.value)} disabled={!open} />
                  </label>
                </div>
              )}

              <div className="space-y-2">
                <div className="text-xs text-gray-500">
                  From {f.from_mailbox ?? <span className="text-red-600">no client mailbox found</span>} → {isRef ? (field(f, 'target_email') || '…') : f.lead_email}
                  {isRef ? ' · new email, earlier thread attached below' : ' · reply in the same thread'}
                </div>
                <input className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-900" value={field(f, 'draft_subject')}
                  onChange={e => edit(f.id, 'draft_subject', e.target.value)} disabled={!open} placeholder="Subject" />
                <textarea className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-900 min-h-[140px]" value={field(f, 'draft_body')}
                  onChange={e => edit(f.id, 'draft_body', e.target.value)} disabled={!open} />
              </div>

              {open && (
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => send(f)} disabled={busy === f.id || f.status === 'needs_email' && !field(f, 'target_email')}
                    className="px-3 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-40">
                    {busy === f.id ? 'Sending…' : 'Approve & send'}
                  </button>
                  <button onClick={() => save(f).then(ok => ok && setMsg(m => ({ ...m, [f.id]: 'Saved' })))} disabled={!edits[f.id]}
                    className="px-3 py-1.5 border border-gray-200 text-gray-700 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-40">Save edits</button>
                  {f.action_type === 'call' && (
                    <button onClick={() => setStatus(f, 'done')} className="px-3 py-1.5 border border-gray-200 text-gray-700 text-sm rounded-lg hover:bg-gray-50">Called — mark done</button>
                  )}
                  <button onClick={() => pushBack(f, 14)} className="px-3 py-1.5 border border-gray-200 text-gray-700 text-sm rounded-lg hover:bg-gray-50">Push back 2 weeks</button>
                  <button onClick={() => setStatus(f, 'dismissed')} className="px-3 py-1.5 text-gray-500 text-sm rounded-lg hover:bg-gray-50 ml-auto">Dismiss</button>
                </div>
              )}
              {(open || f.status === 'sent') && (
                <div className="flex justify-end">
                  <button onClick={() => markLead(f)} disabled={busy === f.id}
                    className="px-3 py-1.5 border border-green-200 text-green-700 text-sm font-medium rounded-lg hover:bg-green-50 disabled:opacity-40">
                    They&apos;re interested now — mark as lead
                  </button>
                </div>
              )}
              {msg[f.id] && <p className="text-xs text-gray-600">{msg[f.id]}</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
