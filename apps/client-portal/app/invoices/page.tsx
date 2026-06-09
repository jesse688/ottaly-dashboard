import { getSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { InvoicesClient } from './client'

export default async function InvoicesPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  return <InvoicesClient companyName={session.companyName} />
}
