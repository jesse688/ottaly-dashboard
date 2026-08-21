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
    // Start the cache warmer HERE, at boot, rather than relying on someone
    // visiting a page. cache-warming.ts self-starts on import, but the only
    // things importing it are API routes (stats/summary, stats/refresh,
    // mailbox-sync) -- and Next.js loads route modules LAZILY, on first
    // request. So after a deploy the warmer did not exist until a human
    // happened to open Stats or Combo.
    //
    // Measured on dev: combo_daily_stats had not been written for 4.4 hours
    // (266 min), the interval is 2 minutes. One request to the combo API woke
    // the module and it wrote within 40 seconds. That is the whole bug -- the
    // warm loop was never running, so the matrix could never fill in and its
    // totals stayed short of PlusVibe no matter how the pass was tuned.
    //
    // instrumentation.ts is Next's documented startup hook: it runs once per
    // runtime at boot, with no request needed. Failure here must not stop the
    // app booting, so it is caught and logged.
    try {
      await import('./lib/cache-warming')
    } catch (err) {
      console.error('[instrumentation] cache-warming failed to start:', err)
    }
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.server.config')
  }
}

export const onRequestError = Sentry.captureRequestError
