import { runWorker } from './src/worker.js'

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set')
  process.exit(1)
}

runWorker().catch(err => {
  console.error('FATAL worker crash:', err)
  process.exit(1)
})
