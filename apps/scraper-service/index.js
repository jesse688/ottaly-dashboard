import { execSync } from 'node:child_process'
import { runWorker } from './src/worker.js'

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set')
  process.exit(1)
}

// Crawlee's memory snapshot spawns `ps`. If it's missing, EVERY scrape job dies
// with "spawn ps ENOENT". Probe it once at startup so the log says plainly
// whether THIS container has it — the fastest way to tell if a new image with
// procps actually deployed (vs Easypanel serving a stale cached build).
try {
  execSync('ps -A -o pid= 2>/dev/null', { stdio: 'ignore' })
  console.log(`[startup] ✓ \`ps\` is available — Crawlee memory snapshots will work`)
} catch {
  console.error(
    `[startup] ✗ \`ps\` is NOT in this container. Crawlee will crash every job with ` +
    `"spawn ps ENOENT". This means the image was built WITHOUT procps (likely a ` +
    `stale Easypanel build cache). Fix: rebuild with cache cleared / "Force rebuild".`
  )
}

runWorker().catch(err => {
  console.error('FATAL worker crash:', err)
  process.exit(1)
})
