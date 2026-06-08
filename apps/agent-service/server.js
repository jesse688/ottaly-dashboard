'use strict'

require('dotenv').config()

const express = require('express')
const crypto = require('crypto')
const { execSync } = require('child_process')
const https = require('https')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3100

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET
const CLAUDE_AUTH_TOKEN = process.env.CLAUDE_AUTH_TOKEN || ''
const MAC_USER = process.env.MAC_USER || 'jesse'
const MAC_HOST = process.env.MAC_HOST || '46.38.255.178'
const MAC_REPO = process.env.MAC_REPO || '/Users/jesse/Desktop/ottaly-dashboard'
const CLAUDE_PATH = process.env.CLAUDE_PATH || '/Users/jesse/.nvm/versions/node/v24.11.1/bin/claude'
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'
const VERCEL_PROJECT = 'ottaly-dashboard-admin-new'
const AGENTS_DIR = path.join(MAC_REPO, 'apps/agent-service/agents')
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://admin.ottaly.co.uk'
const DASHBOARD_KEY = process.env.ADMIN_KEY || 'Ottaly2025$'

// Global build lock
let buildLock = false

// ── Dashboard API helper ──────────────────────────────────
function dashboardGet(apiPath) {
  return new Promise((resolve) => {
    const url = new URL(DASHBOARD_URL + apiPath)
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'x-admin-key': DASHBOARD_KEY, 'Accept': 'application/json' }
    }
    const req = https.request(options, res => {
      let buf = ''
      res.on('data', d => buf += d)
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) } catch { resolve({ error: 'parse error', raw: buf.slice(0, 200) }) }
      })
    })
    req.on('error', e => resolve({ error: e.message }))
    req.end()
  })
}

// ── Agent channel config ──────────────────────────────────
// Each agent has its own Slack bot token + app token + channel
const AGENT_BOTS = {
  ops: {
    botToken:  process.env.OPS_BOT_TOKEN,
    appToken:  process.env.OPS_APP_TOKEN,
    channelId: process.env.OPS_CHANNEL_ID,
  },
  build: {
    botToken:  process.env.BUILD_BOT_TOKEN,
    appToken:  process.env.BUILD_APP_TOKEN,
    channelId: process.env.BUILD_CHANNEL_ID,
  },
  marketing: {
    botToken:  process.env.MARKETING_BOT_TOKEN,
    appToken:  process.env.MARKETING_APP_TOKEN,
    channelId: process.env.MARKETING_CHANNEL_ID,
  },
  copy: {
    botToken:  process.env.COPY_BOT_TOKEN,
    appToken:  process.env.COPY_APP_TOKEN,
    channelId: process.env.COPY_CHANNEL_ID,
  },
  research: {
    botToken:  process.env.RESEARCH_BOT_TOKEN,
    appToken:  process.env.RESEARCH_APP_TOKEN,
    channelId: process.env.RESEARCH_CHANNEL_ID,
  },
  strategy: {
    botToken:  process.env.STRATEGY_BOT_TOKEN,
    appToken:  process.env.STRATEGY_APP_TOKEN,
    channelId: process.env.STRATEGY_CHANNEL_ID,
  },
}

