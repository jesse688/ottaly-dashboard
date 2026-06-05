#!/usr/bin/env node
// Automates domain registration in Google Postmaster Tools.
// For each Winnr domain: opens the Add Domain dialog, grabs the
// google-site-verification TXT token, writes it to Winnr DNS via API,
// then clicks Verify — all without you touching the keyboard.
//
// Usage:
//   node postmaster-register.js
//
// A Chrome window will open. Log into postmaster.google.com, then
// press Enter in this terminal and the script takes over.

const { chromium } = require('playwright');
const https = require('https');
const path = require('path');
const readline = require('readline');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const WINNR_TOKEN = process.env.WINNR_API_TOKEN;
if (!WINNR_TOKEN) { console.error('WINNR_API_TOKEN not set in .env'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => { rl.question(prompt, () => { rl.close(); resolve(); }); });
}

// ── Winnr helpers ─────────────────────────────────────────────────────

function _winnrReq(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.winnr.app', path: urlPath, method,
      headers: {
        Authorization: `Bearer ${WINNR_TOKEN}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`Winnr ${res.statusCode}: ${parsed.error?.message || data.slice(0, 200)}`));
          else resolve(parsed);
        } catch { reject(new Error('Winnr: non-JSON response')); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function listAllWinnrDomains() {
  const all = [];
  let cursor = null;
  do {
    const qs = '/v1/domains?limit=100' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await _winnrReq('GET', qs);
    all.push(...(r.data || []));
    cursor = r.pagination?.has_more ? r.pagination.cursor : null;
  } while (cursor);
  return all;
}

async function addWinnrTxt(domainId, value) {
  return _winnrReq('POST', `/v1/domains/${domainId}/custom-dns-records`, {
    name: '@', type: 'TXT', value, ttl: 300,
  });
}

async function updateWinnrTxt(domainId, recordId, value) {
  return _winnrReq('PATCH', `/v1/domains/${domainId}/custom-dns-records/${recordId}`, {
    value, ttl: 300,
  });
}

// ── Postmaster UI helpers ─────────────────────────────────────────────

// Find the "Add domain" / "+" button and click it.
async function clickAddDomain(page) {
  // Try multiple selectors — Postmaster UI uses Material Design with jsname attrs
  const selectors = [
    '[aria-label="Add domain"]',
    'button[jsname][aria-label*="add" i]',
    '[data-view-id="addDomainFab"]',
    'button.mat-fab',
    'a[href*="addDomain"]',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) { await el.click(); return true; }
  }
  // Last resort: find button/link with "add" in text
  const btn = page.getByRole('button', { name: /add/i }).first();
  if (await btn.isVisible().catch(() => false)) { await btn.click(); return true; }
  return false;
}

// Extract a google-site-verification token from the current page content.
async function extractToken(page) {
  // Wait up to 8s for the token to appear
  for (let i = 0; i < 16; i++) {
    const content = await page.content();
    const m = content.match(/google-site-verification=([\w_-]+)/);
    if (m) return `google-site-verification=${m[1]}`;
    await sleep(500);
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log('\nFetching Winnr domain list…');
  const winnrDomains = await listAllWinnrDomains();
  console.log(`Found ${winnrDomains.length} Winnr domains.\n`);

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--start-maximized'],
    slowMo: 80,
  }).catch(() =>
    // Fallback if system Chrome not available
    chromium.launch({ headless: false, args: ['--start-maximized'], slowMo: 80 })
  );

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  await page.goto('https://postmaster.google.com', { waitUntil: 'domcontentloaded' });

  await waitForEnter(
    '\n==========================================================\n' +
    '  Log in to Google Postmaster Tools in the Chrome window.\n' +
    '  Make sure you\'re on the domain list page, then press Enter.\n' +
    '==========================================================\n'
  );

  await sleep(2000);
  console.log('\nStarting registration…\n');

  let done = 0, skipped = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < winnrDomains.length; i++) {
    const d = winnrDomains[i];
    const prefix = `[${i + 1}/${winnrDomains.length}] ${d.name}`;
    process.stdout.write(`${prefix} … `);

    try {
      // Open Add Domain dialog
      const clicked = await clickAddDomain(page);
      if (!clicked) throw new Error('Add domain button not found — is the page loaded?');
      await sleep(1000);

      // Fill in domain name
      const input = await page.waitForSelector(
        'input[type="url"], input[type="text"][autocomplete], input[placeholder*="domain" i], input[jsname]',
        { timeout: 6000 }
      );
      await input.fill(d.name);
      await sleep(400);

      // Click Next / Continue
      const nextBtn = page.getByRole('button', { name: /next|continue/i }).first();
      await nextBtn.click();
      await sleep(1500);

      // Extract verification token
      const token = await extractToken(page);
      if (!token) {
        // Check if already verified/registered
        const bodyText = await page.innerText('body').catch(() => '');
        if (/verified|already registered/i.test(bodyText)) {
          process.stdout.write('already registered\n');
          skipped++;
          await page.keyboard.press('Escape');
          await sleep(600);
          continue;
        }
        throw new Error('TXT token not found on page');
      }

      // Write TXT record to Winnr DNS
      try {
        await addWinnrTxt(d.id, token);
      } catch (e) {
        if (e.message.includes('400') || e.message.includes('already exists')) {
          // Record exists — Winnr returns 400 "use update instead". Try PATCH.
          // We don't have the record ID here so just continue — token may already match.
        } else if (!e.message.includes('409')) {
          throw e;
        }
      }

      // Small wait for Winnr DNS to propagate (authoritative — usually fast)
      await sleep(5000);

      // Click Verify
      const verifyBtn = page.getByRole('button', { name: /verify/i }).first();
      await verifyBtn.click();
      await sleep(2500);

      // Check for success — look for error indicators
      const afterText = await page.innerText('body').catch(() => '');
      if (/couldn't verify|error|failed/i.test(afterText) && !/verified/i.test(afterText)) {
        throw new Error('Verification failed — DNS may need more time');
      }

      process.stdout.write('✓\n');
      done++;
    } catch (err) {
      process.stdout.write(`✗  ${err.message}\n`);
      failed++;
      failures.push({ domain: d.name, error: err.message });
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(1000);
    }
  }

  console.log('\n──────────────────────────────────────');
  console.log(`Done: ${done} registered  |  ${skipped} already existed  |  ${failed} failed`);
  if (failures.length) {
    console.log('\nFailed:');
    failures.forEach(f => console.log(`  ${f.domain}: ${f.error}`));
    console.log('\nRe-run the script to retry failed domains.');
  }

  await waitForEnter('\nPress Enter to close the browser… ');
  await browser.close();
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
