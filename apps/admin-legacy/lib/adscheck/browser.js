// Shared headless-Chromium lifecycle for the ads checker.
//
// The checker runs inside the main admin-legacy process, so the browser is
// LAZY: launched on the first job and closed again after an idle period. A
// resident headless Chromium costs ~1 GB under load, which we don't want to
// hold while the queue is empty.
//
// Binary discovery matters (Gotcha #3 from the brief): playwright's
// chromium.executablePath() points at the build number the installed
// playwright version expects, which may not be the build that was actually
// downloaded. In the Alpine container we install the distro Chromium instead,
// so honour CHROMIUM_PATH / the usual /usr/bin locations first.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let cachedPath;

/** Walk a playwright browser cache looking for any usable chromium binary. */
function scanCache(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const names = ['chrome-headless-shell', 'headless_shell', 'chrome', 'Google Chrome for Testing', 'chromium'];
  const stack = [dir];
  let depth = 0;
  while (stack.length && depth++ < 5000) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (names.includes(e.name)) {
        try { fs.accessSync(full, fs.constants.X_OK); return full; } catch { /* not executable */ }
      }
    }
  }
  return null;
}

/** Resolve a Chromium executable that actually exists, or null to use the default. */
function findChromium() {
  if (cachedPath !== undefined) return cachedPath;

  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/chromium-browser',   // alpine: apk add chromium
    '/usr/bin/chromium',           // debian/ubuntu
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) { cachedPath = c; return cachedPath; }
  }

  try {
    const def = chromium.executablePath();
    if (def && fs.existsSync(def)) { cachedPath = def; return cachedPath; }
  } catch { /* playwright can throw if nothing is installed at all */ }

  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    '/ms-playwright',
  ].filter(Boolean);
  for (const c of caches) {
    const found = scanCache(c);
    if (found) { cachedPath = found; return cachedPath; }
  }

  cachedPath = null; // let playwright fail with its own (informative) message
  return cachedPath;
}

// ── proxy list ────────────────────────────────────────────
// Webshare's "download list" endpoint returns one `ip:port:user:pass` per line.
// ADS_PROXY_LIST_URL holds the (secret) download URL; ADS_PROXY_LIST can hold
// the same lines inline instead. Neither is ever committed.
let proxyCache = null;

function parseProxyLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const [host, port, username, password] = line.split(':');
      if (!host || !port) return null;
      return {
        server: `http://${host}:${port}`,
        ...(username ? { username, password: password || '' } : {}),
        label: `${host}:${port}`,   // safe to log — no credentials
      };
    })
    .filter(Boolean);
}

