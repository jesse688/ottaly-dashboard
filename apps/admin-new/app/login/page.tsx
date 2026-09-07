'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

// useSearchParams opts the tree into client-side rendering, so Next requires a
// Suspense boundary above it or the /login prerender fails the build.
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}

function LoginForm() {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const params = useSearchParams()
  // The middleware redirects gated pages here as /login?next=<path>, and the
  // Mailboxes write-refused prompt links here the same way. Send the user back
  // where they were trying to go. Only a same-origin absolute path is accepted
  // ("/x", never "//host" or "https://…") so this can't become an open redirect.
  const raw = params.get('next') ?? ''
  const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/contacts'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      if (!res.ok) {
        setError('Invalid key')
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
          <h1 className="text-xl font-semibold text-gray-900">Ottaly</h1>
          {/* One field takes EITHER key — roleForKey() resolves which role you
              get. Saying "admin key" made CMs think they had no way in, so the
              copy names both. Finance/Revenue stay behind their own passphrase. */}
          <p className="text-sm text-gray-500 mt-1">Sign in with your admin or campaign manager key</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="password"
            placeholder="Admin or campaign manager key"
            value={key}
            onChange={e => setKey(e.target.value)}
            autoFocus
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading || !key}>
            {loading ? 'Signing in...' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  )
}
