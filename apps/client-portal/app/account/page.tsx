import { getSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { AccountClient } from './client'

export default async function AccountPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  return <AccountClient companyName={session.companyName} />
}
