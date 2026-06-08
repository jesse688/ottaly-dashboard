'use strict'

require('dotenv').config()

const express = require('express')
const crypto = require('crypto')
const { execSync, exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const https = require('https')
const Anthropic = require('@anthropic-ai/sdk')

const app = express()
const PORT = process.env.PORT || 3100

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET
const GITHUB_REPO = process.env.GITHUB_REPO || 'https://github.com/jesse688/ottaly-dashboard.git'
const REPO_DIR = process.env.REPO_DIR || '/repo'
const VERCEL_PROJECT = 'ottaly-dashboard-admin-new'

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

// ── Repo setup ────────────────────────────────────────────
function ensureRepo() {
  if (!fs.existsSync(path.join(REPO_DIR, '.git'))) {
    console.log('[agent] Cloning repo...')
    execSync(`git clone ${GITHUB_REPO} ${REPO_DIR}`, { stdio: 'inherit' })
  }
  execSync(`git -C ${REPO_DIR} fetch origin`, { stdio: 'pipe' })
  execSync(`git -C ${REPO_DIR} checkout main`, { stdio: 'pipe' })
  execSync(`git -C ${REPO_DIR} pull origin main`, { stdio: 'pipe' })
  console.log('[agent] Repo ready')
}

// ── Tools ─────────────────────────────────────────────────
const tools = [
  {
    name: 'read_file',
    description: 'Read a file from the repo. Path relative to repo root e.g. apps/admin-new/app/campaigns/page.tsx',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to repo root' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file in the repo.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to repo root' },
        content: { type: 'string', description: 'Full file content' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_files',
    description: 'List files in a directory of the repo.',
    input_schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directory path relative to repo root' }
      },
      required: ['dir']
    }
  },
  {
    name: 'run_command',
    description: 'Run a safe shell command in the repo directory. Only git, ls, cat, grep allowed.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run' }
      },
      required: ['command']
    }
  }
]

function executeTool(name, input) {
  const fullPath = p => path.join(REPO_DIR, p.replace(/^\//, ''))

  if (name === 'read_file') {
    try {
      return fs.readFileSync(fullPath(input.path), 'utf8')
    } catch (e) {
      return `Error: ${e.message}`
    }
  }

  if (name === 'write_file') {
    try {
      const fp = fullPath(input.path)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.writeFileSync(fp, input.content, 'utf8')
      return `Written: ${input.path}`
    } catch (e) {
      return `Error: ${e.message}`
    }
  }

  if (name === 'list_files') {
    try {
      const entries = fs.readdirSync(fullPath(input.dir), { withFileTypes: true })
      return entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n')
    } catch (e) {
      return `Error: ${e.message}`
    }
  }

  if (name === 'run_command') {
    const allowed = /^(git |ls |cat |grep |find )/
    if (!allowed.test(input.command)) return 'Error: command not allowed'
    try {
      return execSync(input.command, { cwd: REPO_DIR, encoding: 'utf8', timeout: 30000 })
    } catch (e) {
      return `Error: ${e.message}`
    }
  }

  return 'Unknown tool'
}

// ── Agent loop ────────────────────────────────────────────
async function runAgent(instruction, onProgress) {
  // Fresh branch for this task
  const branch = `agent/${Date.now()}`
  execSync(`git -C ${REPO_DIR} checkout main`, { stdio: 'pipe' })
  execSync(`git -C ${REPO_DIR} pull origin main`, { stdio: 'pipe' })
  execSync(`git -C ${REPO_DIR} checkout -b ${branch}`, { stdio: 'pipe' })

  const messages = [{ role: 'user', content: instruction }]

  const system = `You are the Ottaly code agent. You fix and improve the Ottaly admin dashboard.
The repo is at ${REPO_DIR}. The new Next.js dashboard is at apps/admin-new/.
The legacy Express app is at apps/admin-legacy/ — DO NOT touch it unless explicitly asked.

When making changes:
1. Read the relevant files first to understand the current code
2. Make focused, minimal changes
3. Don't break existing functionality
4. Use TypeScript strict mode
5. Follow the existing code style

After making all changes, summarise exactly what you changed and why.`

  let iterations = 0
  const MAX = 20

  while (iterations < MAX) {
    iterations++
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8096,
      system,
      tools,
      messages,
    })

    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find(b => b.type === 'text')?.text ?? 'Done'
      return { summary: text, branch }
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        onProgress(`Using tool: ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`)
        const result = executeTool(block.name, block.input)
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: String(result).slice(0, 10000) })
      }
      messages.push({ role: 'user', content: toolResults })
    }
  }

  return { summary: 'Max iterations reached', branch }
}

// ── Git push + Vercel preview ─────────────────────────────
async function pushAndGetPreview(branch) {
  execSync(`git -C ${REPO_DIR} add -A`, { stdio: 'pipe' })
  const status = execSync(`git -C ${REPO_DIR} status --porcelain`, { encoding: 'utf8' })
  if (!status.trim()) return { pushed: false, previewUrl: null }

  execSync(`git -C ${REPO_DIR} commit -m "agent: ${branch.replace('agent/', '')}"`, { stdio: 'pipe' })
  execSync(`git -C ${REPO_DIR} push origin ${branch}`, { stdio: 'pipe' })

  // Vercel auto-deploys branches — preview URL is predictable
  const previewUrl = `https://${VERCEL_PROJECT}-git-${branch.replace('/', '-').replace('_', '-')}-teamottaly.vercel.app`
  return { pushed: true, previewUrl }
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
  req.write(body)
  req.end()
}

// ── Routes ────────────────────────────────────────────────
app.post('/slack/build',
  express.raw({ type: 'application/x-www-form-urlencoded' }),
  async (req, res) => {
    const rawBody = req.body.toString()
    if (!verifySlack(rawBody, req.headers)) return res.status(401).send('Unauthorized')

    const params = Object.fromEntries(new URLSearchParams(rawBody))
    const { text, user_id, response_url } = params

    if (!text) return res.json({ response_type: 'ephemeral', text: 'Usage: /build <instruction>' })

    res.json({ response_type: 'ephemeral', text: `⚙️ Working on: _${text}_` })

    try {
      const messages = []
      const { summary, branch } = await runAgent(text, msg => messages.push(msg))
      const { pushed, previewUrl } = await pushAndGetPreview(branch)

      if (!pushed) {
        postToSlack(response_url, `<@${user_id}> No changes were made for: _${text}_\n\n${summary}`)
        return
      }

      postToSlack(response_url,
        `<@${user_id}> ✅ Done: _${text}_\n\n${summary}\n\n🔗 Preview: ${previewUrl}\n\nReview and merge when happy.`
      )
    } catch (err) {
      console.error('[agent] Error:', err)
      postToSlack(response_url, `<@${user_id}> ❌ Error: ${err.message}`)
    }
  }
)

app.get('/health', (_, res) => res.json({ ok: true }))

// ── Start ─────────────────────────────────────────────────
ensureRepo()
app.listen(PORT, () => console.log(`[agent] Running on port ${PORT}`))
