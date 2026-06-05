'use strict'

/**
 * Ottaly Slack Bot
 *
 * Listens for messages in a designated Slack channel, runs them through
 * Claude Code CLI non-interactively, and posts the result back.
 *
 * Setup:
 * 1. Create a Slack app with Socket Mode enabled
 * 2. Add Bot Token Scopes: chat:write, channels:read, app_mentions:read
 * 3. Subscribe to events: app_mention, message.channels
 * 4. Set env vars: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_CHANNEL_ID
 *
 * Run: node slack-bot/bot.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') })

const { execFile } = require('child_process')
const https = require('https')

const BOT_TOKEN    = process.env.SLACK_BOT_TOKEN
const APP_TOKEN    = process.env.SLACK_APP_TOKEN   // xapp-... (Socket Mode)
const CHANNEL_ID   = process.env.SLACK_CHANNEL_ID  // C... channel ID
const PROJECT_DIR  = process.env.SLACK_PROJECT_DIR ?? '/app'
const MAX_RESPONSE = 3000 // chars — Slack block limit

if (!BOT_TOKEN || !APP_TOKEN || !CHANNEL_ID) {
  console.error('[slack-bot] Missing SLACK_BOT_TOKEN, SLACK_APP_TOKEN, or SLACK_CHANNEL_ID')
  process.exit(1)
}

// ── Slack API helpers ─────────────────────────────────────────────────────────

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

async function postThinking(threadTs) {
  return postMessage('_Working on it..._', threadTs)
}

async function updateMessage(ts, text) {
  return slackPost('chat.update', { channel: CHANNEL_ID, ts, text })
}

// ── Claude Code runner ────────────────────────────────────────────────────────

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const timeout = 5 * 60 * 1000 // 5 min max
    const proc = execFile(
      'claude',
      ['--print', '--no-interactive', prompt],
      {
        cwd: PROJECT_DIR,
        env: { ...process.env },
        timeout,
        maxBuffer: 1024 * 1024 * 10,
      },
      (err, stdout, stderr) => {
        if (err && err.killed) return reject(new Error('Timed out after 5 minutes'))
        // Claude CLI exits non-zero on tool errors but still produces output
        resolve(stdout || stderr || 'No output')
      }
    )
    proc.on('error', reject)
  })
}

function truncate(text, max) {
  if (text.length <= max) return text
  return text.slice(0, max - 100) + '\n\n_...truncated. Ask for more detail if needed._'
}

// ── Socket Mode WebSocket connection ──────────────────────────────────────────

const WebSocket = (() => {
  try { return require('ws') } catch { return null }
})()

if (!WebSocket) {
  console.error('[slack-bot] ws package not installed. Run: npm install ws')
  process.exit(1)
}

let ws
let pingInterval
const processedEvents = new Set()

async function connect() {
  // Get WebSocket URL via apps.connections.open
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

    // Acknowledge immediately
    if (msg.envelope_id) {
      ws.send(JSON.stringify({ envelope_id: msg.envelope_id }))
    }

    if (msg.type === 'disconnect') {
      console.log('[slack-bot] Disconnect received, reconnecting...')
      cleanup()
      setTimeout(connect, 1000)
      return
    }

    if (msg.type !== 'events_api') return
    const event = msg.payload?.event
    if (!event) return

    // Only handle messages in our channel (not from bots)
    if (event.channel !== CHANNEL_ID) return
    if (event.bot_id || event.subtype) return
    if (!event.text) return

    // Dedup
    const eventKey = event.client_msg_id ?? event.ts
    if (processedEvents.has(eventKey)) return
    processedEvents.add(eventKey)
    if (processedEvents.size > 1000) {
      const first = processedEvents.values().next().value
      processedEvents.delete(first)
    }

    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim()
    if (!text) return

    console.log(`[slack-bot] Message: "${text.slice(0, 80)}"`)

    // Post thinking indicator in thread
    const thinkingRes = await postThinking(event.ts)
    const thinkingTs = thinkingRes.ts

    try {
      const result = await runClaude(text)
      const response = truncate(result, MAX_RESPONSE)
      await updateMessage(thinkingTs, response)
    } catch (err) {
      await updateMessage(thinkingTs, `❌ Error: ${err.message}`)
    }
  })

  ws.on('close', () => {
    console.log('[slack-bot] Connection closed, reconnecting...')
    cleanup()
    setTimeout(connect, 3000)
  })

  ws.on('error', err => {
    console.error('[slack-bot] WebSocket error:', err.message)
  })
}

function cleanup() {
  clearInterval(pingInterval)
  try { ws.terminate() } catch {}
}

connect().catch(err => {
  console.error('[slack-bot] Fatal:', err)
  process.exit(1)
})

console.log('[slack-bot] Starting Ottaly agent bot...')
