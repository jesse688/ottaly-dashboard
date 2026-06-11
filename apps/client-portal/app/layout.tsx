import type { Metadata } from 'next'
import { Inter, Genos } from 'next/font/google'
import './globals.css'

// Inter = secondary (body); Genos = primary (headings) per the brand kit.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const genos = Genos({ subsets: ['latin'], variable: '--font-genos', display: 'swap' })

export const metadata: Metadata = {
  title: 'Ottaly Portal',
  description: 'Predictable Pipeline',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`h-full ${inter.variable} ${genos.variable}`}>
      <body className="h-full bg-white antialiased" style={{ fontFamily: 'var(--font-inter), system-ui, -apple-system, sans-serif' }}>{children}</body>
    </html>
  )
}