// ── SSH helper ────────────────────────────────────────────
function sshMac(command, timeoutMs = 120000) {
  const scriptFile = `/tmp/ssh-cmd-${Date.now()}.sh`
  fs.writeFileSync(scriptFile, command, 'utf8')
  try {
    return execSync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=40 -p 2222 ${MAC_USER}@${MAC_HOST} 'bash -s' < ${scriptFile}`,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    )
  } finally {
    try { fs.unlinkSync(scriptFile) } catch {}
  }
}

// ── Fetch live data for ops agent ────────────────────────
async function fetchOpsData() {
  const today = new Date().toISOString().slice(0, 10)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)

  const [metrics, health, summary, intelligence] = await Promise.all([
    dashboardGet('/api/metrics'),
    dashboardGet('/api/health/clients'),
    dashboardGet(`/api/stats/summary?start=${thirtyDaysAgo}&end=${today}`),
    dashboardGet('/api/campaigns/intelligence'),
  ])
  return { metrics, health, summary, intelligence }
}

// ── Agent runner with memory ──────────────────────────────
async function runAgent(agentName, userMessage, timeoutMs = 120000) {
  const agentDir = path.join(AGENTS_DIR, agentName)
  const sharedDir = path.join(AGENTS_DIR, 'shared')

  // Read agent files from Mac via SSH (so memory persists across deploys)
  const systemPrompt = sshMac(`cat ${agentDir}/system-prompt.md`)
  const memory = sshMac(`cat ${agentDir}/memory.md`)
  const sharedContext = sshMac(`cat ${sharedDir}/ottaly-context.md`)
  const latestBrief = sshMac(`cat ${sharedDir}/brief-latest.md`)

  // Fetch live data for ops agent — trim to key fields only to keep prompt size manageable
  let liveData = ''
  if (agentName === 'ops') {
    try {
      const data = await fetchOpsData()

      // Strip daily series from intelligence (too verbose), keep totals + campaigns
      const trimmedIntelligence = (data.intelligence?.workspaces || []).map(ws => ({
        id: ws.id, name: ws.name, avgReplyRate: ws.avgReplyRate,
        campaigns: (ws.campaigns || []).map(c => ({
          name: c.name, status: c.status, sent: c.sent, replies: c.replies,
          leads: c.leads, replyRate: c.replyRate, tier: c.tier, flags: c.flags,
        }))
      }))

      // Strip daily series from summary
      const trimmedSummary = (data.summary?.workspaces || []).map(ws => ({
        name: ws.name, workspace_id: ws.workspace_id, totals: ws.totals
      }))

      liveData = `\n---\n## Live Dashboard Data (fetched right now)\n\n### Per-Workspace Metrics\n${JSON.stringify(data.metrics?.workspaces || data.metrics, null, 2)}\n\n### Client Health\n${JSON.stringify(data.health?.clients || data.health, null, 2)}\n\n### 30-Day Summary (totals only)\n${JSON.stringify(trimmedSummary, null, 2)}\n\n### Campaign Intelligence\n${JSON.stringify(trimmedIntelligence, null, 2)}\n`
    } catch (e) {
      liveData = `\n---\n## Live Data\nFailed to fetch: ${e.message}\n`
    }
  }

  const fullPrompt = `${systemPrompt}

---
## Shared Business Context
${sharedContext}

---
## Your Memory (what you've learned over time)
${memory}

---
## Latest Brief (from other agents)
${latestBrief}
${liveData}
---
## User message
${userMessage}

---
IMPORTANT:
1. Respond directly and helpfully using the live data above.
2. At the very end of your response, if you learned something new or were corrected, append a MEMORY line like:
   MEMORY: [what you learned]
   This will be saved to your memory file automatically.`

  // Write prompt to a temp file on the Mac to avoid shell arg size limits
  const tmpPrompt = `/tmp/agent-prompt-${agentName}-${Date.now()}.txt`
  sshMac(`cat > ${tmpPrompt} << 'PROMPT_EOF_MARKER'\n${fullPrompt.replace(/PROMPT_EOF_MARKER/g, 'PROMPT_EOF_MARKER_ESC')}\nPROMPT_EOF_MARKER`)

  const output = sshMac(
    `ANTHROPIC_AUTH_TOKEN=${CLAUDE_AUTH_TOKEN} timeout 90 ${CLAUDE_PATH} --print --dangerously-skip-permissions --model ${CLAUDE_MODEL} "$(cat ${tmpPrompt})" 2>&1; rm -f ${tmpPrompt}`,
    timeoutMs
  )

  // Extract and save memory if agent learned something
  const memoryMatch = output.match(/MEMORY:\s*(.+)/i)
  if (memoryMatch) {
    const today = new Date().toISOString().slice(0, 10)
    const newMemory = `[${today}] — ${memoryMatch[1].trim()}`
    const memFile = path.join(agentDir, 'memory.md')
    sshMac(`echo ${JSON.stringify(newMemory)} >> ${memFile} && sed -i '' 's/No memories yet.//' ${memFile} 2>/dev/null || true`)
  }

  // Strip the MEMORY line from the response shown to user
  return output.replace(/\nMEMORY:.*$/im, '').trim()
}

