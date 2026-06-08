'use strict'

require('dotenv').config()

const express = require('express')
const crypto = require('crypto')
const { execSync, spawnSync } = require('child_process')
const https = require('https')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3100

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
const MAC_USER = process.env.MAC_USER || 'jesse'
const MAC_HOST = process.env.MAC_HOST || '46.38.255.178'
const MAC_REPO = process.env.MAC_REPO || '/Users/jesse/Desktop/ottaly-dashboard'
const CLAUDE_PATH = process.env.CLAUDE_PATH || '/Users/jesse/.nvm/versions/node/v24.11.1/bin/claude'
const CLAUDE_AUTH_TOKEN = process.env.CLAUDE_AUTH_TOKEN || ''
const VERCEL_PROJECT = 'ottaly-dashboard-admin-new'
const AGENTS_DIR = process.env.AGENTS_DIR || '/app/agents'
const REPO_DIR = process.env.REPO_DIR || '/app/repo'
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''
const REPO_URL = `https://${GITHUB_TOKEN}@github.com/jesse688/ottaly-dashboard.git`
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://admin.ottaly.co.uk'
const DASHBOARD_KEY = process.env.ADMIN_KEY || 'Ottaly2025$'

let buildLock = false

// ── Repo setup ────────────────────────────────────────────
function ensureRepo() {
  if (!fs.existsSync(path.join(REPO_DIR, '.git'))) {
    console.log('[repo] Cloning repo...')
    execSync(`git clone ${REPO_URL} ${REPO_DIR}`, { stdio: 'pipe' })
    console.log('[repo] Cloned.')
  }
}

function repoExec(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO_DIR, encoding: 'utf8', timeout: 60000, ...opts })
}

// ── SSH helper (build agent only) ────────────────────────
function sshMac(command, timeoutMs = 120000) {
  const scriptFile = `/tmp/ssh-cmd-${Date.now()}.sh`
  fs.writeFileSync(scriptFile, command, 'utf8')
  try {
    return execSync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=40 -p 2222 ${MAC_USER}@${MAC_HOST} 'bash -s' < ${scriptFile}`,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
    )
  } finally {
    try { fs.unlinkSync(scriptFile) } catch {}
  }
}

// ── Dashboard API ─────────────────────────────────────────
function dashboardGet(apiPath) {
  return new Promise((resolve) => {
    const url = new URL(DASHBOARD_URL + apiPath)
    const req = https.request({
      hostname: url.hostname, port: 443,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'x-admin-key': DASHBOARD_KEY, 'Accept': 'application/json' }
    }, res => {
      let buf = ''
      res.on('data', d => buf += d)
      res.on('end', () => { try { resolve(JSON.parse(buf)) } catch { resolve({ error: 'parse error' }) } })
    })
    req.on('error', e => resolve({ error: e.message }))
    req.end()
  })
}

// ── Tool definitions ──────────────────────────────────────
const TOOLS = [
  {
    name: 'get_dashboard_data',
    description: 'Fetch live data from the Ottaly dashboard API. Use type: metrics (per-workspace sends/replies/leads), health (client health scores and alerts), summary (30-day agency summary), intelligence (campaign-level data).',
    input_schema: {
      type: 'object',
      properties: { type: { type: 'string', enum: ['metrics', 'health', 'summary', 'intelligence'] } },
      required: ['type']
    }
  },
  {
    name: 'read_file',
    description: 'Read a file from the Ottaly repo. Path is relative to repo root (e.g. apps/admin-legacy/contacts.html or apps/admin-new/app/contacts/page.tsx).',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path']
    }
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file in the Ottaly repo. Path relative to repo root.',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content']
    }
  },
  {
    name: 'list_files',
    description: 'List files in a directory of the repo. Path relative to repo root.',
    input_schema: {
      type: 'object',
      properties: { dir_path: { type: 'string' } },
      required: ['dir_path']
    }
  },
  {
    name: 'run_git',
    description: 'Run a git command in the repo. Use for: status, add, commit, push, checkout, branch.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command']
    }
  },
  {
    name: 'save_brief',
    description: 'Save a brief/summary for other agents to read. Use when you have completed research or analysis that other agents should know about.',
    input_schema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content']
    }
  },
]

// ── Tool execution ────────────────────────────────────────
async function executeTool(toolName, toolInput, agentName) {
  try {
    switch (toolName) {
      case 'get_dashboard_data': {
        const today = new Date().toISOString().slice(0, 10)
        const thirty = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
        const endpoints = {
          metrics: '/api/metrics',
          health: '/api/health/clients',
          summary: `/api/stats/summary?start=${thirty}&end=${today}`,
          intelligence: '/api/campaigns/intelligence',
        }
        const data = await dashboardGet(endpoints[toolInput.type])
        // Trim series data to keep response manageable
        if (toolInput.type === 'intelligence' && data.workspaces) {
          data.workspaces = data.workspaces.map(ws => ({
            ...ws, series: undefined,
            campaigns: (ws.campaigns || []).map(c => ({ ...c, series: undefined }))
          }))
        }
        return JSON.stringify(data, null, 2)
      }

      case 'read_file': {
        ensureRepo()
        const fullPath = path.join(REPO_DIR, toolInput.file_path)
        if (!fullPath.startsWith(REPO_DIR)) return 'Error: path outside repo'
        if (!fs.existsSync(fullPath)) return `Error: file not found: ${toolInput.file_path}`
        const content = fs.readFileSync(fullPath, 'utf8')
        // Cap at 50k chars to avoid huge prompts
        return content.length > 50000 ? content.slice(0, 50000) + '\n... [truncated]' : content
      }

      case 'write_file': {
        ensureRepo()
        const fullPath = path.join(REPO_DIR, toolInput.file_path)
        if (!fullPath.startsWith(REPO_DIR)) return 'Error: path outside repo'
        fs.mkdirSync(path.dirname(fullPath), { recursive: true })
        fs.writeFileSync(fullPath, toolInput.content, 'utf8')
        return `Written: ${toolInput.file_path} (${toolInput.content.length} chars)`
      }

      case 'list_files': {
        ensureRepo()
        const fullPath = path.join(REPO_DIR, toolInput.dir_path)
        if (!fullPath.startsWith(REPO_DIR)) return 'Error: path outside repo'
        if (!fs.existsSync(fullPath)) return `Error: directory not found: ${toolInput.dir_path}`
        const entries = fs.readdirSync(fullPath, { withFileTypes: true })
        return entries.map(e => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`).join('\n')
      }

      case 'run_git': {
        ensureRepo()
        // Set git identity
        repoExec('git config user.email "agent@ottaly.co.uk"')
        repoExec('git config user.name "Ottaly Agent"')
        const result = repoExec(`git ${toolInput.command}`)
        return result || '(no output)'
      }

      case 'save_brief': {
        const briefFile = path.join(AGENTS_DIR, 'shared/brief-latest.md')
        const today = new Date().toISOString().slice(0, 10)
        fs.writeFileSync(briefFile, `# Latest Brief\nFrom: ${agentName} agent\nDate: ${today}\n\n${toolInput.content}`, 'utf8')
        return 'Brief saved.'
      }

      default:
        return `Unknown tool: ${toolName}`
    }
  } catch (err) {
    return `Error: ${err.message}`
  }
}

