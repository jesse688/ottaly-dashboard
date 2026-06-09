'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

interface PortalClient {
  id: string
  email: string
  company_name: string
  workspace_id: string
  workspace_name: string | null
  active: boolean
  created_at: string
}

interface Workspace {
  id: string
  name: string
  active_campaigns: number
}

export function AdminClientsClient() {
  const [clients, setClients] = useState<PortalClient[] | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState({ email: '', password: '', workspaceId: '', companyName: '' })
  const [resetPassword, setResetPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()

  function load() {
    fetch('/api/admin/clients').then(r => r.json()).then(setClients)
  }

  useEffect(() => {
    load()
    fetch('/api/admin/workspaces').then(r => r.json()).then(setWorkspaces)
  }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/admin/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email,
          password: form.password,
          workspaceId: form.workspaceId,
          companyName: form.companyName,
        }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) { setError(data.error ?? 'Error'); return }
      setForm({ email: '', password: '', workspaceId: '', companyName: '' })
      setShowForm(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(client: PortalClient) {
    await fetch(`/api/admin/clients/${client.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !client.active }),
    })
    load()
  }

  async function handleResetPassword(id: string) {
    if (!resetPassword) return
    await fetch(`/api/admin/clients/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: resetPassword }),
    })
    setResetPassword('')
    setEditId(null)
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this client login? They will lose access immediately.')) return
    await fetch(`/api/admin/clients/${id}`, { method: 'DELETE' })
    load()
  }

  async function handleLogout() {
    await fetch('/api/admin/auth', { method: 'DELETE' })
    router.push('/admin/login')
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="h-12 bg-slate-900 flex items-center px-6 gap-3">
        <span className="text-white font-bold text-sm">Ottaly</span>
        <span className="text-slate-500 text-xs">|</span>
        <span className="text-slate-300 text-sm">Portal Admin</span>
        <div className="ml-auto">
          <button onClick={handleLogout} className="text-slate-400 hover:text-white text-xs">Sign out</button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Client Logins</h1>
            <p className="text-sm text-gray-500 mt-0.5">{clients?.length ?? '…'} clients</p>
          </div>
          <button
            onClick={() => { setShowForm(v => !v); setError('') }}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg"
          >
            + Add client
          </button>
        </div>

        {/* Create form */}
        {showForm && (
          <div className="bg-white rounded-xl border border-gray-100 p-5 mb-6">
            <h2 className="text-sm font-semibold text-gray-800 mb-4">New client login</h2>
            <form onSubmit={handleCreate} className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Company name</label>
                <input
                  required
                  value={form.companyName}
                  onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))}
                  placeholder="Jumping Spider Media"
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Workspace</label>
                <select
                  required
                  value={form.workspaceId}
                  onChange={e => {
                    const ws = workspaces.find(w => w.id === e.target.value)
                    setForm(f => ({
                      ...f,
                      workspaceId: e.target.value,
                      companyName: f.companyName || (ws?.name ?? ''),
                    }))
                  }}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 bg-white"
                >
                  <option value="">Select workspace…</option>
                  {workspaces.map(w => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Login email</label>
                <input
                  required
                  type="email"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="client@company.com"
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Password</label>
                <input
                  required
                  type="text"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="Set a password for them"
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400"
                />
              </div>
              {error && <p className="col-span-2 text-sm text-red-600">{error}</p>}
              <div className="col-span-2 flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg disabled:opacity-60"
                >
                  {saving ? 'Creating…' : 'Create login'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Client list */}
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Company</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Login email</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Workspace</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {clients === null ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    {Array.from({ length: 5 }).map((_, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))
              ) : clients.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-gray-400 text-sm">
                    No clients yet — add one above
                  </td>
                </tr>
              ) : (
                clients.map(client => (
                  <>
                    <tr key={client.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{client.company_name}</td>
                      <td className="px-4 py-3 text-gray-600">{client.email}</td>
                      <td className="px-4 py-3 text-gray-600">{client.workspace_name ?? client.workspace_id}</td>
                      <td className="px-4 py-3">
                        <span className={cn(
                          'inline-flex px-2 py-0.5 rounded-full text-xs font-medium',
                          client.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                        )}>
                          {client.active ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setEditId(editId === client.id ? null : client.id)}
                            className="text-xs text-indigo-600 hover:text-indigo-800"
                          >
                            Reset password
                          </button>
                          <span className="text-gray-200">|</span>
                          <button
                            onClick={() => toggleActive(client)}
                            className="text-xs text-gray-500 hover:text-gray-800"
                          >
                            {client.active ? 'Disable' : 'Enable'}
                          </button>
                          <span className="text-gray-200">|</span>
                          <button
                            onClick={() => handleDelete(client.id)}
                            className="text-xs text-red-500 hover:text-red-700"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                    {editId === client.id && (
                      <tr key={`${client.id}-edit`} className="border-b border-gray-50 bg-indigo-50">
                        <td colSpan={5} className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-gray-600">New password for {client.email}:</span>
                            <input
                              type="text"
                              value={resetPassword}
                              onChange={e => setResetPassword(e.target.value)}
                              placeholder="Enter new password"
                              className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 w-56"
                            />
                            <button
                              onClick={() => handleResetPassword(client.id)}
                              disabled={!resetPassword}
                              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg disabled:opacity-60"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => { setEditId(null); setResetPassword('') }}
                              className="text-xs text-gray-500 hover:text-gray-800"
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
