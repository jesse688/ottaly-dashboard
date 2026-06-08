'use strict'

require('dotenv').config()

const express = require('express')
const crypto = require('crypto')
const { execSync } = require('child_process')
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
const DASHBOARD_LOGIN = process.env.DASHBOARD_LOGIN || 'admin@ottaly.co.uk'
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'Ottaly2025$'

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

// Pages to test on every preview — path and what to verify
const TEST_PAGES = [
  { path: '/campaigns', name: 'Campaigns' },
  { path: '/contacts', name: 'Contacts' },
  { path: '/leads', name: 'Leads' },
  { path: '/clients', name: 'Clients' },
  { path: '/mailboxes', name: 'Mailboxes' },
  { path: '/domains', name: 'Domains' },
  { path: '/health', name: 'Health' },
  { path: '/finance', name: 'Finance' },
  { path: '/stats', name: 'Stats' },
]

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
    description: 'Read a file from the repo. Path relative to repo root e.g. apps/admin-new/app/campaigns/page.tsx or apps/admin-legacy/campaigns.html',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file in the repo.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_files',
    description: 'List files in a directory of the repo.',
    input_schema: {
      type: 'object',
      properties: { dir: { type: 'string' } },
      required: ['dir']
    }
  },
  {
    name: 'run_command',
    description: 'Run a safe read-only shell command in the repo directory.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command']
    }
  }
]

function executeTool(name, input) {
  const fullPath = p => path.join(REPO_DIR, p.replace(/^\//, ''))

  if (name === 'read_file') {
    try { return fs.readFileSync(fullPath(input.path), 'utf8') }
    catch (e) { return `Error: ${e.message}` }
  }

  if (name === 'write_file') {
    try {
      const fp = fullPath(input.path)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.writeFileSync(fp, input.content, 'utf8')
      return `Written: ${input.path}`
    } catch (e) { return `Error: ${e.message}` }
  }

  if (name === 'list_files') {
    try {
      const entries = fs.readdirSync(fullPath(input.dir), { withFileTypes: true })
      return entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n')
    } catch (e) { return `Error: ${e.message}` }
  }

  if (name === 'run_command') {
    const allowed = /^(git |ls |cat |grep |find )/
    if (!allowed.test(input.command)) return 'Error: command not allowed'
    try {
      return execSync(input.command, { cwd: REPO_DIR, encoding: 'utf8', timeout: 30000 })
    } catch (e) { return `Error: ${e.message}` }
  }

  return 'Unknown tool'
}

// ── Agent loop ────────────────────────────────────────────
async function runAgent(instruction) {
  const branch = `agent/${Date.now()}`
  execSync(`git -C ${REPO_DIR} checkout main`, { stdio: 'pipe' })
  execSync(`git -C ${REPO_DIR} pull origin main`, { stdio: 'pipe' })
  execSync(`git -C ${REPO_DIR} checkout -b ${branch}`, { stdio: 'pipe' })

  const messages = [{ role: 'user', content: instruction }]

  const system = `You are the Ottaly code agent. You build and fix the Ottaly admin dashboard.

REPO: ${REPO_DIR}
- New Next.js dashboard: apps/admin-new/ — this is what you work on
- Legacy Express app: apps/admin-legacy/ — READ this to understand what to build, DO NOT modify it

IMPORTANT: Always read the legacy HTML file first (e.g. apps/admin-legacy/campaigns.html) to understand
what the page does, what data it shows, and what interactions it has. Then build/fix the new version
to match the same functionality.

TECH STACK (apps/admin-new):
- Next.js 16 App Router, TypeScript strict mode, no 'any'
- shadcn/ui components (Button, Table, Input, Select, Card, Badge, etc.)
- Tailwind CSS v4
- PostgreSQL via lib/db.ts (pool.query)
- Auth: JWT session cookie

DESIGN RULES:
- Clean, fast, easy to navigate — professional agency tool
- Header: white bg, border-b, px-6 py-4, h1 text-xl font-semibold text-gray-900
- Tables: shadcn Table component, hover:bg-gray-50 on rows
- Loading: skeleton pulse animation (h-4 bg-gray-100 rounded animate-pulse)
- Filters: white border-b bar below header with gap-3 flex
- Pagination: bottom, Previous/Next buttons, show total count
- Empty states: centered py-12 text-gray-500
- No emojis unless already on that page

DATABASE TABLES:
- esp_workspaces, esp_campaigns, esp_leads, esp_analytics (PlusVibe sync)
- contacts, email_events, health_actions, client_verticals, managers, transactions

CLIENTS (28 workspaces): Ottaly, AccrueAccounting, Volancy, FleetSauce, Stribe, Indigo,
PPC, JMC Accountants, HydrationCompany, Rural & Country, TangerineTax, Jumping Spider,
Josh-Commercial Flooring, Enviro, Animo, GGRS, ButterflyEco, GXI, GXI-Furniture,
Bruud, MagnaMoney, Bubble, Lending Team, Meades Group, MDH, ShireRecoveries, LVM, ButterflyEco SOP

RULES:
1. Read legacy HTML first to understand the feature
2. Read the existing new page before editing it
3. Make focused, minimal changes
4. Follow existing code style exactly
5. After all changes, return a clear summary table of what changed and why
6. Stop after the summary — do not make further edits`

  let iterations = 0
  while (iterations < 20) {
    iterations++
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
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
        const result = executeTool(block.name, block.input)
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: String(result).slice(0, 10000) })
      }
      messages.push({ role: 'user', content: toolResults })
    }
  }

  return { summary: 'Max iterations reached', branch }
}

