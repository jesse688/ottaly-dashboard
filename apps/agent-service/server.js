'use strict'

require('dotenv').config()

const express = require('express')
const crypto = require('crypto')
const { execSync } = require('child_process')
const https = require('https')
const { writeFileSync, unlinkSync } = require('fs')

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

// Page map: name → legacy file + new file
const PAGE_MAP = {
  contacts:       { legacy: 'contacts.html',      new: 'app/contacts/page.tsx' },
  stats:          { legacy: 'stats.html',          new: 'app/stats/page.tsx' },
  clients:        { legacy: 'clients.html',        new: 'app/clients/page.tsx' },
  finance:        { legacy: 'finance.html',        new: 'app/finance/page.tsx' },
  domains:        { legacy: 'domains.html',        new: 'app/domains/page.tsx' },
  mailboxes:      { legacy: 'mailboxes.html',      new: 'app/mailboxes/page.tsx' },
  capacity:       { legacy: 'capacity.html',       new: 'app/capacity/page.tsx' },
  'leads-analysis': { legacy: 'leads-analysis.html', new: 'app/leads-analysis/page.tsx' },
  'combo-analysis': { legacy: 'combo-analysis.html', new: 'app/combo-analysis/page.tsx' },
  actions:        { legacy: 'actions.html',        new: 'app/actions/page.tsx' },
  'apollo-prep':  { legacy: 'apollo-prep.html',   new: 'app/apollo-prep/page.tsx' },
  'verify-split': { legacy: 'verify-split.html',  new: 'app/verify-split/page.tsx' },
  copy:           { legacy: 'copy.html',           new: 'app/copy/page.tsx' },
  audience:       { legacy: 'icp.html',            new: 'app/audience/page.tsx' },
  diagnostics:    { legacy: 'diagnostics.html',   new: 'app/diagnostics/page.tsx' },
  intelligence:   { legacy: 'intelligence.html',  new: 'app/intelligence/page.tsx' },
  workload:       { legacy: 'workload.html',       new: 'app/workload/page.tsx' },
  commission:     { legacy: 'commission.html',     new: 'app/commission/page.tsx' },
  metrics:        { legacy: 'metrics.html',        new: 'app/metrics/page.tsx' },
  health:         { legacy: 'health.html',         new: 'app/health/page.tsx' },
}

// Global build lock — only one build at a time
let buildLock = false

function sshMac(command, timeoutMs = 120000) {
  const scriptFile = `/tmp/ssh-cmd-${Date.now()}.sh`
  writeFileSync(scriptFile, command, 'utf8')
  try {
    return execSync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=40 -p 2222 ${MAC_USER}@${MAC_HOST} 'bash -s' < ${scriptFile}`,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    )
  } finally {
    try { unlinkSync(scriptFile) } catch {}
  }
}

async function buildPage(pageName, responseUrl, userId) {
  const page = PAGE_MAP[pageName]
  if (!page) {
    postToSlack(responseUrl, `<@${userId}> ❌ Unknown page: ${pageName}`)
    return false
  }

  try {
    const branch = `agent/${pageName}-${Date.now()}`
    sshMac(`cd ${MAC_REPO} && git reset --hard HEAD && git clean -fd && git checkout main && git reset --hard origin/main && git checkout -b ${branch}`)

    const instruction = `Read ${MAC_REPO}/apps/admin-legacy/${page.legacy} thoroughly to understand all features, data, filters, and interactions. Then rebuild ${MAC_REPO}/apps/admin-new/${page.new} to match the same functionality using Next.js, TypeScript, shadcn/ui and Tailwind. Work only in apps/admin-new. Summarise changes at the end.`

    const claudeOutput = sshMac(
      `cd ${MAC_REPO} && ANTHROPIC_AUTH_TOKEN=${CLAUDE_AUTH_TOKEN} ${CLAUDE_PATH} --print --dangerously-skip-permissions --model ${CLAUDE_MODEL} ${JSON.stringify(instruction)} 2>&1`,
      600000
    )

    const status = sshMac(`cd ${MAC_REPO} && git status --porcelain`)
    if (!status.trim()) {
      postToSlack(responseUrl, `<@${userId}> ⚠️ No changes for *${pageName}*`)
      return false
    }

    sshMac(`cd ${MAC_REPO} && git add -A && git commit -m "agent: rebuild ${pageName} page" && git push origin ${branch}`)

    const slug = branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
    const previewUrl = `https://${VERCEL_PROJECT}-git-${slug}-teamottaly.vercel.app`
    const summary = claudeOutput.slice(-800)

    postToSlack(responseUrl, `<@${userId}> ✅ *${pageName}* done\n${summary}\n\n🔗 ${previewUrl}`)
    return true
  } catch (err) {
    postToSlack(responseUrl, `<@${userId}> ❌ *${pageName}* failed: ${err.message.slice(0, 200)}`)
    return false
  }
}

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

