// MUST be the first import: sets env that changes Crawlee's memory-info path
// (avoids "spawn ps ENOENT"). Import order matters — see the file's comment.
import './src/pre-crawlee-env.js'
import { runWorker } from './src/worker.js'

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set')
  process.exit(1)
}

runWorker().catch(err => {
  console.error('FATAL worker crash:', err)
  process.exit(1)
})