// ── Save brief for agent handoffs ─────────────────────────
function saveBrief(agentName, content) {
  const briefFile = path.join(AGENTS_DIR, 'shared/brief-latest.md')
  const today = new Date().toISOString().slice(0, 10)
  const briefContent = `# Latest Brief\nFrom: ${agentName} agent\nDate: ${today}\n\n${content}`
  sshMac(`cat > ${briefFile} << 'BRIEF_EOF'\n${briefContent}\nBRIEF_EOF`)
}

// ── Page map for /build ───────────────────────────────────
const PAGE_MAP = {
  contacts:         { legacy: 'contacts.html',       new: 'app/contacts/page.tsx' },
  stats:            { legacy: 'stats.html',           new: 'app/stats/page.tsx' },
  clients:          { legacy: 'clients.html',         new: 'app/clients/page.tsx' },
  finance:          { legacy: 'finance.html',         new: 'app/finance/page.tsx' },
  domains:          { legacy: 'domains.html',         new: 'app/domains/page.tsx' },
  mailboxes:        { legacy: 'mailboxes.html',       new: 'app/mailboxes/page.tsx' },
  capacity:         { legacy: 'capacity.html',        new: 'app/capacity/page.tsx' },
  'leads-analysis': { legacy: 'leads-analysis.html', new: 'app/leads-analysis/page.tsx' },
  'combo-analysis': { legacy: 'combo-analysis.html', new: 'app/combo-analysis/page.tsx' },
  actions:          { legacy: 'actions.html',         new: 'app/actions/page.tsx' },
  'apollo-prep':    { legacy: 'apollo-prep.html',     new: 'app/apollo-prep/page.tsx' },
  'verify-split':   { legacy: 'verify-split.html',   new: 'app/verify-split/page.tsx' },
  copy:             { legacy: 'copy.html',            new: 'app/copy/page.tsx' },
  audience:         { legacy: 'icp.html',             new: 'app/audience/page.tsx' },
  diagnostics:      { legacy: 'diagnostics.html',    new: 'app/diagnostics/page.tsx' },
  intelligence:     { legacy: 'intelligence.html',   new: 'app/intelligence/page.tsx' },
  workload:         { legacy: 'workload.html',        new: 'app/workload/page.tsx' },
  commission:       { legacy: 'commission.html',      new: 'app/commission/page.tsx' },
  metrics:          { legacy: 'metrics.html',         new: 'app/metrics/page.tsx' },
  health:           { legacy: 'health.html',          new: 'app/health/page.tsx' },
}

async function buildPage(pageName, responseUrl, userId) {
  const page = PAGE_MAP[pageName]
  if (!page) { postToSlack(responseUrl, `<@${userId}> ❌ Unknown page: ${pageName}`); return false }

  try {
    const branch = `agent/${pageName}-${Date.now()}`
    sshMac(`cd ${MAC_REPO} && git reset --hard HEAD && git clean -fd && git checkout main && git reset --hard origin/main && git checkout -b ${branch}`)

    const instruction = `Read ${MAC_REPO}/apps/admin-legacy/${page.legacy} thoroughly. Then rebuild ${MAC_REPO}/apps/admin-new/${page.new} to match the same functionality using Next.js, TypeScript, shadcn/ui and Tailwind. Work only in apps/admin-new. Summarise changes at the end.`

    const claudeOutput = sshMac(
      `cd ${MAC_REPO} && ANTHROPIC_AUTH_TOKEN=${CLAUDE_AUTH_TOKEN} ${CLAUDE_PATH} --print --dangerously-skip-permissions --model ${CLAUDE_MODEL} ${JSON.stringify(instruction)} 2>&1`,
      600000
    )

    const status = sshMac(`cd ${MAC_REPO} && git status --porcelain`)
    if (!status.trim()) { postToSlack(responseUrl, `<@${userId}> ⚠️ No changes for *${pageName}*`); return false }

    sshMac(`cd ${MAC_REPO} && git add -A && git commit -m "agent: rebuild ${pageName} page" && git push origin ${branch}`)

    const slug = branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
    const previewUrl = `https://${VERCEL_PROJECT}-git-${slug}-teamottaly.vercel.app`
    postToSlack(responseUrl, `<@${userId}> ✅ *${pageName}* done\n${claudeOutput.slice(-600)}\n\n🔗 ${previewUrl}`)
    return true
  } catch (err) {
    postToSlack(responseUrl, `<@${userId}> ❌ *${pageName}* failed: ${err.message.slice(0, 200)}`)
    return false
  }
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
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  })
  req.on('error', () => {})
  req.write(body)
  req.end()
}

