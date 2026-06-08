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

// Global build lock
let buildLock = false

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

// ── Agent runner with memory ──────────────────────────────
function runAgent(agentName, userMessage, timeoutMs = 120000) {
  const agentDir = path.join(AGENTS_DIR, agentName)
  const sharedDir = path.join(AGENTS_DIR, 'shared')

  // Read system prompt, memory, shared context
  const systemPrompt = fs.readFileSync(path.join(agentDir, 'system-prompt.md'), 'utf8')
  const memory = fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf8')
  const sharedContext = fs.readFileSync(path.join(sharedDir, 'ottaly-context.md'), 'utf8')
  const latestBrief = fs.readFileSync(path.join(sharedDir, 'brief-latest.md'), 'utf8')

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

---
## User message
${userMessage}

---
IMPORTANT:
1. Respond directly and helpfully.
2. At the very end of your response, if you learned something new or were corrected, append a MEMORY line like:
   MEMORY: [what you learned]
   This will be saved to your memory file automatically.`

  const output = sshMac(
    `ANTHROPIC_AUTH_TOKEN=${CLAUDE_AUTH_TOKEN} ${CLAUDE_PATH} --print --dangerously-skip-permissions --model ${CLAUDE_MODEL} ${JSON.stringify(fullPrompt)} 2>&1`,
    timeoutMs
  )

  // Extract and save memory if agent learned something
  const memoryMatch = output.match(/MEMORY:\s*(.+)/i)
  if (memoryMatch) {
    const today = new Date().toISOString().slice(0, 10)
    const newMemory = `[${today}] — ${memoryMatch[1].trim()}\n`
    const memFile = path.join(agentDir, 'memory.md')
    const existing = fs.readFileSync(memFile, 'utf8')
    const updated = existing.replace('No memories yet.\n', '') + newMemory
    fs.writeFileSync(memFile, updated, 'utf8')
  }

  // Strip the MEMORY line from the response shown to user
  return output.replace(/\nMEMORY:.*$/im, '').trim()
}

// ── Save brief for agent handoffs ─────────────────────────
function saveBrief(agentName, content) {
  const briefFile = path.join(AGENTS_DIR, 'shared/brief-latest.md')
  const today = new Date().toISOString().slice(0, 10)
  fs.writeFileSync(briefFile, `# Latest Brief\nFrom: ${agentName} agent\nDate: ${today}\n\n${content}`, 'utf8')
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

      res.json({ response_type: 'ephemeral', text: `💬 ${agentName} is thinking...` })

      try {
        const output = runAgent(agentName, text, 120000)
        if (saveBriefOnSuccess) saveBrief(agentName, output)
        postToSlack(response_url, `<@${user_id}> *${agentName}:*\n\n${output}`)
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
    const agentDir = path.join(AGENTS_DIR, agentName)
    if (!fs.existsSync(agentDir)) return res.json({ response_type: 'ephemeral', text: `Unknown agent: ${agentName}` })

    res.json({ response_type: 'ephemeral', text: `📝 Teaching ${agentName}...` })

    const today = new Date().toISOString().slice(0, 10)
    const memFile = path.join(agentDir, 'memory.md')
    const existing = fs.readFileSync(memFile, 'utf8')
    const updated = existing.replace('No memories yet.\n', '') + `[${today}] — ${lesson.trim()}\n`
    fs.writeFileSync(memFile, updated, 'utf8')

    postToSlack(response_url, `<@${user_id}> ✅ ${agentName} will remember: _${lesson}_`)
  }
)

app.get('/health', (_, res) => res.json({ ok: true }))

app.listen(PORT, () => console.log(`[agent] Running on port ${PORT}`))
