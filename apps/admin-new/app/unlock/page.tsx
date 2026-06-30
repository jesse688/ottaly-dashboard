'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

function UnlockForm() {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const params = useSearchParams()
  // Only allow same-app relative redirects back (no open-redirect).
  const nextRaw = params.get('next') || '/finance'
  const next = nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/finance'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      if (!res.ok) {
        setError(res.status === 401 ? 'Incorrect finance key' : 'Something went wrong')
        return
      }
      router.push(next)
      router.refresh()
    } catch {
      setError('Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <div className="bg-white rounded-xl p-8 w-full max-w-sm shadow-xl">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-900">Finance locked</h1>
          <p className="text-sm text-gray-500 mt-1">Enter the finance key to view Finance &amp; Revenue. It stays unlocked for 12 hours.</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="password"
            placeholder="Finance key"
            value={key}
            onChange={e => setKey(e.target.value)}
            autoFocus
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading || !key}>
            {loading ? 'Unlocking…' : 'Unlock'}
          </Button>
        </form>
      </div>
    </div>
  )
}

export default function UnlockPage() {
  return (
    <Suspense fallback={null}>
      <UnlockForm />
    </Suspense>
  )
}
