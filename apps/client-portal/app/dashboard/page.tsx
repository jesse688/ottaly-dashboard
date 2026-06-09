import { getSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { PortalLayout } from '@/components/portal-layout'
import { DashboardClient } from './client'

export default async function DashboardPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  return (
    <PortalLayout companyName={session.companyName}>
      <DashboardClient />
    </PortalLayout>
  )
}