// ── Route factory for simple agents ──────────────────────
function slackAgent(agentName, path_, saveBriefOnSuccess = false) {
  app.post(path_,
    express.raw({ type: 'application/x-www-form-urlencoded' }),
    async (req, res) => {
      const rawBody = req.body.toString()
      if (!verifySlack(rawBody, req.headers)) return res.status(401).send('Unauthorized')

      const params = Object.fromEntries(new URLSearchParams(rawBody))
      const { text, user_id, response_url } = params

      if (!text) return res.json({ response_type: 'ephemeral', text: `Usage: /${agentName} <message>` })

      const startedAt = Date.now()
      postToSlack(response_url, `<@${user_id}> _Step 1/3 — Reading memory..._`)

      try {
        postToSlack(response_url, `<@${user_id}> _Step 2/3 — Fetching live data..._`)
        postToSlack(response_url, `<@${user_id}> _Step 3/3 — Thinking... (~30–60s)_`)
        const output = await runAgent(agentName, text, 120000)
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        if (saveBriefOnSuccess) saveBrief(agentName, output)
        postToSlack(response_url, `<@${user_id}> *${agentName}:*\n\n${output}\n\n_⏱ ${elapsed}s_`)
      } catch (err) {
        postToSlack(response_url, `<@${user_id}> ❌ ${agentName} error: ${err.message.slice(0, 300)}`)
      }
    }
  )
}

// ── Register all agents ───────────────────────────────────
slackAgent('ops',       '/slack/ops')
slackAgent('marketing', '/slack/marketing')
slackAgent('copy',      '/slack/copy')
slackAgent('research',  '/slack/research', true) // saves brief for handoff
slackAgent('strategy',  '/slack/strategy')

// ── /build — single code task ─────────────────────────────
app.post('/slack/build',
  express.raw({ type: 'application/x-www-form-urlencoded' }),
  async (req, res) => {
    const rawBody = req.body.toString()
    if (!verifySlack(rawBody, req.headers)) return res.status(401).send('Unauthorized')

    const params = Object.fromEntries(new URLSearchParams(rawBody))
    const { text, user_id, response_url } = params

    if (!text) return res.json({ response_type: 'ephemeral', text: 'Usage: /build <instruction>' })
    if (buildLock) return res.json({ response_type: 'ephemeral', text: '⚠️ A build is already running.' })

    res.json({ response_type: 'ephemeral', text: `⚙️ Working on: _${text}_` })

    buildLock = true
    try {
      const branch = `agent/${Date.now()}`
      sshMac(`cd ${MAC_REPO} && git reset --hard HEAD && git clean -fd && git checkout main && git reset --hard origin/main && git checkout -b ${branch}`)

      const fullInstruction = `${text}. Work only in ${MAC_REPO}/apps/admin-new. Read the equivalent legacy HTML in ${MAC_REPO}/apps/admin-legacy first. Summarise changes at the end.`
      const claudeOutput = sshMac(
        `cd ${MAC_REPO} && ANTHROPIC_AUTH_TOKEN=${CLAUDE_AUTH_TOKEN} ${CLAUDE_PATH} --print --dangerously-skip-permissions --model ${CLAUDE_MODEL} ${JSON.stringify(fullInstruction)} 2>&1`,
        600000
      )

      const status = sshMac(`cd ${MAC_REPO} && git status --porcelain`)
      if (!status.trim()) {
        postToSlack(response_url, `<@${user_id}> No changes made for: _${text}_\n\n${claudeOutput.slice(0, 500)}`)
        return
      }

      sshMac(`cd ${MAC_REPO} && git add -A && git commit -m "agent: ${branch.replace('agent/', '')}" && git push origin ${branch}`)
      const slug = branch.replace('agent/', 'agent-').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
      const previewUrl = `https://${VERCEL_PROJECT}-git-${slug}-teamottaly.vercel.app`
      postToSlack(response_url, `<@${user_id}> ✅ Done: _${text}_\n\n${claudeOutput.slice(-1500)}\n\n🔗 Preview: ${previewUrl}`)
    } catch (err) {
      postToSlack(response_url, `<@${user_id}> ❌ Error: ${err.message.slice(0, 300)}`)
    } finally {
      buildLock = false
    }
  }
)

