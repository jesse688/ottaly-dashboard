import * as Sentry from '@sentry/nextjs'

/**
 * Next.js loads this once per runtime. It pulls in the right Sentry server/edge
 * config so server-side errors actually get captured — without this file, the
 * Sentry deps in package.json sit unused (which is how the legacy app's failures
 * went undetected). Pair with the onRequestError export below.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.server.config')
  }
}

export const onRequestError = Sentry.captureRequestError
