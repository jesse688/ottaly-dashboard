import { getSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { UniboxClient } from './client'

export default async function UniboxPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  return <UniboxClient companyName={session.companyName} />
}
