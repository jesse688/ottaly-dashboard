import { getAdminSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { AdminFollowupsClient } from './client'

export default async function AdminFollowupsPage() {
  const ok = await getAdminSession()
  if (!ok) redirect('/admin/login')
  return <AdminFollowupsClient />
}
