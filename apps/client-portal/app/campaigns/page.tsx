import { getSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { PortalLayout } from '@/components/portal-layout'
import { CampaignsClient } from './client'

export default async function CampaignsPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  return (
    <PortalLayout companyName={session.companyName}>
      <CampaignsClient />
    </PortalLayout>
  )
}
