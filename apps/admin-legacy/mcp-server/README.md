# Ottaly dashboard — MCP server

A tiny [Model Context Protocol](https://modelcontextprotocol.io) server that lets
Claude Desktop read the **agency-wide** view of the dashboard. It maps Claude tool
calls to the existing `/api/*` endpoints in [`../server.js`](../server.js),
authenticating with the `x-admin-key` header that those routes already accept.

It is **read-only** — only HTTP GETs are issued.

## How it gives Claude access to everything

Claude can read the data behind **every page**, not just the named tools below:

1. `list_dashboard_endpoints` auto-discovers all ~79 GET endpoints by parsing
   [`../server.js`](../server.js) at launch (so it stays in sync as the app changes).
2. `dashboard_get` fetches any of them, with `:id`/`:workspaceId` placeholders filled.

The named tools are just shortcuts for the most-used views. Only endpoints reachable
with the admin key are exposed — the 3 `requireAuth` per-client portal routes
(`/api/stats`, `/api/leads`, `/api/leads/:id/thread`) are excluded because they need a
client JWT and are scoped to a single client.

## Tools

| Tool | Endpoint | Notes |
|------|----------|-------|
| `list_dashboard_endpoints` | — | discover all readable endpoints (the map of every page's data) |
| `dashboard_get` | any `/api/...` | universal read-only reader; fill `:placeholders` first |
| `get_performance_summary` | `/api/stats/summary` | sends / replies / leads per workspace, with per-day series. Defaults to last 30 days. |
| `get_combo_analysis` | `/api/combo-analysis` | sender/domain/verification breakdowns. Defaults to last 30 days. |
| `get_workspace_metrics` | `/api/metrics` | current per-workspace snapshot |
| `get_client_health` | `/api/health/clients` | per-client health + action items |
| `get_revenue_by_workspace` | `/api/revenue/stats-by-workspace` | revenue at current prices |
| `get_domains_health` | `/api/domains/health` | sending-domain / DMARC signals |

> A few endpoints (e.g. `/api/mailboxes`) return multi-MB payloads that can exceed
> Claude's context in a single call.

## Setup

1. Install deps (once):
   ```bash
   cd mcp-server && npm install
   ```

2. Add to Claude Desktop's config at
   `~/Library/Application Support/Claude/claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "ottaly-dashboard": {
         "command": "node",
         "args": ["/Users/jesse/Desktop/ottaly-dashboard/mcp-server/index.js"],
         "env": {
           "OTTALY_BASE_URL": "https://YOUR-DASHBOARD-URL",
           "OTTALY_ADMIN_KEY": "your-production-admin-key"
         }
       }
     }
   }
   ```

3. Fully quit and reopen Claude Desktop. The tools appear under the 🔌 / tools menu.

### Config

| Env var | Default | Meaning |
|---------|---------|---------|
| `OTTALY_BASE_URL` | `http://localhost:3000` | dashboard origin (your Easypanel URL in prod) |
| `OTTALY_ADMIN_KEY` | `ottaly-admin` | must equal the server's `ADMIN_KEY` |

Point `OTTALY_BASE_URL` at `http://localhost:3000` to test against a locally
running `npm start`, or at your deployed URL to query live data.

## Adding tools

Each tool is ~5 lines in [`index.js`](index.js). Copy an existing `tool(...)`
block, point it at another endpoint, and restart Claude Desktop. Keep it GET-only
unless you deliberately want Claude to mutate data.
