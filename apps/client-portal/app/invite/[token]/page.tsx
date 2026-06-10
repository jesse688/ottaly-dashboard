'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useParams, useRouter } from 'next/navigation'

export default function InvitePage() {
  const { token } = useParams<{ token: string }>()
  const router = useRouter()
  const [company, setCompany] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [username, setUsername] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch(`/api/invite/${token}`).then(async r => {
      if (!r.ok) { setInvalid(true); return }
      const d = await r.json() as { companyName: string }
      setCompany(d.companyName)
    }).catch(() => setInvalid(true))
  }, [token])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (username.trim().length < 3 || code.trim().length < 4) return
    setLoading(true); setError('')
    const res = await fetch(`/api/invite/${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, code }),
    })
    setLoading(false)
    if (!res.ok) { const d = await res.json() as { error: string }; setError(d.error ?? 'Something went wrong'); return }
    router.push('/unibox'); router.refresh()
  }

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <span className="bg-slate-800 text-white text-sm font-bold px-4 py-1.5 rounded">Ottaly</span>
        </div>

        {invalid ? (
          <p className="text-sm text-center text-gray-500">This invite link is invalid or has already been used. Please contact your account manager.</p>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-gray-900 text-center mb-1">Set up your login</h1>
            <p className="text-sm text-gray-500 text-center mb-6">{company ? `for ${company}` : 'Loading…'}</p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-700 mb-1">Choose a username</label>
                <input value={username} onChange={e => setUsername(e.target.value)} placeholder="e.g. gareth" autoFocus autoCapitalize="none"
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200" />
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">Choose an access code</label>
                <input value={code} onChange={e => setCode(e.target.value)} placeholder="something memorable"
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200" />
                <p className="text-xs text-gray-400 mt-1">You&apos;ll use these to log in next time.</p>
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button type="submit" disabled={loading || username.trim().length < 3 || code.trim().length < 4}
                className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-semibold">
                {loading ? 'Setting up…' : 'Create my login'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
