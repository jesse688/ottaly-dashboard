import { redirect } from 'next/navigation'

// The leads inbox lives at /leads now (URL matches the "Leads" nav label).
// Keep /unibox as a permanent redirect for old links/bookmarks.
export default function UniboxRedirect() {
  redirect('/leads')
}
