import { Pool } from 'pg'

declare global {
  // eslint-disable-next-line no-var
  var _portalPgPool: Pool | undefined
}

function createPool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })
}

const pool = globalThis._portalPgPool ?? createPool()
if (process.env.NODE_ENV !== 'production') globalThis._portalPgPool = pool

export default pool