// ── /buildall — queue multiple pages ─────────────────────
app.post('/slack/buildall',
  express.raw({ type: 'application/x-www-form-urlencoded' }),
  async (req, res) => {
    const rawBody = req.body.toString()
    if (!verifySlack(rawBody, req.headers)) return res.status(401).send('Unauthorized')

    const params = Object.fromEntries(new URLSearchParams(rawBody))
    const { text, user_id, response_url } = params
    const pages = text ? text.split(',').map(p => p.trim().toLowerCase()) : Object.keys(PAGE_MAP)

    if (buildLock) return res.json({ response_type: 'ephemeral', text: '⚠️ A build is already running.' })

    res.json({ response_type: 'in_channel', text: `⚙️ <@${user_id}> Queuing *${pages.length} pages*: ${pages.join(', ')}` })

    buildLock = true
    let done = 0, failed = 0
    try {
      for (const page of pages) {
        const ok = await buildPage(page, response_url, user_id)
        if (ok) done++; else failed++
      }
    } finally {
      buildLock = false
    }
    postToSlack(response_url, `<@${user_id}> 🏁 All done: *${done} built*, *${failed} failed*`)
  }
)

// ── /teach — teach an agent something new ────────────────
app.post('/slack/teach',
  express.raw({ type: 'application/x-www-form-urlencoded' }),
  async (req, res) => {
    const rawBody = req.body.toString()
    if (!verifySlack(rawBody, req.headers)) return res.status(401).send('Unauthorized')

    const params = Object.fromEntries(new URLSearchParams(rawBody))
    const { text, user_id, response_url } = params

    // Format: /teach ops: don't include Tristan's workspace in reports
    const match = text?.match(/^(\w+):\s*(.+)/)
    if (!match) return res.json({ response_type: 'ephemeral', text: 'Usage: /teach <agent>: <what to remember>' })

    const [, agentName, lesson] = match
    const validAgents = Object.keys(AGENT_BOTS)
    if (!validAgents.includes(agentName)) return res.json({ response_type: 'ephemeral', text: `Unknown agent: ${agentName}. Valid: ${validAgents.join(', ')}` })

    res.json({ response_type: 'ephemeral', text: `📝 Teaching ${agentName}...` })

    const today = new Date().toISOString().slice(0, 10)
    const memFile = path.join(AGENTS_DIR, agentName, 'memory.md')
    const newLine = `[${today}] — ${lesson.trim()}`
    sshMac(`grep -qF 'No memories yet.' ${memFile} && sed -i '' 's/No memories yet.//' ${memFile} 2>/dev/null; echo ${JSON.stringify(newLine)} >> ${memFile}`)

    postToSlack(response_url, `<@${user_id}> ✅ ${agentName} will remember: _${lesson}_`)
  }
)

app.get('/health', (_, res) => res.json({ ok: true }))

