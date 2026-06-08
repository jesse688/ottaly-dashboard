'use strict'

require('dotenv').config()

const express = require('express')
const crypto = require('crypto')
const { execSync, exec } = require('child_process')
const https = require('https')

const app = express()
const PORT = process.env.PORT || 3100

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET
const MAC_USER = process.env.MAC_USER || 'jesse'
const MAC_HOST = process.env.MAC_HOST || '46.38.255.178'
const MAC_REPO = process.env.MAC_REPO || '/Users/jesse/Desktop/ottaly-dashboard'
const CLAUDE_PATH = process.env.CLAUDE_PATH || '/Users/jesse/.nvm/versions/node/v24.11.1/bin/claude'
const VERCEL_PROJECT = 'ottaly-dashboard-admin-new'

// SSH command that goes through the reverse tunnel to the Mac
function sshMac(command, timeoutMs = 120000) {
  const ssh = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p 2222 ${MAC_USER}@${MAC_HOST}`
  return execSync(`${ssh} "${command.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe']
  })
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
      // 1. Create branch on Mac
      const branch = `agent/${Date.now()}`
      sshMac(`cd ${MAC_REPO} && git checkout main && git pull origin main && git checkout -b ${branch}`)

      // 2. Write task to file on Mac then run Claude Code reading from stdin
      const taskId = Date.now()
      const taskFile = `/tmp/ottaly-task-${taskId}.txt`
      const fullInstruction = `${text}

Important rules:
- Work only in ${MAC_REPO}/apps/admin-new
- First read the equivalent legacy HTML file in ${MAC_REPO}/apps/admin-legacy to understand the feature
- After all changes, summarise exactly what you changed and why`

      sshMac(`printf '%s' ${JSON.stringify(fullInstruction)} > ${taskFile}`)

      const claudeOutput = sshMac(
        `cd ${MAC_REPO} && ${CLAUDE_PATH} --dangerously-skip-permissions --output-format text "$(cat ${taskFile})" 2>&1 ; rm -f ${taskFile}`,
        300000
      )

      // 3. Check if anything changed
      const status = sshMac(`cd ${MAC_REPO} && git status --porcelain`)
      if (!status.trim()) {
        postToSlack(response_url, `<@${user_id}> No changes made for: _${text}_\n\n${claudeOutput.slice(0, 500)}`)
        return
      }

      // 4. Commit and push
      sshMac(`cd ${MAC_REPO} && git add -A && git commit -m "agent: ${branch.replace('agent/', '')}" && git push origin ${branch}`)

      // 5. Get preview URL
      const slug = branch.replace('agent/', 'agent-').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
      const previewUrl = `https://${VERCEL_PROJECT}-git-${slug}-teamottaly.vercel.app`

      const summary = claudeOutput.slice(-1500) // last part has the summary
      postToSlack(response_url,
        `<@${user_id}> ✅ Done: _${text}_\n\n${summary}\n\n🔗 Preview: ${previewUrl}\n\nVercel deploying — check in ~2 min.`
      )
    } catch (err) {
      console.error('[agent] Error:', err.message)
      postToSlack(response_url, `<@${user_id}> ❌ Error: ${err.message.slice(0, 300)}`)
    }
  }
)

app.get('/health', (_, res) => res.json({ ok: true }))

app.listen(PORT, () => console.log(`[agent] Running on port ${PORT}`))
