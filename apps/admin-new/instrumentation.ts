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
    // Start the mailbox health ingest at BOOT rather than waiting for someone
    // to open a page. Next loads route modules lazily, so a self-starting lib
    // module that is only pulled in by an API route does not exist until a
    // human happens to visit — which is how the cache warmer once went 4.4
    // hours without writing on a 2-minute interval.
    //
    // A failure here must never stop the app booting, so it is caught.
    try {
      await import('./lib/mailbox-health')
    } catch (err) {
      console.error('[instrumentation] mailbox-health failed to start:', err)
    }
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.server.config')
  }
}

export const onRequestError = Sentry.captureRequestError
