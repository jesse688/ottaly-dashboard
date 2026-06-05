#!/usr/bin/env node
/**
 * Usage: node .claude/slack-notify.js "<message>" [preview_url]
 * Agents use this to post updates to Jesse's Slack.
 * Set SLACK_WEBHOOK_URL in environment.
 */
const [, , message, previewUrl] = process.argv

if (!message) {
  console.error('Usage: slack-notify.js "<message>" [preview_url]')
  process.exit(1)
}

const webhook = process.env.SLACK_WEBHOOK_URL
if (!webhook) {
  console.error('SLACK_WEBHOOK_URL not set — skipping Slack notification')
  process.exit(0)
}

const blocks = [
  {
    type: 'section',
    text: { type: 'mrkdwn', text: message },
  },
]

if (previewUrl) {
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Preview:* <${previewUrl}|Open preview>` },
  })
}

fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ blocks }),
})
  .then(r => {
    if (!r.ok) throw new Error(`Slack error: ${r.status}`)
    console.log('Slack notification sent')
  })
  .catch(err => {
    console.error('Failed to send Slack notification:', err.message)
    process.exit(1)
  })
