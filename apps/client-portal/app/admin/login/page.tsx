'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Logo } from '@/app/components/Logo'

export default function AdminLoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) { setError('Invalid password'); return }
      router.push('/admin/clients')
      router.refresh()
    } catch {
      setError('Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <Logo size="lg" />
        </div>
        <h1 className="text-xl font-semibold text-gray-900 text-center mb-1">Portal Admin</h1>
        <p className="text-sm text-gray-500 text-center mb-6">Manage client logins</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            placeholder="Admin password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200"
            autoFocus
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading || !password}
            className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-semibold"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
