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

class BrowserPool {
  constructor({ idleMs = 5 * 60 * 1000 } = {}) {
    this.idleMs = idleMs;
    this.browser = null;
    this.context = null;
    this.starting = null;
    this.lastUsed = 0;
    this.lastError = null;
  }

  get ok() { return !!(this.browser && this.browser.isConnected()); }

  /** Launch on demand; concurrent callers share one launch. */
  async getContext() {
    this.lastUsed = Date.now();
    if (this.ok && this.context) return this.context;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      await this.close(); // drop a disconnected browser before relaunching
      const executablePath = findChromium();
      try {
        this.browser = await chromium.launch({
          headless: true,
          ...(executablePath ? { executablePath } : {}),
          // --no-sandbox is required running as root in the container; the
          // /dev/shm default (64 MB) is too small for Chromium under load.
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        });
        this.context = await this.browser.newContext({
          userAgent: UA,
          viewport: { width: 1280, height: 800 },
          // MUST pin the locale. Google localises the Transparency Centre by the
          // caller's IP, so from the German datacentre it renders "~600 Anzeigen"
          // / "Bestätigt" instead of "600 ads" / "Verified" — the English-only
          // signals never appear and every job times out. Playwright's `locale`
          // sets Accept-Language and navigator.language; the explicit header is
          // belt-and-braces.
          locale: 'en-GB',
          timezoneId: 'Europe/London',
          extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' },
        });
        this.lastError = null;
        console.log(`[ads] chromium launched (${executablePath || 'playwright default'})`);
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
    if (b) await b.close().catch(() => {});
  }
}

module.exports = { BrowserPool, findChromium, UA };
