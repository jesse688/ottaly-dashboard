/**
 * PlusVibe MCP client.
 *
 * Some PlusVibe operations have no REST path under /api/v1 and exist only on
 * the MCP endpoint — writing account settings in bulk is one, placement tests
 * are another. Every documented REST shape for them 404s.
 *
 * It is plain JSON-RPC over HTTP, so this is an ordinary fetch client, not an
 * AI integration.
 *
 * AUTH: the key goes in the URL as ?api_key=..., NOT in a header. Passing it as
 * x-api-key, Authorization or API_KEY_PV all connect fine and return a session
 * id, then fail every tool call with "requires authentication" — which reads
 * like a config problem rather than the wrong auth channel. That cost an hour.
 *
 * Requests go through the SHARED pvGate, exactly like the REST client. Never a
 * second limiter.
 */

import { pvGate, pvBackoffSignal, PV_MAX_RETRIES, PV_BASE_BACKOFF_MS, PV_COOLDOWN_MS } from './pv-gate'

const ENDPOINT = process.env.PLUSVIBE_MCP_URL || 'https://mcp.plusvibe.ai/mcp'
const PV_KEY = process.env.PLUSVIBE_KEY ?? process.env.PLUSVIBE_API_KEY ?? ''

/** Responses arrive as SSE frames ("event: message\ndata: {...}"). */
function parseSse(text: string): Record<string, unknown> | null {
  const lines = text.split('\n').filter(l => l.startsWith('data:'))
  if (!lines.length) {
    try { return JSON.parse(text) } catch { return null }
  }
  for (const line of lines.reverse()) {
    try { return JSON.parse(line.slice(5).trim()) } catch { /* keep looking */ }
  }
  return null
}

let session: string | null = null

function url(): string {
  return `${ENDPOINT}?api_key=${encodeURIComponent(PV_KEY)}`
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (session) h['mcp-session-id'] = session
  return h
}

async function connect(): Promise<void> {
  if (session) return
  const res = await fetch(url(), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ottaly-admin', version: '1.0' } },
    }),
    signal: AbortSignal.timeout(30000),
  })
  session = res.headers.get('mcp-session-id')
  if (!session) throw new Error('PlusVibe MCP did not return a session id')
  // Fire and forget: the server does not always answer this one.
  await fetch(url(), {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(20000),
  }).catch(() => {})
}

let callId = 1

/**
 * Call a PlusVibe MCP tool. Goes through the shared gate.
 *
 * `priority` jumps the gate's interactive queue. Every mcpCall is a WRITE a
 * human clicked a button for, so it defaults to true.
 *
 * WHY: on 2026-09-21 a pause of 25 mailboxes reported "Changed 0 of 25. 25
 * failed" while the identical call succeeded from a shell. Nothing was
 * rejected -- a 1,626-mailbox backfill was running, PlusVibe was answering
 * 429 (38 in one hour), and the write sat behind that background work until
 * it exhausted its retries and returned null. A person waiting on a button
 * must not queue behind a batch job.
 *
 * `label` names the caller in the thrown error, because a null return used to
 * be indistinguishable from a genuine rejection and nothing was logged.
 */
export async function mcpCall<T = Record<string, unknown>>(
  tool: string,
  args: Record<string, unknown>,
  opts: { priority?: boolean; label?: string } = {},
): Promise<T | null> {
  if (!PV_KEY) throw new Error('PlusVibe key not configured (PLUSVIBE_KEY)')
  const who = opts.label ? `${opts.label}/${tool}` : tool
  let lastReason = 'no attempts made'
  return pvGate(async () => {
    for (let attempt = 0; attempt < PV_MAX_RETRIES; attempt++) {
      try {
        await connect()
        const res = await fetch(url(), {
          method: 'POST', headers: headers(),
          body: JSON.stringify({
            jsonrpc: '2.0', id: ++callId, method: 'tools/call',
            params: { name: tool, arguments: args },
          }),
          signal: AbortSignal.timeout(90000),
        })
        if (res.status === 429) {
          const wait = PV_BASE_BACKOFF_MS * (attempt + 1)
          lastReason = `PlusVibe rate limited (429) after ${attempt + 1} attempts`
          pvBackoffSignal(Math.max(wait, PV_COOLDOWN_MS))
          await new Promise(r => setTimeout(r, wait))
          continue
        }
        if (res.status === 400) {
          // Usually a dropped session; re-establish and retry once.
          session = null
          lastReason = 'PlusVibe returned 400 (session dropped or bad request)'
          if (attempt < PV_MAX_RETRIES - 1) continue
        }
        if (!res.ok) lastReason = `PlusVibe returned HTTP ${res.status}`
        const msg = parseSse(await res.text())
        const err = (msg as { error?: { message?: string } })?.error
        if (err) throw new Error(`${tool}: ${err.message}`)

        // Tool results arrive as content blocks holding a JSON string, usually
        // prefixed "API Response (Status: 200):".
        const content = (msg as { result?: { content?: { text?: string }[] } })?.result?.content
        if (Array.isArray(content)) {
          const text = content.map(c => c.text ?? '').join('')
          const brace = text.search(/[[{]/)
          if (brace >= 0) {
            try { return JSON.parse(text.slice(brace)) as T } catch { return { raw: text } as T }
          }
          return { raw: text } as T
        }
        return ((msg as { result?: T })?.result ?? null)
      } catch (e) {
        lastReason = e instanceof Error ? e.message : String(e)
        if (attempt >= PV_MAX_RETRIES - 1) throw new Error(`${who}: ${lastReason}`)
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
      }
    }
    // Retries exhausted. Throwing beats returning null: the caller used to
    // score null as "failed" with no reason recorded anywhere, which is how a
    // rate-limited pause looked identical to a rejected one.
    throw new Error(`${who}: gave up after ${PV_MAX_RETRIES} attempts - ${lastReason}`)
  }, opts.priority !== false)
}