/** Load the proxy list once per process. Returns [] when no proxy is configured. */
async function loadProxies() {
  if (proxyCache) return proxyCache;
  const inline = process.env.ADS_PROXY_LIST;
  const url = process.env.ADS_PROXY_LIST_URL;
  try {
    if (inline && inline.trim()) proxyCache = parseProxyLines(inline);
    else if (url && url.trim()) {
      const r = await fetch(url.trim(), { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`proxy list HTTP ${r.status}`);
      proxyCache = parseProxyLines(await r.text());
    } else proxyCache = [];
  } catch (err) {
    console.warn('[ads] proxy list load failed:', err.message, '— falling back to the server IP');
    proxyCache = [];
  }
  if (proxyCache.length) console.log(`[ads] ${proxyCache.length} proxies loaded (${proxyCache.map((p) => p.label).join(', ')})`);
  return proxyCache;
}

class BrowserPool {
  constructor({ idleMs = 5 * 60 * 1000 } = {}) {
    this.idleMs = idleMs;
    this.browser = null;
    this.context = null;
    this.starting = null;
    this.lastUsed = 0;
    this.lastError = null;
    // One context per proxy. Playwright sets the proxy per CONTEXT, so this is
    // how a single browser gets N distinct egress IPs. Jobs round-robin across
    // them, which keeps each IP well under Google's per-IP burst threshold.
    this.proxyContexts = [];
    this.rr = 0;
  }

  get ok() { return !!(this.browser && this.browser.isConnected()); }

  /**
   * Round-robin a context across the configured proxies. Falls back to the
   * single direct context when no proxy list is set.
   */
  async nextContext() {
    await this.getContext();               // ensures the browser is up
    if (!this.proxyContexts.length) return this.context;
    const ctx = this.proxyContexts[this.rr % this.proxyContexts.length];
    this.rr++;
    return ctx;
  }

  /** Launch on demand; concurrent callers share one launch. */
  async getContext() {
    this.lastUsed = Date.now();
    if (this.ok && this.context) return this.context;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      await this.close(); // drop a disconnected browser before relaunching
      const executablePath = findChromium();
      try {
        const proxies = await loadProxies();
        this.browser = await chromium.launch({
          headless: true,
          ...(executablePath ? { executablePath } : {}),
          // --no-sandbox is required running as root in the container; the
          // /dev/shm default (64 MB) is too small for Chromium under load.
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
          // Playwright only honours a PER-CONTEXT proxy if the browser was also
          // launched with one. Without this placeholder every proxied context
          // fails with ERR_TUNNEL_CONNECTION_FAILED — the credentials are never
          // applied. The value is irrelevant since every context overrides it.
          ...(proxies.length ? { proxy: { server: 'http://per-context' } } : {}),
        });
        // Locale MUST be pinned. Google localises the Transparency Centre by the
        // caller's IP, so from the German datacentre it rendered "~600 Anzeigen"
        // / "Bestätigt" instead of "600 ads" / "Verified" — the English-only
        // signals never appeared and every job timed out. This matters even more
        // with proxies, whose exit IPs land in arbitrary countries.
        const contextOpts = {
          userAgent: UA,
          viewport: { width: 1280, height: 800 },
          locale: 'en-GB',
          timezoneId: 'Europe/London',
          extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' },
        };
        this.context = await this.browser.newContext(contextOpts);

        // One context per proxy → N egress IPs from one browser. Each is health-
        // checked before entering rotation: Webshare bills by BANDWIDTH, and an
        // exhausted proxy answers every CONNECT with a tunnel failure. Left in
        // rotation those look like Google throttling and poison the results, so
        // they're excluded up front (a 25-byte check, negligible bandwidth).
        this.proxyContexts = [];
        this.deadProxies = [];
        const checks = await Promise.all(proxies.map(async (proxy) => {
          let ctx;
          try {
            ctx = await this.browser.newContext({ ...contextOpts, proxy });
            const page = await ctx.newPage();
            await page.goto('http://api.ipify.org/?format=json', { timeout: 20000, waitUntil: 'domcontentloaded' });
            const body = await page.evaluate(() => document.body.innerText || '');
            await page.close();
            if (/bandwidth limit/i.test(body)) return { proxy, ctx, ok: false, why: 'bandwidth limit reached' };
            if (!/"ip"/.test(body)) return { proxy, ctx, ok: false, why: `unexpected response: ${body.slice(0, 60)}` };
            return { proxy, ctx, ok: true };
          } catch (e) {
            return { proxy, ctx, ok: false, why: e.message.split('\n')[0].slice(0, 80) };
          }
        }));
        for (const c of checks) {
          if (c.ok) this.proxyContexts.push(c.ctx);
          else {
            this.deadProxies.push({ label: c.proxy.label, why: c.why });
            if (c.ctx) await c.ctx.close().catch(() => {});
          }
        }
        if (this.deadProxies.length) {
          console.warn(`[ads] ${this.deadProxies.length} proxy/proxies unusable: `
            + this.deadProxies.map((d) => `${d.label} (${d.why})`).join(', '));
        }

        this.lastError = null;
        console.log(`[ads] chromium launched (${executablePath || 'playwright default'})`
          + `, ${this.proxyContexts.length}/${proxies.length} proxies healthy`);
        return this.context;
      } catch (err) {
        this.lastError = err.message;
        this.browser = null;
        this.context = null;
        throw err;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** Called from the idle tick — free ~1 GB while the queue is empty. */
  async closeIfIdle() {
    if (!this.browser || this.starting) return false;
    if (Date.now() - this.lastUsed < this.idleMs) return false;
    console.log('[ads] chromium idle — closing');
    await this.close();
    return true;
  }

  async close() {
    const b = this.browser;
    this.browser = null;
    this.context = null;
    this.proxyContexts = [];
    this.rr = 0;
    if (b) await b.close().catch(() => {});
  }
}

module.exports = { BrowserPool, findChromium, loadProxies, parseProxyLines, UA };