// /build — single task
app.post('/slack/build',
  express.raw({ type: 'application/x-www-form-urlencoded' }),
  async (req, res) => {
    const rawBody = req.body.toString()
    if (!verifySlack(rawBody, req.headers)) return res.status(401).send('Unauthorized')

    const params = Object.fromEntries(new URLSearchParams(rawBody))
    const { text, user_id, response_url } = params

    if (!text) return res.json({ response_type: 'ephemeral', text: 'Usage: /build <instruction>' })
    if (buildLock) return res.json({ response_type: 'ephemeral', text: '⚠️ A build is already running. Wait for it to finish.' })

    res.json({ response_type: 'ephemeral', text: `⚙️ Working on: _${text}_` })

    buildLock = true
    try {
      const branch = `agent/${Date.now()}`
      sshMac(`cd ${MAC_REPO} && git reset --hard HEAD && git clean -fd && git checkout main && git reset --hard origin/main && git checkout -b ${branch}`)

      const fullInstruction = `${text}. Work only in ${MAC_REPO}/apps/admin-new. Read the equivalent legacy HTML in ${MAC_REPO}/apps/admin-legacy first. Summarise changes at the end.`

      const claudeOutput = sshMac(
        `cd ${MAC_REPO} && ANTHROPIC_AUTH_TOKEN=${CLAUDE_AUTH_TOKEN} ${CLAUDE_PATH} --print --dangerously-skip-permissions ${JSON.stringify(fullInstruction)} 2>&1`,
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

      postToSlack(response_url,
        `<@${user_id}> ✅ Done: _${text}_\n\n${claudeOutput.slice(-1500)}\n\n🔗 Preview: ${previewUrl}\n\nVercel deploying — check in ~2 min.`
      )
    } catch (err) {
      console.error('[agent] Error:', err.message)
      postToSlack(response_url, `<@${user_id}> ❌ Error: ${err.message.slice(0, 300)}`)
    } finally {
      buildLock = false
    }
  }
)

// /buildall — queue multiple pages
app.post('/slack/buildall',
  express.raw({ type: 'application/x-www-form-urlencoded' }),
  async (req, res) => {
    const rawBody = req.body.toString()
    if (!verifySlack(rawBody, req.headers)) return res.status(401).send('Unauthorized')

    const params = Object.fromEntries(new URLSearchParams(rawBody))
    const { text, user_id, response_url } = params

    const pages = text ? text.split(',').map(p => p.trim().toLowerCase()) : Object.keys(PAGE_MAP)

    if (buildLock) {
      return res.json({ response_type: 'ephemeral', text: '⚠️ A build is already running. Wait for it to finish.' })
    }

    res.json({ response_type: 'in_channel', text: `⚙️ <@${user_id}> Queuing *${pages.length} pages*: ${pages.join(', ')}\n\nI'll post each result as it completes.` })

    buildLock = true
    let done = 0
    let failed = 0
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

app.get('/health', (_, res) => res.json({ ok: true }))

app.listen(PORT, () => console.log(`[agent] Running on port ${PORT}`))
