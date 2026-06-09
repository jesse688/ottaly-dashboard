import { getSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { PortalLayout } from '@/components/portal-layout'
import { LeadsClient } from './client'

export default async function LeadsPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  return (
    <PortalLayout companyName={session.companyName}>
      <LeadsClient />
    </PortalLayout>
  )
}
