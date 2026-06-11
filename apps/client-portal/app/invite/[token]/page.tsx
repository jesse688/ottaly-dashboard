'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Logo } from '@/app/components/Logo'

export default function InvitePage() {
  const { token } = useParams<{ token: string }>()
  const router = useRouter()
  const [company, setCompany] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [code, setCode] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch(`/api/invite/${token}`).then(async r => {
      if (!r.ok) { setInvalid(true); return }
      const d = await r.json() as { companyName: string; email: string }
      setCompany(d.companyName); setEmail(d.email)
    }).catch(() => setInvalid(true))
  }, [token])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (code.trim().length < 3) { setError('Choose a code with at least 3 characters.'); return }
    if (code.trim() !== confirm.trim()) { setError('The codes don’t match.'); return }
    setLoading(true); setError('')
    const res = await fetch(`/api/invite/${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    setLoading(false)
    if (!res.ok) { const d = await res.json() as { error: string }; setError(d.error ?? 'Something went wrong'); return }
    router.push('/unibox'); router.refresh()
  }

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <Logo size="lg" />
        </div>

        {invalid ? (
          <p className="text-sm text-center text-gray-500">This invite link is invalid or has already been used. Please contact your account manager.</p>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-[#0d2c62] text-center mb-1">Set your access code</h1>
            <p className="text-sm text-gray-500 text-center mb-6">{company ? `for ${company}` : 'Loading…'}</p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-700 mb-1">Your login email</label>
                <input value={email} readOnly className="w-full px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm text-gray-600 outline-none" />
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">Create an access code</label>
                <input value={code} onChange={e => setCode(e.target.value)} placeholder="something memorable" autoFocus
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-200" />
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">Confirm access code</label>
                <input value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="re-enter your code"
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-200" />
                <p className="text-xs text-gray-400 mt-1">You&apos;ll log in with your email + this code.</p>
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button type="submit" disabled={loading || !code.trim() || !confirm.trim()}
                className="w-full py-2.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-semibold">
                {loading ? 'Setting up…' : 'Create my login'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
