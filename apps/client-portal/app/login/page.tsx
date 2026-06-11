'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Logo } from '@/app/components/Logo'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [code, setCode] = useState('')
  const [showCode, setShowCode] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [forgotMsg, setForgotMsg] = useState('')
  const router = useRouter()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!username || !code) return
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, code }),
      })
      if (!res.ok) {
        const data = await res.json() as { error: string }
        setError(data.error ?? 'Login failed')
        return
      }
      router.push('/unibox'); router.refresh()
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleForgot(e: FormEvent) {
    e.preventDefault()
    if (!username) return
    setLoading(true)
    await fetch('/api/forgot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    }).catch(() => {})
    setLoading(false)
    setForgotMsg("Thanks — we've notified your account manager, who will resend your code shortly.")
  }

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <Logo size="lg" />
        </div>
        <h1 className="text-lg font-semibold text-gray-900 text-center mb-6">Client Login</h1>

        {mode === 'login' ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-700 mb-1">Email</label>
              <input type="email" value={username} onChange={e => setUsername(e.target.value)} placeholder="you@company.com" autoFocus autoCapitalize="none" autoComplete="username"
                className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200 transition-colors" />
            </div>
            <div>
              <label className="block text-sm text-gray-700 mb-1">Access code</label>
              <div className="relative">
                <input type={showCode ? 'text' : 'password'} value={code} onChange={e => setCode(e.target.value)} placeholder="Otta-••••" autoComplete="current-password"
                  className="w-full px-3 py-2 pr-10 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200 transition-colors" />
                <button type="button" onClick={() => setShowCode(v => !v)} tabIndex={-1} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showCode ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>

            <div className="flex justify-end">
              <button type="button" onClick={() => { setMode('forgot'); setError(''); setForgotMsg('') }} className="text-sm text-indigo-600 hover:text-indigo-800">Forgot your code?</button>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button type="submit" disabled={loading || !username || !code}
              className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-semibold transition-colors">
              {loading ? 'Signing in…' : 'Login'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleForgot} className="space-y-4">
            {forgotMsg ? (
              <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2.5">{forgotMsg}</p>
            ) : (
              <>
                <p className="text-sm text-gray-500">Enter your email and we&apos;ll let your account manager know to resend your code.</p>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">Email</label>
                  <input type="email" value={username} onChange={e => setUsername(e.target.value)} placeholder="you@company.com" autoFocus autoCapitalize="none"
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200" />
                </div>
                <button type="submit" disabled={loading || !username}
                  className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-semibold">
                  {loading ? 'Sending…' : 'Request my code'}
                </button>
              </>
            )}
            <button type="button" onClick={() => { setMode('login'); setForgotMsg('') }} className="w-full text-sm text-gray-500 hover:text-gray-700">Back to login</button>
          </form>
        )}
      </div>
    </div>
  )
}

function EyeIcon() {
  return (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>)
}
function EyeOffIcon() {
  return (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>)
}