// ── Agentic loop (Claude with tools) ─────────────────────
async function runAgentLoop(systemPrompt, userMessage, agentName) {
  const messages = [{ role: 'user', content: userMessage }]
  const maxIterations = 10

  for (let i = 0; i < maxIterations; i++) {
    const body = JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    })

    const response = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, res => {
        let buf = ''
        res.on('data', d => buf += d)
        res.on('end', () => {
          try {
            const json = JSON.parse(buf)
            if (json.error) return reject(new Error(json.error.message))
            resolve(json)
          } catch (e) { reject(new Error('Bad API response: ' + buf.slice(0, 200))) }
        })
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })

    // If model is done, return the text
    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text')
      return textBlock?.text || ''
    }

    // Model wants to use tools
    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use')
      messages.push({ role: 'assistant', content: response.content })

      const toolResults = await Promise.all(toolUses.map(async tu => {
        console.log(`[${agentName}] Tool: ${tu.name}`, JSON.stringify(tu.input).slice(0, 100))
        const result = await executeTool(tu.name, tu.input, agentName)
        return { type: 'tool_result', tool_use_id: tu.id, content: result }
      }))

      messages.push({ role: 'user', content: toolResults })
      continue
    }

    // Unexpected stop reason
    const textBlock = response.content?.find(b => b.type === 'text')
    return textBlock?.text || ''
  }

  return 'Reached maximum tool iterations. Please try a more specific question.'
}

