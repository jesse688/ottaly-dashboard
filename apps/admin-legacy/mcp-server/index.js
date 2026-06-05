#!/usr/bin/env node
/**
 * Ottaly dashboard MCP server (stdio).
 *
 * Wraps the agency-wide /api endpoints from ../server.js as MCP tools so Claude
 * Desktop can read the business view. Auth uses the x-admin-key header, which
 * server.js accepts on every requireSession / requireAdmin route.
 *
 * Config (set in claude_desktop_config.json -> env):
 *   OTTALY_BASE_URL   e.g. https://app.yourdomain.com   (default http://localhost:3000)
 *   OTTALY_ADMIN_KEY  the production ADMIN_KEY           (default "ottaly-admin")
 *
 * Read-only by design: only HTTP GETs are issued. Add write tools deliberately.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const BASE = (process.env.OTTALY_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const KEY = process.env.OTTALY_ADMIN_KEY || "ottaly-admin";

// NOTE: stdout is the MCP protocol channel — never console.log here. Use stderr.
const log = (...a) => console.error("[ottaly-mcp]", ...a);

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function apiGet(path, query) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method: "GET",
    headers: { "x-admin-key": KEY, accept: "application/json" },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${path} -> HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    return body; // non-JSON response, return raw
  }
}

// Discover every GET endpoint by parsing ../server.js. Auto-updates whenever the
// repo changes (re-read on each MCP process launch). Only endpoints reachable with
// the x-admin-key are kept — requireAuth routes need a per-client JWT instead.
function loadEndpointCatalog() {
  const src = readFileSync(join(HERE, "..", "server.js"), "utf8");
  const re = /app\.get\(\s*['"](\/api\/[^'"]+)['"]\s*(?:,\s*(require[A-Za-z]+))?/g;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    const path = m[1];
    const auth = m[2] || "public";
    if (auth === "requireAuth") continue; // per-client portal, not admin-key accessible
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, auth, needsPathParam: path.includes("/:") });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const server = new McpServer({ name: "ottaly-dashboard", version: "1.0.0" });

// Register a read-only tool that formats its result as pretty JSON text.
function tool(name, description, shape, run) {
  server.tool(name, description, shape, async (args) => {
    try {
      const data = await run(args);
      const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });
}

const dateRange = {
  start: z.string().optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
  end: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
};
const rangeOrDefault = ({ start, end }) => ({ start: start || daysAgo(30), end: end || today() });

tool(
  "get_performance_summary",
  "Agency-wide outbound performance per workspace over a date range: sends, replies, positive/OOO replies, bounces, leads, reply rate, bounce rate, reply-to-lead ratio. Includes a per-day series.",
  dateRange,
  (args) => apiGet("/api/stats/summary", rangeOrDefault(args))
);

tool(
  "get_combo_analysis",
  "Combination analysis (sender/domain/verification breakdowns and their performance) for a date range.",
  dateRange,
  (args) => apiGet("/api/combo-analysis", rangeOrDefault(args))
);

tool(
  "get_workspace_metrics",
  "Current per-workspace metrics snapshot across all active workspaces (no date range).",
  {},
  () => apiGet("/api/metrics")
);

tool(
  "get_client_health",
  "Per-client health overview: status signals and action items across visible workspaces.",
  {},
  () => apiGet("/api/health/clients")
);

tool(
  "get_revenue_by_workspace",
  "Revenue stats per workspace using current per-lead prices from the DB.",
  {},
  () => apiGet("/api/revenue/stats-by-workspace")
);

tool(
  "get_domains_health",
  "Sending-domain health rows (DMARC/deliverability signals) and last check time.",
  {},
  () => apiGet("/api/domains/health")
);

tool(
  "list_dashboard_endpoints",
  "Discover EVERY readable data endpoint on the dashboard (auto-discovered from the server source). Returns each endpoint's path, the auth it needs, and whether the path has an :id/:workspaceId placeholder that must be filled. This is the map of all data behind every page — call it first, then fetch any endpoint with `dashboard_get`. For paths with a placeholder, get real ids from /api/admin/workspaces or /api/metrics first. Some endpoints need ?start=YYYY-MM-DD&end=YYYY-MM-DD; if so the endpoint returns a 400 saying which params are required.",
  {},
  () => {
    const endpoints = loadEndpointCatalog();
    return {
      count: endpoints.length,
      note: "GET any of these via dashboard_get. auth=public|requireSession|requireAdmin are all reachable with the configured admin key.",
      endpoints,
    };
  }
);

tool(
  "dashboard_get",
  "Read-only GET to any /api endpoint on the dashboard — the universal reader for data behind any page. Call list_dashboard_endpoints first to see valid paths. `path` must start with /api/ and have any :placeholder already substituted (e.g. /api/metrics/<workspaceId>).",
  {
    path: z.string().describe("API path starting with /api/, e.g. /api/verify-split"),
    query: z.record(z.string()).optional().describe("Optional query params as a string map"),
  },
  ({ path, query }) => {
    if (!path.startsWith("/api/")) throw new Error("path must start with /api/");
    return apiGet(path, query);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`connected. base=${BASE}`);
