import type { Metadata } from 'next'
import { headers } from 'next/headers'
import {
  ArrowUpRight,
  Gauge,
  Inbox,
  LayoutDashboard,
  MonitorPlay,
  RefreshCw,
  Share2,
  type LucideIcon,
} from 'lucide-react'

export const metadata: Metadata = { title: 'Ottaly' }
export const dynamic = 'force-dynamic'

// The front door: one tile per app. Sign-in is not handled here. Every
// ottaly.co.uk app sits behind the same Cloudflare Access team and starts its
// own session from that login (lib/cf-access.ts in each app), so a tile is a
// plain link. Rotasend is on another domain, so its tile goes through
// /go/rotasend, which fetches a one-time login link.
interface AppTile {
  name: string
  host: string
  blurb: string
  href: string
  icon: LucideIcon
}

const APPS: AppTile[] = [
  {
    name: 'Admin',
    host: 'admin.ottaly.co.uk',
    blurb: 'Contacts, list pushes and client setup.',
    href: 'https://admin.ottaly.co.uk/index.html',
    icon: LayoutDashboard,
  },
  {
    name: 'Command',
    host: 'dev.ottaly.co.uk',
    blurb: 'Stats, triage, mailboxes and capacity.',
    href: 'https://dev.ottaly.co.uk/',
    icon: Gauge,
  },
  {
    name: 'Client Portal',
    host: 'login.ottaly.co.uk',
    blurb: 'Unibox, follow-ups and client accounts.',
    href: 'https://login.ottaly.co.uk/admin',
    icon: Inbox,
  },
  {
    name: 'Reach',
    host: 'linki.ottaly.co.uk',
    blurb: 'LinkedIn outreach and campaigns.',
    href: 'https://linki.ottaly.co.uk/',
    icon: Share2,
  },
  {
    name: 'Studio',
    host: 'browser.ottaly.co.uk',
    blurb: 'The live browser behind Reach.',
    href: 'https://browser.ottaly.co.uk/',
    icon: MonitorPlay,
  },
  {
    name: 'Rotasend',
    host: 'app.rotasend.com',
    blurb: 'Mailboxes, domains and the rest rota.',
    href: '/go/rotasend',
    icon: RefreshCw,
  },
]

export default async function HomeHub() {
  // Display only. Access set this header; the session itself came from the
  // signature-checked token in the middleware, never from this value.
  const email = (await headers()).get('cf-access-authenticated-user-email')

  return (
    // Covers the app sidebar: this page is the launcher, not a Command page.
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-4 py-10 sm:px-8 sm:py-16">
        <header className="flex items-center justify-between gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-navy.svg" alt="Ottaly" className="h-8 w-auto dark:hidden" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-white.svg" alt="Ottaly" className="hidden h-8 w-auto dark:block" />
          {email && <span className="truncate text-sm text-muted-foreground">{email}</span>}
        </header>

        <h1 className="mt-12 font-display text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Where to?
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You are signed in. Pick an app and it opens ready to use.
        </p>

        <ul className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {APPS.map(app => (
            <li key={app.name}>
              <a
                href={app.href}
                className="group flex h-full flex-col rounded-xl border border-border bg-card p-5 text-card-foreground transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <div className="flex items-start justify-between">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <app.icon className="h-5 w-5" aria-hidden />
                  </span>
                  <ArrowUpRight
                    className="h-4 w-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary motion-reduce:transition-none"
                    aria-hidden
                  />
                </div>
                <h2 className="mt-5 font-display text-2xl font-semibold leading-none">{app.name}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{app.blurb}</p>
                <p className="mt-auto pt-5 font-mono text-xs text-muted-foreground">{app.host}</p>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
