import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })

export const metadata: Metadata = {
  title: 'Ottaly Portal',
  description: 'Predictable Pipeline',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`h-full ${inter.variable}`}>
      <body className="h-full bg-white antialiased" style={{ fontFamily: 'var(--font-inter), system-ui, -apple-system, sans-serif' }}>{children}</body>
    </html>
  )
}
