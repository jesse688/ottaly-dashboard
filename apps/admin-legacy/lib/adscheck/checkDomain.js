// Per-domain Google Ads Transparency check — lifted from the validated
// scripts/ads-checker.js prototype. Do not re-derive this; the gotchas below
// each cost a debugging cycle.
//
//  1. The count regex MUST accept the singular "1 ad". Requiring plural "ads"
//     silently times out every single-ad domain: they match neither "has ads"
//     nor "No ads found".
//  2. Google soft-throttles bursts from one IP. Keep concurrency at 2–4, jitter
//     each navigation, and retry with backoff — most "errors" recover on retry.
//  3. Navigate straight to the ?domain= deep link: the survey/consent popups
//     only appear on the homepage.
//  4. Block image/media/font to cut load time; keep document/script/xhr/fetch.

const COUNT_RE = /(~?\s*[\d,]+)\s+ads?\b/i;
const NO_ADS_RE = /No ads found/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a));

/** One navigation + scrape. Throws on timeout/nav failure — the caller retries. */
async function checkOnce(context, domain, { region = 'anywhere', navTimeout = 30000, waitTimeout = 15000 } = {}) {
  const page = await context.newPage();
  try {
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      return (t === 'image' || t === 'media' || t === 'font') ? route.abort() : route.continue();
    });

    const url = `https://adstransparency.google.com/?region=${encodeURIComponent(region)}&domain=${encodeURIComponent(domain)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });

    // Wait until either an ad count or the "No ads found" message renders.
    await page.waitForFunction(() => {
      const t = document.body.innerText || '';
      return /(~?\s*[\d,]+)\s+ads?\b/i.test(t) || /No ads found/i.test(t) || /Sorry, we couldn/i.test(t);
    }, { timeout: waitTimeout });

    const data = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const m = text.match(/(~?\s*[\d,]+)\s+ads?\b/i);

      // Advertiser names render in .advertiser-name. Match on that specifically:
      // a looser [class*="advertiser"] also picks up the .advertisers-list
      // container, whose text is the "See more results" button. The
      // "<name>\nVerified" reading is the fallback if the class names change.
      // a[href*="/advertiser/"] is NOT usable — those links wrap creative
      // thumbnails and carry no text.
      const CHROME = /^(see more results|show more|verified|advertiser|all advertisers)$/i;
      const clean = (s) => (s || '').trim().replace(/\s+/g, ' ');
      const fromDom = [...document.querySelectorAll('[class*="advertiser-name"]')]
        .map((e) => clean(e.textContent))
        .filter((s) => s && s.length < 120 && !CHROME.test(s));
      const fromText = [];
      const lines = text.split('\n').map(clean);
      lines.forEach((l, i) => {
        const prev = lines[i - 1];
        if (/^Verified$/i.test(l) && prev && !CHROME.test(prev)) fromText.push(prev);
      });

      return {
        rawCount: m ? m[0].trim() : null,
        count: m ? parseInt(m[1].replace(/[~\s,]/g, ''), 10) : null,
        noAds: /No ads found/i.test(text),
        advertisers: [...new Set([...fromDom, ...fromText])].slice(0, 20),
      };
    });

    let n = data.count;
    if (n === null && data.noAds) n = 0;
    if (n === null) throw new Error('no ad count or "No ads found" in rendered page');

    return {
      runs_ads: n > 0,
      ad_count: n,
      is_estimate: !!(data.rawCount && data.rawCount.includes('~')),
      advertisers: data.advertisers,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * checkOnce with backoff. `onAttempt` fires before each try so the worker can
 * refresh its lock and log progress.
 */
async function checkDomain(context, domain, opts = {}) {
  const maxRetries = opts.maxRetries || 4;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (opts.onAttempt) { try { await opts.onAttempt(attempt); } catch { /* non-fatal */ } }
    // Spread requests so a burst doesn't trip Google's throttle.
    await sleep(jitter(opts.jitterMin || 100, opts.jitterMax || 500));
    try {
      const res = await checkOnce(context, domain, opts);
      return { ...res, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) await sleep(jitter(800, 2000) * attempt);
    }
  }
  const e = new Error((lastErr && lastErr.message) || 'check failed');
  e.attempts = maxRetries;
  throw e;
}

module.exports = { checkDomain, checkOnce, COUNT_RE, NO_ADS_RE, sleep, jitter };
