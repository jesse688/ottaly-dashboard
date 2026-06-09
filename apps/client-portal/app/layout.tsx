import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ottaly Client Portal',
  description: 'Your campaign performance dashboard',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full bg-white antialiased">{children}</body>
    </html>
  )
}
