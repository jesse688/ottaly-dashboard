import { getAdminSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { AdminUniboxClient } from './client'

export default async function AdminUniboxPage() {
  const ok = await getAdminSession()
  if (!ok) redirect('/admin/login')
  return <AdminUniboxClient />
}