// ── Gemini (simple chat, no tools) ───────────────────────
function callGemini(systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: 2048 },
    })
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let buf = ''
      res.on('data', d => buf += d)
      res.on('end', () => {
        try {
          const json = JSON.parse(buf)
          if (json.error) return reject(new Error(json.error.message))
          resolve(json.candidates?.[0]?.content?.parts?.[0]?.text || '')
        } catch (e) { reject(new Error('Bad Gemini response: ' + buf.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── Agent file helpers ────────────────────────────────────
function readAgentFile(filePath, fallback = '') {
  try { return fs.readFileSync(filePath, 'utf8') } catch { return fallback }
}

function saveMemory(agentDir, line) {
  const memFile = path.join(agentDir, 'memory.md')
  let existing = readAgentFile(memFile, '')
  existing = existing.replace('No memories yet.\n', '').replace('No memories yet.', '')
  fs.writeFileSync(memFile, existing + line + '\n', 'utf8')
}

// ── Agent config — which agents use tools vs chat ─────────
// Tool agents: can read/write repo, fetch dashboard data, run git
// Chat agents: fast Gemini responses, no tool use
const TOOL_AGENTS = new Set(['build', 'ops', 'research', 'strategy'])

async function runAgent(agentName, userMessage) {
  const agentDir = path.join(AGENTS_DIR, agentName)
  const sharedDir = path.join(AGENTS_DIR, 'shared')

  const systemPromptRaw = readAgentFile(`${agentDir}/system-prompt.md`, `You are the Ottaly ${agentName} agent.`)
  const memory = readAgentFile(`${agentDir}/memory.md`, 'No memories yet.')
  const sharedContext = readAgentFile(`${sharedDir}/ottaly-context.md`, '')
  const latestBrief = readAgentFile(`${sharedDir}/brief-latest.md`, 'No brief yet.')

  const systemPrompt = `${systemPromptRaw}

## Shared Business Context
${sharedContext}

## Your Memory (grows over time)
${memory}

## Latest Brief from Other Agents
${latestBrief}

## Instructions
- Use your tools to get real data before answering — don't guess
- Be direct and concise in your final response
- If you learn something new or important, end your reply with: MEMORY: [what you learned]`

  let output
  if (TOOL_AGENTS.has(agentName)) {
    output = await runAgentLoop(systemPrompt, userMessage, agentName)
  } else {
    // Marketing and copy use Gemini (fast, cheap, great for writing)
    const geminiPrompt = `${systemPrompt}\n\nUser: ${userMessage}`
    output = await callGemini(systemPrompt, userMessage)
  }

  // Save memory if agent learned something
  const memoryMatch = output.match(/MEMORY:\s*(.+)/i)
  if (memoryMatch) {
    const today = new Date().toISOString().slice(0, 10)
    saveMemory(agentDir, `[${today}] — ${memoryMatch[1].trim()}`)
  }

  return output.replace(/\nMEMORY:.*$/im, '').trim()
}

// ── Agent channel config ──────────────────────────────────
const AGENT_BOTS = {
  ops:       { botToken: process.env.OPS_BOT_TOKEN,       appToken: process.env.OPS_APP_TOKEN,       channelId: process.env.OPS_CHANNEL_ID },
  build:     { botToken: process.env.BUILD_BOT_TOKEN,     appToken: process.env.BUILD_APP_TOKEN,     channelId: process.env.BUILD_CHANNEL_ID },
  marketing: { botToken: process.env.MARKETING_BOT_TOKEN, appToken: process.env.MARKETING_APP_TOKEN, channelId: process.env.MARKETING_CHANNEL_ID },
  copy:      { botToken: process.env.COPY_BOT_TOKEN,      appToken: process.env.COPY_APP_TOKEN,      channelId: process.env.COPY_CHANNEL_ID },
  research:  { botToken: process.env.RESEARCH_BOT_TOKEN,  appToken: process.env.RESEARCH_APP_TOKEN,  channelId: process.env.RESEARCH_CHANNEL_ID },
  strategy:  { botToken: process.env.STRATEGY_BOT_TOKEN,  appToken: process.env.STRATEGY_APP_TOKEN,  channelId: process.env.STRATEGY_CHANNEL_ID },
}

// ── Slack helpers ─────────────────────────────────────────
function verifySlack(rawBody, headers) {
  if (!SLACK_SIGNING_SECRET) return true
  const ts = headers['x-slack-request-timestamp']
  const sig = headers['x-slack-signature']
  if (!ts || !sig) return false
  if (Math.abs(Date.now() / 1000 - parseInt(ts)) > 300) return false
  const expected = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(`v0:${ts}:${rawBody}`).digest('hex')
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) } catch { return false }
}

function postToSlack(responseUrl, text) {
  const body = JSON.stringify({ response_type: 'in_channel', text })
  const url = new URL(responseUrl)
  const req = https.request({
    hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  })
  req.on('error', () => {})
  req.write(body)
  req.end()
}

function slackPost(botToken, method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: 'slack.com', path: `/api/${method}`, method: 'POST',
      headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let buf = ''
      res.on('data', d => buf += d)
      res.on('end', () => { try { resolve(JSON.parse(buf)) } catch { resolve({}) } })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// ── Socket Mode agent connection ──────────────────────────
const WebSocket = require('ws')
const processedEvents = new Set()

async function runAgentWithProgress(agentName, text, botToken, replyChannel, threadTs) {
  const isToolAgent = TOOL_AGENTS.has(agentName)
  const posted = await slackPost(botToken, 'chat.postMessage', {
    channel: replyChannel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: isToolAgent ? '_Thinking... (may use tools to get data)_' : '_Thinking..._',
  })
  const msgTs = posted.ts
  const update = txt => slackPost(botToken, 'chat.update', { channel: replyChannel, ts: msgTs, text: txt })

  const startedAt = Date.now()
  try {
    const reply = await runAgent(agentName, text)
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    await update(`${reply}\n\n_⏱ ${elapsed}s_`)
  } catch (err) {
    await update(`❌ Error: ${err.message.slice(0, 300)}`)
  }
}

function connectAgent(agentName, config) {
  if (!config.botToken || !config.appToken || !config.channelId) {
    console.log(`[${agentName}] Missing tokens — skipping`)
    return
  }

  let ws, pingInterval

  async function connect() {
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'slack.com', path: '/api/apps.connections.open', method: 'POST',
        headers: { 'Authorization': `Bearer ${config.appToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      }, res => {
        let buf = ''
        res.on('data', d => buf += d)
        res.on('end', () => resolve(JSON.parse(buf)))
      })
      req.on('error', reject)
      req.end()
    })

    if (!res.ok) { console.error(`[${agentName}] Connection failed:`, res.error); setTimeout(connect, 5000); return }

    ws = new WebSocket(res.url)
    ws.on('open', () => { console.log(`[${agentName}] Connected ✓`); pingInterval = setInterval(() => ws.ping(), 30000) })

    ws.on('message', async raw => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }))
      if (msg.type === 'disconnect') { cleanup(); setTimeout(connect, 1000); return }
      if (msg.type !== 'events_api') return

      const event = msg.payload?.event
      if (!event || event.type !== 'message' || event.bot_id || event.subtype || !event.text) return

      const isDM = event.channel_type === 'im'
      const isChannel = event.channel === config.channelId
      if (!isDM && !isChannel) return

      const eventKey = event.client_msg_id ?? event.ts
      if (processedEvents.has(eventKey)) return
      processedEvents.add(eventKey)
      if (processedEvents.size > 500) processedEvents.delete(processedEvents.values().next().value)

      const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim()
      if (!text) return

      console.log(`[${agentName}] "${text.slice(0, 80)}"`)
      await runAgentWithProgress(agentName, text, config.botToken, event.channel, isDM ? undefined : event.ts)
    })

    ws.on('close', () => { cleanup(); setTimeout(connect, 3000) })
    ws.on('error', err => console.error(`[${agentName}] WS error:`, err.message))
  }

  function cleanup() { clearInterval(pingInterval); try { ws.terminate() } catch {} }
  connect().catch(err => console.error(`[${agentName}] Fatal:`, err.message))
}

// ── /teach slash command ──────────────────────────────────
app.post('/slack/teach',
  express.raw({ type: 'application/x-www-form-urlencoded' }),
  async (req, res) => {
    const rawBody = req.body.toString()
    if (!verifySlack(rawBody, req.headers)) return res.status(401).send('Unauthorized')
    const params = Object.fromEntries(new URLSearchParams(rawBody))
    const { text, user_id, response_url } = params
    const match = text?.match(/^(\w+):\s*(.+)/)
    if (!match) return res.json({ response_type: 'ephemeral', text: 'Usage: /teach <agent>: <lesson>' })
    const [, agentName, lesson] = match
    if (!AGENT_BOTS[agentName]) return res.json({ response_type: 'ephemeral', text: `Unknown agent: ${agentName}` })
    res.json({ response_type: 'ephemeral', text: `📝 Teaching ${agentName}...` })
    const today = new Date().toISOString().slice(0, 10)
    saveMemory(path.join(AGENTS_DIR, agentName), `[${today}] — ${lesson.trim()}`)
    postToSlack(response_url, `<@${user_id}> ✅ ${agentName} will remember: _${lesson}_`)
  }
)

app.get('/health', (_, res) => res.json({ ok: true, agents: Object.keys(AGENT_BOTS) }))

// ── Start ─────────────────────────────────────────────────
Object.entries(AGENT_BOTS).forEach(([name, config]) => connectAgent(name, config))

// Pre-clone repo in background so build agent is ready
setTimeout(() => { try { ensureRepo() } catch (e) { console.error('[repo]', e.message) } }, 2000)

app.listen(PORT, () => console.log(`[agent] Running on port ${PORT}`))
