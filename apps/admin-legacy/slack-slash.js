'use strict'

const https = require('https')
const crypto = require('crypto')

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY

if (!SLACK_SIGNING_SECRET) {
  console.error('[slack-slash] Missing SLACK_SIGNING_SECRET')
  process.exit(1)
}

function verifySlackRequest(req) {
  const timestamp = req.headers['x-slack-request-timestamp']
  const signature = req.headers['x-slack-signature']

  if (!timestamp || !signature) return false

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - parseInt(timestamp)) > 300) return false

  const baseString = `v0:${timestamp}:${req.rawBody}`
  const mySignature = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(baseString).digest('hex')

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mySignature))
}

function callClaude(userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: `You are the Ottaly admin agent. Answer questions about the business concisely in 1-2 sentences.
Key facts: 30 client workspaces, 977k+ contacts, campaigns via PlusVibe, new dashboard at dev.ottaly.co.uk`,
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

module.exports = {
  verifySlackRequest,
  callClaude,
}
