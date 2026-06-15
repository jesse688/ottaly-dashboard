'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Logo } from '@/app/components/Logo'

interface Account { username: string; email: string; contactName: string; companyName: string }

export function AccountClient({ companyName }: { companyName: string }) {
  const router = useRouter()
  const [acc, setAcc] = useState<Account | null>(null)
  const [contactName, setContactName] = useState('')
  const [email, setEmail] = useState('')
  const [newCode, setNewCode] = useState('')
  const [confirmCode, setConfirmCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/portal/account').then(r => r.json()).then((d: Account & { error?: string }) => {
      if (!d.error) { setAcc(d); setContactName(d.contactName); setEmail(d.email) }
    }).catch(() => {})
  }, [])

  async function handleLogout() { await fetch('/api/logout', { method: 'POST' }); router.push('/login') }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setSaved(false)
    if (newCode && newCode !== confirmCode) { setError('The access codes don’t match.'); return }
    if (newCode && newCode.trim().length < 3) { setError('Choose an access code with at least 3 characters.'); return }

    setSaving(true)
    const res = await fetch('/api/portal/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactName, email, newCode: newCode || undefined }),
    })
    const d = await res.json()
    setSaving(false)
    if (!res.ok) { setError(d.error ?? 'Could not save. Please try again.'); return }

    setSaved(true); setNewCode(''); setConfirmCode('')
    // Changing the login email or code means re-authenticating.
    if (d.emailChanged || newCode) {
      setTimeout(() => { void handleLogout() }, 1400)
    }
  }

  return (
    <div className="min-h-screen bg-[#f7f8fc]" style={{ fontFamily: 'var(--font-inter), system-ui, sans-serif' }}>
      <header className="h-14 bg-[#224388] flex items-center px-3 sm:px-5 gap-2 sm:gap-3 sticky top-0 z-10">
        <span className="flex items-center shrink-0 [&_img]:brightness-0 [&_img]:invert"><Logo onDark /></span>
        <span className="hidden sm:inline text-white/30">|</span>
        <span className="hidden sm:inline text-white/90 text-sm font-medium truncate max-w-[140px]">{companyName}</span>
        <nav className="flex items-center gap-0.5 sm:gap-1 sm:ml-4">
          <a href="/leads" className="px-2.5 sm:px-3 py-1.5 text-white/70 hover:text-white text-sm rounded-lg">Leads</a>
          <a href="/invoices" className="px-2.5 sm:px-3 py-1.5 text-white/70 hover:text-white text-sm rounded-lg">Billing</a>
          <span className="px-2.5 sm:px-3 py-1.5 text-white bg-white/15 text-sm font-medium rounded-lg">Account</span>
        </nav>
        <button onClick={handleLogout} className="ml-auto shrink-0 text-white/70 hover:text-white text-sm">Sign out</button>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-8">
        <h1 className="font-heading text-2xl font-semibold text-[#050c29] mb-1">Your account</h1>
        <p className="text-sm text-gray-500 mb-6">Update your contact details and login.</p>

        <form onSubmit={handleSave} className="space-y-6">
          {/* Profile */}
          <section className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="font-heading text-base font-semibold text-[#050c29] mb-4">Profile</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Company / account</label>
                <input value={acc?.companyName ?? ''} disabled className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-gray-50 text-gray-500" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Your name <span className="text-gray-400">(used for your greeting)</span></label>
                <input value={contactName} onChange={e => setContactName(e.target.value)} placeholder="e.g. Gareth" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-brand-400" />
              </div>
            </div>
          </section>

          {/* Login */}
          <section className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="font-heading text-base font-semibold text-[#050c29] mb-1">Login</h2>
            <p className="text-xs text-gray-500 mb-4">Your email is your username. Changing your email or code signs you out so you can log back in with the new details.</p>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Login email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-brand-400" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">New access code <span className="text-gray-400">(optional)</span></label>
                  <input type="text" value={newCode} onChange={e => setNewCode(e.target.value)} placeholder="Leave blank to keep current" className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-brand-400" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Confirm new code</label>
                  <input type="text" value={confirmCode} onChange={e => setConfirmCode(e.target.value)} disabled={!newCode} className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-brand-400 disabled:bg-gray-50" />
                </div>
              </div>
            </div>
          </section>

          {error && <p className="text-sm text-red-600">{error}</p>}
          {saved && <p className="text-sm text-green-600 font-medium">Saved{(email !== acc?.email || newCode) ? ' — signing you out to apply your new login…' : '.'}</p>}

          <div className="flex justify-end">
            <button type="submit" disabled={saving} className="px-5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold rounded-lg disabled:opacity-50">
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}