// ── Git push ──────────────────────────────────────────────
function pushBranch(branch) {
  execSync(`git -C ${REPO_DIR} add -A`, { stdio: 'pipe' })
  const status = execSync(`git -C ${REPO_DIR} status --porcelain`, { encoding: 'utf8' })
  if (!status.trim()) return false
  execSync(`git -C ${REPO_DIR} commit -m "agent: ${branch.replace('agent/', '')}"`, { stdio: 'pipe' })
  execSync(`git -C ${REPO_DIR} push origin ${branch}`, { stdio: 'pipe' })
  return true
}

function branchToPreviewUrl(branch) {
  // Vercel preview URL format: project-git-branch-team.vercel.app
  const slug = branch.replace('agent/', 'agent-').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  return `https://${VERCEL_PROJECT}-git-${slug}-teamottaly.vercel.app`
}

// ── Playwright test ───────────────────────────────────────
async function testPreview(previewUrl) {
  const { chromium } = require('playwright')
  const results = []
  let browser

  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    const context = await browser.newContext()
    const page = await context.newPage()

    const errors = []
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })
    page.on('pageerror', err => errors.push(err.message))

    // Login first
    await page.goto(`${previewUrl}/login`, { waitUntil: 'networkidle', timeout: 30000 })
    await page.fill('input[type="email"], input[name="email"]', DASHBOARD_LOGIN).catch(() => {})
    await page.fill('input[type="password"], input[name="password"]', DASHBOARD_PASS).catch(() => {})
    await page.click('button[type="submit"]').catch(() => {})
    await page.waitForTimeout(2000)

    // Test each page
    for (const { path: pagePath, name } of TEST_PAGES) {
      const pageErrors = []
      page.on('console', msg => { if (msg.type() === 'error') pageErrors.push(msg.text()) })
      page.on('pageerror', err => pageErrors.push(err.message))

      try {
        const res = await page.goto(`${previewUrl}${pagePath}`, { waitUntil: 'networkidle', timeout: 20000 })
        const status = res?.status() ?? 0
        const hasContent = await page.locator('h1, h2, table, [class*="card"]').count() > 0

        if (status >= 400) {
          results.push(`❌ ${name} — HTTP ${status}`)
        } else if (!hasContent) {
          results.push(`⚠️ ${name} — loaded but no content found`)
        } else if (pageErrors.length > 0) {
          results.push(`⚠️ ${name} — loaded with ${pageErrors.length} console error(s)`)
        } else {
          results.push(`✅ ${name}`)
        }
      } catch (e) {
        results.push(`❌ ${name} — ${e.message.slice(0, 60)}`)
      }
    }
  } catch (e) {
    return [`❌ Test runner failed: ${e.message}`]
  } finally {
    await browser?.close()
  }

  return results
}

// ── Wait for Vercel deploy ────────────────────────────────
async function waitForVercel(previewUrl, maxWaitMs = 180000) {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    try {
      const ok = await new Promise(resolve => {
        https.get(previewUrl, res => resolve(res.statusCode < 500)).on('error', () => resolve(false))
      })
      if (ok) return true
    } catch {}
    await new Promise(r => setTimeout(r, 10000))
  }
  return false
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
      // 1. Run agent — writes code
      const { summary, branch } = await runAgent(text)

      // 2. Push branch
      const pushed = pushBranch(branch)
      if (!pushed) {
        postToSlack(response_url, `<@${user_id}> No changes made for: _${text}_\n\n${summary}`)
        return
      }

      const previewUrl = branchToPreviewUrl(branch)
      postToSlack(response_url, `<@${user_id}> ✅ Code pushed for: _${text}_\n\n${summary}\n\n🔗 Preview: ${previewUrl}\n\n⏳ Running tests — wait ~3 min...`)

      // 3. Wait for Vercel to deploy
      const deployed = await waitForVercel(previewUrl)
      if (!deployed) {
        postToSlack(response_url, `<@${user_id}> ⚠️ Vercel deploy timed out. Check manually: ${previewUrl}`)
        return
      }

      // 4. Run Playwright tests
      const testResults = await testPreview(previewUrl)
      const passed = testResults.filter(r => r.startsWith('✅')).length
      const failed = testResults.filter(r => r.startsWith('❌')).length
      const warned = testResults.filter(r => r.startsWith('⚠️')).length

      const testReport = testResults.join('\n')
      const status = failed > 0 ? '❌ Tests failed' : warned > 0 ? '⚠️ Tests passed with warnings' : '✅ All tests passed'

      postToSlack(response_url,
        `<@${user_id}> ${status} (${passed} passed, ${warned} warned, ${failed} failed)\n\n${testReport}\n\n🔗 ${previewUrl}`
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
