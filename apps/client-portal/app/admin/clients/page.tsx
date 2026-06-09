import { getAdminSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { AdminClientsClient } from './client'

export default async function AdminClientsPage() {
  const ok = await getAdminSession()
  if (!ok) redirect('/admin/login')
  return <AdminClientsClient />
}
