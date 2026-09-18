/**
 * PlusVibe MCP client.
 *
 * Placement tests have no REST path under /api/v1 — every documented shape
 * 404s. They are only reachable through PlusVibe's MCP endpoint, which is
 * plain JSON-RPC over HTTP and takes the same x-api-key, so a script can call
 * it directly without Claude in the loop.
 *
 * Protocol: POST initialize, keep the mcp-session-id header it returns, send
 * notifications/initialized, then tools/call for each request. Responses come
 * back as SSE frames ("event: message\ndata: {...}"), so the JSON has to be
 * pulled out of the stream rather than parsed straight off the body.
 *
 * AUTH: the key goes in the URL as ?api_key=..., NOT in a header. Passing it
 * as x-api-key, Authorization or API_KEY_PV all connect fine and then fail
 * every tool call with "requires authentication", which reads like a config
 * problem rather than the wrong auth channel.
 *
 * Requests are serialised through one gate for the same reason the REST client
 * is: two concurrent limiters 429 each other.
 */

const axios = require('axios');

const ENDPOINT = process.env.PLUSVIBE_MCP_URL || 'https://mcp.plusvibe.ai/mcp';
const GAP_MS = 350;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pull the JSON payload out of an SSE response body. */
function parseSse(body) {
  if (typeof body === 'object' && body !== null) return body;
  const text = String(body);
  // Frames look like: event: message\ndata: {...}\n\n
  const lines = text.split('\n').filter((l) => l.startsWith('data:'));
  if (!lines.length) {
    try { return JSON.parse(text); } catch { return null; }
  }
  for (const line of lines.reverse()) {
    try { return JSON.parse(line.slice(5).trim()); } catch { /* keep looking */ }
  }
  return null;
}

class PVMcp {
  constructor(apiKey, { gapMs = GAP_MS } = {}) {
    if (!apiKey) throw new Error('PLUSVIBE_API_KEY missing');
    this.key = apiKey;
    this.gapMs = gapMs;
    this.session = null;
    this.calls = 0;
    this.id = 0;
    this._chain = Promise.resolve();
  }

  get _url() {
    return `${ENDPOINT}?api_key=${encodeURIComponent(this.key)}`;
  }

  get _headers() {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.session) h['mcp-session-id'] = this.session;
    return h;
  }

  _gate(fn) {
    const run = this._chain.then(async () => {
      const out = await fn();
      await sleep(this.gapMs);
      return out;
    });
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  async connect() {
    if (this.session) return;
    const r = await axios.post(this._url, {
      jsonrpc: '2.0', id: ++this.id, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'ottaly-mailbox', version: '1.0' },
      },
    }, { headers: this._headers, timeout: 30000 });

    this.session = r.headers['mcp-session-id'] || r.headers['Mcp-Session-Id'];
    if (!this.session) throw new Error('MCP did not return a session id');
    // Fire-and-forget: the server does not always answer this one.
    await axios.post(this._url, { jsonrpc: '2.0', method: 'notifications/initialized' },
      { headers: this._headers, timeout: 20000 }).catch(() => {});
  }

  /** Call a tool and return its parsed result. */
  async call(tool, args, { retries = 2 } = {}) {
    await this.connect();
    return this._gate(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          this.calls++;
          const r = await axios.post(this._url, {
            jsonrpc: '2.0', id: ++this.id, method: 'tools/call',
            params: { name: tool, arguments: args },
          }, { headers: this._headers, timeout: 90000 });

          const msg = parseSse(r.data);
          if (msg?.error) throw new Error(`${tool}: ${msg.error.message}`);

          // Tool results arrive as content blocks holding a JSON string.
          const content = msg?.result?.content;
          if (Array.isArray(content)) {
            const text = content.map((c) => c.text || '').join('');
            // The text is usually "API Response (Status: 200):\n{...}".
            const brace = text.indexOf('{');
            if (brace >= 0) {
              try { return JSON.parse(text.slice(brace)); } catch { return { raw: text }; }
            }
            return { raw: text };
          }
          return msg?.result ?? null;
        } catch (e) {
          // A dropped session has to be re-established, not retried blindly.
          const stale = /session/i.test(e.message || '') || e.response?.status === 400;
          if (stale && attempt < retries) { this.session = null; await this.connect(); continue; }
          if (attempt >= retries) throw e;
          await sleep(1000 * Math.pow(2, attempt));
        }
      }
    });
  }

  // ---- the placement surface the ingest needs ------------------------------

  async listTests(workspaceId, limit = 50) {
    const d = await this.call('list_email_placement_tests',
      { workspace_id: workspaceId, limit });
    return d?.tests || [];
  }

  async listRuns(workspaceId, parentTestId, limit = 50) {
    const d = await this.call('list_email_placement_test_runs',
      { workspace_id: workspaceId, parent_test_id: parentTestId, limit });
    return d?.tests || [];
  }

  async runDetail(workspaceId, testId) {
    const d = await this.call('get_email_placement_test_run_detail',
      { workspace_id: workspaceId, test_id: testId });
    return d?.test || null;
  }

  async senderResult(workspaceId, testId, senderAccId) {
    const d = await this.call('get_email_placement_test_automatic_result',
      { workspace_id: workspaceId, test_id: testId, sender_acc_id: senderAccId });
    return d?.data || [];
  }
}

module.exports = { PVMcp, parseSse };