// ── Progress updater ──────────────────────────────────────
// Posts a message then updates it through steps so Jesse can see what's happening
async function runAgentWithProgress(agentName, text, botToken, replyChannel, threadTs) {
  const steps = [
    { text: '_Step 1/3 — Reading memory & context..._', delay: 0 },
    { text: '_Step 2/3 — Fetching live dashboard data..._', delay: 0 },
    { text: `_Step 3/3 — Thinking... (usually 30–60s)_`, delay: 0 },
  ]

  // Post initial message
  const posted = await slackPost(botToken, 'chat.postMessage', {
    channel: replyChannel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: steps[0].text,
  })
  const msgTs = posted.ts

  const update = (txt) => slackPost(botToken, 'chat.update', {
    channel: replyChannel,
    ts: msgTs,
    text: txt,
  })

  // Step 1: reading files (happens inside runAgent, just show it)
  const startedAt = Date.now()

  // Step 2: fetching data — update before the await
  await update(steps[1].text)
  await new Promise(r => setTimeout(r, 300))

  // Step 3: running claude
  await update(steps[2].text)

  try {
    const reply = await runAgent(agentName, text, 120000)
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    await update(`${reply}\n\n_⏱ ${elapsed}s_`)
  } catch (err) {
    await update(`❌ Error: ${err.message.slice(0, 200)}`)
  }
}

// ── Socket Mode bot per agent ─────────────────────────────
const WebSocket = require('ws')
const processedEvents = new Set()

function slackPost(botToken, method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: 'slack.com',
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let buf = ''
      res.on('data', d => buf += d)
      res.on('end', () => resolve(JSON.parse(buf)))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
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
        hostname: 'slack.com',
        path: '/api/apps.connections.open',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.appToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }, res => {
        let buf = ''
        res.on('data', d => buf += d)
        res.on('end', () => resolve(JSON.parse(buf)))
      })
      req.on('error', reject)
      req.end()
    })

    if (!res.ok) {
      console.error(`[${agentName}] Connection failed:`, res.error)
      setTimeout(connect, 5000)
      return
    }

    ws = new WebSocket(res.url)

    ws.on('open', () => {
      console.log(`[${agentName}] Connected ✓`)
      pingInterval = setInterval(() => ws.ping(), 30000)
    })

    ws.on('message', async raw => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }

      if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }))
      if (msg.type === 'disconnect') { cleanup(); setTimeout(connect, 1000); return }
      if (msg.type !== 'events_api') return

      const event = msg.payload?.event
      if (!event || event.type !== 'message') return
      if (event.bot_id || event.subtype) return
      if (!event.text) return
      // Accept messages from the configured channel OR any DM (channel_type = 'im')
      const isDM = event.channel_type === 'im'
      const isChannel = event.channel === config.channelId
      if (!isDM && !isChannel) return

      const eventKey = event.client_msg_id ?? event.ts
      if (processedEvents.has(eventKey)) return
      processedEvents.add(eventKey)
      if (processedEvents.size > 500) processedEvents.delete(processedEvents.values().next().value)

      const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim()
      if (!text) return

      console.log(`[${agentName}] Message: "${text.slice(0, 80)}"`)

      // For DMs reply in same channel, for channels reply in thread
      const replyChannel = event.channel
      const threadTs = isDM ? undefined : event.ts

      await runAgentWithProgress(agentName, text, config.botToken, replyChannel, threadTs)
    })

    ws.on('close', () => { cleanup(); setTimeout(connect, 3000) })
    ws.on('error', err => console.error(`[${agentName}] WS error:`, err.message))
  }

  function cleanup() {
    clearInterval(pingInterval)
    try { ws.terminate() } catch {}
  }

  connect().catch(err => console.error(`[${agentName}] Fatal:`, err.message))
}

// Start all configured agent bots
Object.entries(AGENT_BOTS).forEach(([name, config]) => connectAgent(name, config))

app.listen(PORT, () => console.log(`[agent] Running on port ${PORT}`))
