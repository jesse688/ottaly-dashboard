'use strict'

/**
 * Ottaly Slack Bot
 *
 * Listens for messages in a designated Slack channel, runs them through
 * the Anthropic API (Claude), and posts the result back in-thread.
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN    xoxb-...
 *   SLACK_APP_TOKEN    xapp-... (Socket Mode)
 *   SLACK_CHANNEL_ID   C...
 *   ANTHROPIC_API_KEY  sk-ant-...
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') })

const https = require('https')

const BOT_TOKEN   = process.env.SLACK_BOT_TOKEN
const APP_TOKEN   = process.env.SLACK_APP_TOKEN
const CHANNEL_ID  = process.env.SLACK_CHANNEL_ID
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY

if (!BOT_TOKEN || !APP_TOKEN || !CHANNEL_ID) {
  console.error('[slack-bot] Missing SLACK_BOT_TOKEN, SLACK_APP_TOKEN, or SLACK_CHANNEL_ID')
  process.exit(1)
}

if (!ANTHROPIC_KEY) {
  console.error('[slack-bot] Missing ANTHROPIC_API_KEY')
  process.exit(1)
}

// ── Slack API ─────────────────────────────────────────────────────────────────

function slackPost(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: 'slack.com',
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let body = ''
      res.on('data', d => body += d)
      res.on('end', () => resolve(JSON.parse(body)))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

async function postMessage(text, threadTs = null) {
  const payload = { channel: CHANNEL_ID, text }
  if (threadTs) payload.thread_ts = threadTs
  return slackPost('chat.postMessage', payload)
}

async function updateMessage(ts, text) {
  return slackPost('chat.update', { channel: CHANNEL_ID, ts, text })
}

// ── Anthropic API ─────────────────────────────────────────────────────────────

const DB_CONTEXT = `You are the Ottaly admin agent. Ottaly is a UK B2B lead generation agency.
You have access to context about the business. When asked questions, answer concisely and helpfully.
Key facts:
- 30 client workspaces in PlusVibe
- 977k+ contacts in PostgreSQL
- Campaigns run via PlusVibe email sequencing
- Database: postgres://postgres:***@46.38.255.178:5432/ottaly
- New dashboard at dev.ottaly.co.uk (Next.js), old at admin.ottaly.co.uk (Express)
Answer questions about the business, suggest actions, or explain data. Keep responses under 500 words.`

function callClaude(userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: DB_CONTEXT,
      messages: [{ role: 'user', content: userMessage }],
    })

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) return reject(new Error(parsed.error.message))
          resolve(parsed.content?.[0]?.text ?? 'No response')
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── Socket Mode ───────────────────────────────────────────────────────────────

const WebSocket = (() => {
  try { return require('ws') } catch { return null }
})()

if (!WebSocket) {
  console.error('[slack-bot] ws package not installed. Run: npm install ws')
  process.exit(1)
}

let ws, pingInterval
const processedEvents = new Set()

async function connect() {
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'slack.com',
      path: '/api/apps.connections.open',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${APP_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }, res => {
      let body = ''
      res.on('data', d => body += d)
      res.on('end', () => resolve(JSON.parse(body)))
    })
    req.on('error', reject)
    req.end()
  })

  if (!res.ok) {
    console.error('[slack-bot] Failed to open connection:', res.error)
    setTimeout(connect, 5000)
    return
  }

  console.log('[slack-bot] Connecting to Slack...')
  ws = new WebSocket(res.url)

  ws.on('open', () => {
    console.log('[slack-bot] Connected ✓')
    pingInterval = setInterval(() => ws.ping(), 30000)
  })

  ws.on('message', async raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }))

    if (msg.type === 'disconnect') {
      cleanup(); setTimeout(connect, 1000); return
    }

    if (msg.type !== 'events_api') return
    const event = msg.payload?.event
    if (!event) return
    if (event.channel !== CHANNEL_ID) return
    if (event.bot_id || event.subtype) return
    if (!event.text) return

    const eventKey = event.client_msg_id ?? event.ts
    if (processedEvents.has(eventKey)) return
    processedEvents.add(eventKey)
    if (processedEvents.size > 1000) processedEvents.delete(processedEvents.values().next().value)

    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim()
    if (!text) return

    console.log(`[slack-bot] Message: "${text.slice(0, 80)}"`)

    const thinkingRes = await postMessage('_Thinking..._', event.ts)
    const thinkingTs = thinkingRes.ts

    try {
      const reply = await callClaude(text)
      await updateMessage(thinkingTs, reply)
    } catch (err) {
      console.error('[slack-bot] Error:', err.message)
      await updateMessage(thinkingTs, `❌ Error: ${err.message}`)
    }
  })

  ws.on('close', () => { cleanup(); setTimeout(connect, 3000) })
  ws.on('error', err => console.error('[slack-bot] WebSocket error:', err.message))
}

function cleanup() {
  clearInterval(pingInterval)
  try { ws.terminate() } catch {}
}

console.log('[slack-bot] Starting Ottaly agent bot...')
connect().catch(err => { console.error('[slack-bot] Fatal:', err); process.exit(1) })
