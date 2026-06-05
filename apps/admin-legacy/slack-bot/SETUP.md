# Ottaly Slack Bot Setup

## 1. Create Slack App

1. Go to api.slack.com/apps → Create New App → From scratch
2. Name: `Ottaly Agent` → select your workspace → Create

## 2. Enable Socket Mode

Settings → Socket Mode → Enable Socket Mode
Generate App-Level Token with scope `connections:write`
Copy the `xapp-...` token → save as `SLACK_APP_TOKEN`

## 3. Add Bot Scopes

OAuth & Permissions → Bot Token Scopes → Add:
- `chat:write`
- `channels:history`
- `app_mentions:read`

## 4. Subscribe to Events

Event Subscriptions → Enable Events
Subscribe to bot events:
- `message.channels`
- `app_mention`

## 5. Install App

OAuth & Permissions → Install to Workspace
Copy `Bot User OAuth Token` (xoxb-...) → save as `SLACK_BOT_TOKEN`

## 6. Add Bot to Channel

In Slack: /invite @OttalyAgent to your #agent-updates channel
Copy the channel ID (right-click channel → View channel details → Channel ID)
Save as `SLACK_CHANNEL_ID`

## 7. Add to .env on Easypanel

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_CHANNEL_ID=C...
SLACK_PROJECT_DIR=/app
```

## 8. Start the bot

The bot starts automatically via server.js. Or manually:
```
node slack-bot/bot.js
```

## Usage

Send any message in the channel:
- "how many leads did we get this week?"
- "show me campaign stats for AccrueAccounting"
- "run the ESP sync now"
- "what's the health score for Bubble?"

The bot replies in-thread within ~30 seconds.
