import pool from './db'

// Record an admin-facing notification (shown in the admin portal) and best-effort
// ping Slack if a bot token + channel are configured. Never throws.
export async function notifyAdmin(input: {
  clientId?: string
  kind: 'topup_request' | 'invoice_paid' | 'reply_sent' | 'dispute'
  title: string
  body?: string
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO portal_notifications (client_id, kind, title, body)
       VALUES ($1, $2, $3, $4)`,
      [input.clientId ?? null, input.kind, input.title, input.body ?? null]
    )
  } catch (err) {
    console.error('[notify] db insert failed:', err)
  }

  const token = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_CHANNEL_ID
  if (!token || !channel) return
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        channel,
        text: `*${input.title}*${input.body ? `\n${input.body}` : ''}`,
      }),
    })
  } catch (err) {
    console.error('[notify] slack post failed:', err)
  }
}
