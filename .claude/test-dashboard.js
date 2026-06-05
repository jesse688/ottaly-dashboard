/**
 * Ottaly Dashboard — Visual QA Test Suite
 * Run: node .claude/test-dashboard.js
 * Opens an HTML report at .claude/test-report/index.html when done.
 *
 * Tests every page the way a human would:
 *   - Screenshots on load (after data settles)
 *   - Key interactions: filters, tabs, modals, sort, search
 *   - Screenshots after each interaction
 *   - Captures JS errors, API failures, and visible error states
 */

const { chromium, request: playwrightRequest } = require('../node_modules/playwright');
const fs = require('fs');
const path = require('path');

const BASE      = 'https://admin.ottaly.co.uk';
const ADMIN_KEY = process.env.ADMIN_KEY || 'Ottaly2025$';
const REPORT_DIR = path.join(__dirname, 'test-report');

// ─── helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function b64(file) {
  return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
}

async function shot(page, label, ctx) {
  const slug = label.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const file = path.join(REPORT_DIR, 'screenshots', `${ctx.page}-${ctx.idx++}-${slug}.png`);
  await page.screenshot({ path: file, fullPage: false });
  ctx.shots.push({ label, file });
  return file;
}

async function waitForData(page) {
  // Wait for network to quiet
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  // Wait for the splash screen to disappear (it holds for ~4900ms on direct nav)
  await page.waitForFunction(() => {
    const splash = [...document.querySelectorAll('div')].find(el =>
      el.style && el.style.zIndex === '2147483647'
    );
    return !splash || parseFloat(splash.style.opacity || '1') === 0 || !document.body.contains(splash);
  }, { timeout: 7000 }).catch(() => {});
  // Wait for common spinner selectors to vanish
  await page.waitForFunction(() => {
    const spinners = [...document.querySelectorAll(
      '.spinner, .loading-spinner, [class*="spin"]:not(input):not(select)'
    )].filter(el => el.offsetHeight > 0 && el.offsetWidth > 0 &&
      window.getComputedStyle(el).display !== 'none');
    return spinners.length === 0;
  }, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function checkErrors(page) {
  return page.evaluate(() => {
    const errors = [];
    // Visible error banners / alert-danger / toast-error
    [...document.querySelectorAll(
      '.error-banner, .alert-danger, .toast-error, .error-message, [class*="error-msg"]'
    )].forEach(el => {
      if (el.offsetHeight > 0) errors.push(el.textContent.trim().slice(0, 120));
    });
    // Empty state that looks unintentional (no data at all in table + no spinner)
    const tables = [...document.querySelectorAll('table')];
    tables.forEach(t => {
      const rows = t.querySelectorAll('tbody tr');
      const empty = [...rows].filter(r => r.querySelector('td[colspan]'));
      if (rows.length === empty.length && rows.length > 0) {
        const msg = rows[0]?.textContent?.trim();
        if (msg) errors.push(`Empty table: "${msg.slice(0, 80)}"`);
      }
    });
    return errors;
  });
}

// ─── page test definitions ─────────────────────────────────────────────────────

async function testPage(browser, cookies, def) {
  const { name, path: pagePath, test } = def;
  const ctx = { page: pagePath.replace('.html', ''), idx: 0, shots: [] };
  const jsErrors = [];
  const apiFailures = [];

  const p = await browser.newPage();
  p.on('console', m => {
    if (m.type() === 'error') {
      const txt = m.text();
      if (!txt.includes('favicon') && !txt.includes('fonts.google') && !txt.includes('ERR_CERT')) {
        jsErrors.push(txt.slice(0, 200));
      }
    }
  });
  p.on('pageerror', e => jsErrors.push(e.message.slice(0, 200)));
  p.on('response', r => {
    if (r.url().includes('/api/') && !r.ok()) {
      apiFailures.push(`${r.url().replace(BASE, '').split('?')[0]} → ${r.status()}`);
    }
  });

  const result = { name, path: pagePath, shots: ctx.shots, jsErrors, apiFailures, issues: [], status: 'ok' };

  try {
    const response = await p.goto(`${BASE}/${pagePath}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    result.httpStatus = response?.status();

    if (p.url().includes('login')) {
      result.issues.push('Redirected to login — session not accepted');
      result.status = 'broken';
      await shot(p, 'login-redirect', ctx);
      await p.close();
      return result;
    }

    await waitForData(p);
    await shot(p, 'loaded', ctx);

    const visibleErrors = await checkErrors(p);
    if (visibleErrors.length) {
      result.issues.push(...visibleErrors.map(e => `Visible error: ${e}`));
    }

    // Run page-specific interactions
    if (test) {
      try { await test(p, ctx, result); }
      catch (e) { result.issues.push(`Interaction failed: ${e.message}`); }
    }

    if (jsErrors.length)    result.issues.push(`JS error(s): ${jsErrors.slice(0, 3).join(' | ')}`);
    if (apiFailures.length) result.issues.push(`API failure(s): ${apiFailures.slice(0, 4).join(', ')}`);
    if (result.issues.length) result.status = 'warn';

    // If JS errors or API failures that caused real visible breakage, mark broken
    if (jsErrors.some(e => e.includes('Cannot') || e.includes('Uncaught')) && result.issues.length > 1) {
      result.status = 'broken';
    }

  } catch (e) {
    result.issues.push(`Exception: ${e.message}`);
    result.status = 'broken';
    await shot(p, 'exception', ctx).catch(() => {});
  }

  await p.close();
  result.shots = ctx.shots;
  return result;
}

// ─── per-page interaction scripts ─────────────────────────────────────────────

const PAGES = [

  {
    name: 'Dashboard',
    path: 'index.html',
    async test(p, ctx) {
      // Try the time filter
      const tf = await p.$('#timeFilter');
      if (tf) {
        await tf.selectOption('30');
        await waitForData(p);
        await shot(p, 'filter-30-days', ctx);
      }
      // Try client filter if multiple options
      const cf = await p.$('#clientFilter');
      if (cf) {
        const opts = await cf.$$('option');
        if (opts.length > 2) {
          await cf.selectOption({ index: 1 });
          await waitForData(p);
          await shot(p, 'filter-client', ctx);
          await cf.selectOption({ index: 0 }); // reset
        }
      }
    }
  },

  {
    name: 'Actions',
    path: 'actions.html',
    async test(p, ctx) {
      // Toggle to agency view
      const agBtn = await p.$('#agencyBtn, [onclick*="agencyBtn"], button:has-text("Agency")');
      if (agBtn) {
        await agBtn.click();
        await waitForData(p);
        await shot(p, 'agency-view', ctx);
      }
      // Click first workspace tab if available
      const wsTab = await p.$('.ws-tab');
      if (wsTab) {
        await wsTab.click();
        await waitForData(p);
        await shot(p, 'workspace-tab', ctx);
      }
      // Switch back to actions view
      const actBtn = await p.$('#actionsBtn, button:has-text("Actions")');
      if (actBtn) { await actBtn.click(); await waitForData(p); }
    }
  },

  {
    name: 'Admin',
    path: 'admin.html',
    async test(p, ctx) {
      // Check managers and settings tabs if present
      const tabs = await p.$$('.tab, [role="tab"], .nav-tab');
      for (let i = 1; i < Math.min(tabs.length, 4); i++) {
        await tabs[i].click().catch(() => {});
        await p.waitForTimeout(500);
      }
      await shot(p, 'tabs', ctx);
    }
  },

  {
    name: 'Apollo Prep',
    path: 'apollo-prep.html',
    async test(p, ctx) {
      // Check any workspace or client selector
      const ws = await p.$('select, #wsSelect, #clientSelect');
      if (ws) {
        const opts = await ws.$$('option');
        if (opts.length > 1) { await ws.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'workspace', ctx); }
      }
    }
  },

  { name: 'Automation',    path: 'automation.html',    test: null },
  {
    name: 'Campaigns',
    path: 'campaigns.html',
    async test(p, ctx) {
      // Click first workspace tab
      const wsTab = await p.$('.ws-tab');
      if (wsTab) { await wsTab.click(); await waitForData(p); await shot(p, 'workspace', ctx); }
      // Sort by reply rate
      const sortBtn = await p.$('[data-sort="replyRate"], [onclick*="replyRate"], th:has-text("Reply")');
      if (sortBtn) { await sortBtn.click(); await p.waitForTimeout(400); await shot(p, 'sorted-reply-rate', ctx); }
      // Expand first campaign row
      const campRow = await p.$('.camp-row, tbody tr');
      if (campRow) { await campRow.click(); await p.waitForTimeout(500); await shot(p, 'row-expanded', ctx); }
    }
  },

  {
    name: 'Capacity',
    path: 'capacity.html',
    async test(p, ctx) {
      const ws = await p.$('.ws-tab, #wsSelect');
      if (ws) { await ws.click().catch(() => ws.selectOption && ws.selectOption({ index: 1 })); await waitForData(p); await shot(p, 'workspace', ctx); }
    }
  },

  {
    name: 'Clients',
    path: 'clients.html',
    async test(p, ctx) {
      // Search
      const search = await p.$('#searchInput, input[placeholder*="search" i], input[type="search"]');
      if (search) {
        await search.fill('a');
        await p.waitForTimeout(400);
        await shot(p, 'search-a', ctx);
        await search.fill('');
      }
      // Open add-client modal
      const addBtn = await p.$('button:has-text("Add"), button:has-text("New"), [onclick*="openModal"]');
      if (addBtn) {
        await addBtn.click();
        await p.waitForTimeout(600);
        await shot(p, 'modal-open', ctx);
        // Close it
        const closeBtn = await p.$('[onclick*="closeModal"], button:has-text("Cancel"), button:has-text("Close"), .modal-close');
        if (closeBtn) await closeBtn.click();
      }
    }
  },

  {
    name: 'Client Detail',
    path: 'client.html',
    async test(p, ctx) {
      // This page needs a client in the URL — try to get first client id
      // For now just check what loads
      const text = await p.evaluate(() => document.body.innerText.trim().length);
      if (text < 150) {
        // Try navigating with a known workspace
        await p.goto(`${BASE}/client.html?ws=6912ddfef9582848982b9a62`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForData(p);
        await shot(p, 'with-client-id', ctx);
      }
    }
  },

  {
    name: 'Combo Analysis',
    path: 'combo-analysis.html',
    async test(p, ctx) {
      const ws = await p.$('#wsSelect, select');
      if (ws) { const opts = await ws.$$('option'); if (opts.length > 1) { await ws.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'workspace', ctx); } }
    }
  },

  {
    name: 'Commission',
    path: 'commission.html',
    async test(p, ctx) {
      const filter = await p.$('select, #monthFilter, #periodFilter');
      if (filter) { const opts = await filter.$$('option'); if (opts.length > 1) { await filter.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'filtered', ctx); } }
    }
  },

  {
    name: 'Contacts DB',
    path: 'contacts.html',
    async test(p, ctx) {
      // Try search
      const search = await p.$('input[placeholder*="search" i], #searchInput, #q');
      if (search) { await search.fill('tech'); await p.waitForTimeout(600); await shot(p, 'search', ctx); await search.fill(''); }
      // Check filters
      const filter = await p.$('select, #statusFilter, #industryFilter');
      if (filter) { const opts = await filter.$$('option'); if (opts.length > 1) { await filter.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'filter', ctx); } }
    }
  },

  {
    name: 'Copy Review',
    path: 'copy.html',
    async test(p, ctx) {
      // Select a workspace
      const ws = await p.$('#wsSelect');
      if (ws) {
        const opts = await ws.$$('option');
        if (opts.length > 1) { await ws.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'workspace-selected', ctx); }
      }
      // Click through tabs
      const tabs = await p.$$('.tab, [data-tab]');
      for (const tab of tabs.slice(0, 4)) {
        await tab.click().catch(() => {});
        await p.waitForTimeout(400);
      }
      await shot(p, 'tabs', ctx);
    }
  },

  {
    name: 'Database',
    path: 'database.html',
    async test(p, ctx) {
      const filter = await p.$('select, #filterSelect');
      if (filter) { const opts = await filter.$$('option'); if (opts.length > 1) { await filter.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'filtered', ctx); } }
    }
  },

  {
    name: 'Diagnostics',
    path: 'diagnostics.html',
    async test(p, ctx) {
      const tabs = await p.$$('.tab, [data-tab], .tab-btn');
      for (const tab of tabs.slice(0, 3)) { await tab.click().catch(() => {}); await p.waitForTimeout(400); }
      await shot(p, 'tabs', ctx);
    }
  },

  {
    name: 'DMARC',
    path: 'dmarc.html',
    async test(p, ctx) {
      const filter = await p.$('#wsFilter, #clientFilter, select');
      if (filter) { const opts = await filter.$$('option'); if (opts.length > 1) { await filter.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'filtered', ctx); } }
    }
  },

  {
    name: 'Domains',
    path: 'domains.html',
    async test(p, ctx) {
      // Filter pills
      const pills = await p.$$('.filter-pill, [onclick*="setFilter"]');
      if (pills.length > 1) { await pills[1].click(); await waitForData(p); await shot(p, 'filter-pill', ctx); }
      // Search
      const search = await p.$('#search, input[placeholder*="search" i]');
      if (search) { await search.fill('gmail'); await p.waitForTimeout(400); await shot(p, 'search', ctx); await search.fill(''); }
      // Try opening check-domain modal
      const checkBtn = await p.$('[onclick*="openCheckModal"], button:has-text("Check")');
      if (checkBtn) { await checkBtn.click(); await p.waitForTimeout(400); await shot(p, 'check-modal', ctx); const close = await p.$('[onclick*="closeCheckModal"], .modal-close, button:has-text("Cancel")'); if (close) await close.click(); }
    }
  },

  { name: 'Email Finder',  path: 'email-finder.html',  test: null },
  { name: 'Email Verify',  path: 'email-verify2.html', test: null },

  {
    name: 'Finance',
    path: 'finance.html',
    async test(p, ctx) {
      // Change month
      const mp = await p.$('#monthPicker');
      if (mp) {
        const opts = await mp.$$('option');
        if (opts.length > 1) { await mp.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'prev-month', ctx); await mp.selectOption({ index: 0 }); }
      }
      // Toggle expense filter tabs
      const expFilters = await p.$$('[id^="expFilter-"]');
      for (const f of expFilters.slice(0, 3)) { await f.click().catch(() => {}); await p.waitForTimeout(300); }
      await shot(p, 'expense-filters', ctx);
      // Toggle manual section
      const manBtn = await p.$('[onclick*="toggleManualSection"], button:has-text("Manual")');
      if (manBtn) { await manBtn.click(); await p.waitForTimeout(400); await shot(p, 'manual-section', ctx); }
    }
  },

  {
    name: 'Health',
    path: 'health.html',
    async test(p, ctx) {
      // View toggles
      const vtAll = await p.$('#vt-all, [onclick*="setView"]');
      if (vtAll) { await vtAll.click(); await waitForData(p); await shot(p, 'view-all', ctx); }
      // Toggle healthy clients
      const toggleHealthy = await p.$('[onclick*="toggleHealthy"], button:has-text("healthy")');
      if (toggleHealthy) { await toggleHealthy.click(); await p.waitForTimeout(400); await shot(p, 'toggle-healthy', ctx); }
    }
  },

  {
    name: 'ICP',
    path: 'icp.html',
    async test(p, ctx) {
      const ws = await p.$('#wsSelect, #clientSelect, select');
      if (ws) { const opts = await ws.$$('option'); if (opts.length > 1) { await ws.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'workspace', ctx); } }
    }
  },

  {
    name: 'Intelligence',
    path: 'intelligence.html',
    async test(p, ctx) {
      const tabs = await p.$$('.tab, [data-tab], .tab-btn');
      for (const tab of tabs.slice(0, 4)) { await tab.click().catch(() => {}); await p.waitForTimeout(400); }
      await shot(p, 'tabs', ctx);
    }
  },

  {
    name: 'Leads Analysis',
    path: 'leads-analysis.html',
    async test(p, ctx) {
      const ws = await p.$('#wsSelect, select');
      if (ws) { const opts = await ws.$$('option'); if (opts.length > 1) { await ws.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'workspace', ctx); } }
    }
  },

  {
    name: 'Mailboxes',
    path: 'mailboxes.html',
    async test(p, ctx) {
      // Filter by status
      const statusF = await p.$('#statusFilter');
      if (statusF) { const opts = await statusF.$$('option'); if (opts.length > 1) { await statusF.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'filter-status', ctx); await statusF.selectOption({ index: 0 }); } }
      // Filter by supplier
      const suppF = await p.$('#supplierFilter');
      if (suppF) { const opts = await suppF.$$('option'); if (opts.length > 1) { await suppF.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'filter-supplier', ctx); await suppF.selectOption({ index: 0 }); } }
      // Attention only toggle
      const att = await p.$('#attentionOnly');
      if (att) { await att.click(); await p.waitForTimeout(400); await shot(p, 'attention-only', ctx); await att.click(); }
    }
  },

  {
    name: 'Metrics',
    path: 'metrics.html',
    async test(p, ctx) {
      const filter = await p.$('select, #wsFilter, #clientFilter');
      if (filter) { const opts = await filter.$$('option'); if (opts.length > 1) { await filter.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'filtered', ctx); } }
    }
  },

  {
    name: 'Performance',
    path: 'performance.html',
    async test(p, ctx) {
      // Agency vs actions toggle
      const agBtn = await p.$('#agencyBtn, button:has-text("Agency")');
      if (agBtn) { await agBtn.click(); await waitForData(p); await shot(p, 'agency-view', ctx); }
      // Date range buttons
      const weekBtn = await p.$('#agBtnWeek, [onclick*="agBtnWeek"], button:has-text("Week")');
      if (weekBtn) { await weekBtn.click(); await waitForData(p); await shot(p, 'week-view', ctx); }
    }
  },

  {
    name: 'Placement',
    path: 'placement.html',
    async test(p, ctx) {
      const filter = await p.$('#wsFilter, select');
      if (filter) { const opts = await filter.$$('option'); if (opts.length > 1) { await filter.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'filtered', ctx); } }
    }
  },

  {
    name: 'Postmaster',
    path: 'postmaster.html',
    async test(p, ctx) {
      // Filter pills
      const pills = await p.$$('.filter-pill, [onclick*="setFilter"]');
      if (pills.length > 1) { await pills[1].click(); await waitForData(p); await shot(p, 'filter-alerts', ctx); }
      // Search
      const search = await p.$('#search, input[type="search"]');
      if (search) { await search.fill('gmail'); await p.waitForTimeout(400); await shot(p, 'search', ctx); await search.fill(''); }
      // Click a row to open detail modal
      const row = await p.$('tbody tr');
      if (row) { await row.click(); await p.waitForTimeout(500); await shot(p, 'detail-modal', ctx); const esc = async () => p.keyboard.press('Escape'); await esc(); }
    }
  },

  {
    name: 'Stats',
    path: 'stats.html',
    async test(p, ctx) {
      // Period buttons
      const btn7d = await p.$('[onclick*="7d"], button:has-text("7D"), button:has-text("7d")');
      if (btn7d) { await btn7d.click(); await waitForData(p); await shot(p, 'period-7d', ctx); }
      const btn30 = await p.$('[onclick*="30d"], button:has-text("30D"), button:has-text("30d")');
      if (btn30) { await btn30.click(); await waitForData(p); await shot(p, 'period-30d', ctx); }
      // Expand first client card
      const card = await p.$('.client-card');
      if (card) { await card.click(); await p.waitForTimeout(500); await shot(p, 'client-expanded', ctx); }
    }
  },

  {
    name: 'Verify Split',
    path: 'verify-split.html',
    test: null
  },

  {
    name: 'Workload',
    path: 'workload.html',
    async test(p, ctx) {
      const filter = await p.$('select, #wsFilter');
      if (filter) { const opts = await filter.$$('option'); if (opts.length > 1) { await filter.selectOption({ index: 1 }); await waitForData(p); await shot(p, 'filtered', ctx); } }
    }
  },

];

// ─── HTML report builder ───────────────────────────────────────────────────────

function buildReport(results, durationMs) {
  const total   = results.length;
  const ok      = results.filter(r => r.status === 'ok').length;
  const warn    = results.filter(r => r.status === 'warn').length;
  const broken  = results.filter(r => r.status === 'broken').length;

  const statusIcon  = s => s === 'ok' ? '✓' : s === 'warn' ? '⚠' : '✗';
  const statusColor = s => s === 'ok' ? '#22c55e' : s === 'warn' ? '#f59e0b' : '#ef4444';
  const statusBg    = s => s === 'ok' ? '#052e16' : s === 'warn' ? '#451a03' : '#3b0a0a';

  const pageHtml = results.map(r => {
    const shotsHtml = r.shots.map(s => `
      <div class="shot">
        <div class="shot-label">${s.label}</div>
        <img src="${b64(s.file)}" alt="${s.label}" loading="lazy">
      </div>`).join('');

    const issuesHtml = r.issues.length
      ? `<div class="issues">${r.issues.map(i => `<div class="issue">⚠ ${escHtml(i)}</div>`).join('')}</div>`
      : '';

    return `
    <div class="page-section" id="${r.path}">
      <div class="page-header" style="border-left: 4px solid ${statusColor(r.status)}">
        <span class="status-badge" style="background:${statusBg(r.status)};color:${statusColor(r.status)}">${statusIcon(r.status)} ${r.status.toUpperCase()}</span>
        <span class="page-name">${r.name}</span>
        <span class="page-path">${r.path}</span>
        ${r.httpStatus ? `<span class="http-status">HTTP ${r.httpStatus}</span>` : ''}
      </div>
      ${issuesHtml}
      <div class="shots-grid">${shotsHtml}</div>
    </div>`;
  }).join('\n');

  const navHtml = results.map(r =>
    `<a href="#${r.path}" class="nav-item" style="color:${statusColor(r.status)}">${statusIcon(r.status)} ${r.name}</a>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Ottaly Dashboard — QA Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0a; color: #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; }
  .top-bar { background: #111; border-bottom: 1px solid #222; padding: 16px 24px; display: flex; align-items: center; gap: 16px; position: sticky; top: 0; z-index: 100; }
  .top-bar h1 { font-size: 16px; font-weight: 600; color: #f9fafb; }
  .summary-pills { display: flex; gap: 8px; margin-left: auto; }
  .pill { padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .pill-ok   { background: #052e16; color: #22c55e; }
  .pill-warn { background: #451a03; color: #f59e0b; }
  .pill-bad  { background: #3b0a0a; color: #ef4444; }
  .pill-info { background: #1e3a5f; color: #60a5fa; }
  .layout { display: flex; }
  .sidebar { width: 200px; min-width: 200px; background: #111; border-right: 1px solid #222; height: calc(100vh - 53px); overflow-y: auto; position: sticky; top: 53px; padding: 12px 0; }
  .nav-item { display: block; padding: 6px 16px; font-size: 12px; text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nav-item:hover { background: #1a1a1a; }
  .content { flex: 1; overflow-x: hidden; padding: 24px; }
  .page-section { margin-bottom: 40px; border: 1px solid #222; border-radius: 8px; overflow: hidden; }
  .page-header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #111; flex-wrap: wrap; }
  .status-badge { padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .page-name { font-weight: 600; font-size: 15px; color: #f9fafb; }
  .page-path { color: #6b7280; font-size: 12px; font-family: monospace; }
  .http-status { margin-left: auto; color: #4b5563; font-size: 12px; }
  .issues { padding: 10px 16px; background: #1a0a0a; border-bottom: 1px solid #3b0a0a; }
  .issue { color: #f87171; font-size: 12px; padding: 3px 0; font-family: monospace; }
  .shots-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 1px; background: #222; }
  .shot { background: #0d0d0d; padding: 10px; }
  .shot-label { font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .shot img { width: 100%; border-radius: 4px; border: 1px solid #222; display: block; cursor: zoom-in; }
  /* Lightbox */
  #lb { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.92); z-index: 9999; align-items: center; justify-content: center; cursor: zoom-out; }
  #lb.open { display: flex; }
  #lb img { max-width: 95vw; max-height: 95vh; border-radius: 4px; }
  .duration { color: #4b5563; font-size: 12px; }
</style>
</head>
<body>
<div class="top-bar">
  <h1>Ottaly QA Report</h1>
  <span class="duration">${new Date().toLocaleString()} — ${(durationMs/1000).toFixed(0)}s</span>
  <div class="summary-pills">
    <span class="pill pill-ok">${ok} OK</span>
    <span class="pill pill-warn">${warn} Warn</span>
    <span class="pill pill-bad">${broken} Broken</span>
    <span class="pill pill-info">${total} pages</span>
  </div>
</div>
<div class="layout">
  <nav class="sidebar">${navHtml}</nav>
  <main class="content">${pageHtml}</main>
</div>
<div id="lb"><img id="lb-img" src=""></div>
<script>
  document.querySelectorAll('.shot img').forEach(img => {
    img.onclick = e => {
      e.stopPropagation();
      document.getElementById('lb-img').src = img.src;
      document.getElementById('lb').classList.add('open');
    };
  });
  document.getElementById('lb').onclick = () => document.getElementById('lb').classList.remove('open');
  document.onkeydown = e => { if (e.key === 'Escape') document.getElementById('lb').classList.remove('open'); };
</script>
</body>
</html>`;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  OTTALY DASHBOARD — VISUAL QA SUITE');
  console.log('═══════════════════════════════════════════════════\n');

  ensureDir(REPORT_DIR);
  ensureDir(path.join(REPORT_DIR, 'screenshots'));

  // Login
  console.log('[ Logging in… ]');
  const rc = await playwrightRequest.newContext({ ignoreHTTPSErrors: true, baseURL: BASE });
  const loginResp = await rc.post('/api/admin/login', {
    data: { key: ADMIN_KEY },
    headers: { 'Content-Type': 'application/json' },
  });
  if (!loginResp.ok()) {
    console.error(`Login failed: HTTP ${loginResp.status()}`);
    process.exit(1);
  }
  const cookies = await rc.storageState();
  console.log('  ✓ Logged in\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--window-size=1440,900'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: cookies,
    viewport: { width: 1440, height: 900 },
  });

  const start = Date.now();
  const results = [];

  for (const def of PAGES) {
    process.stdout.write(`  Testing ${def.name.padEnd(25)}`);
    const result = await testPage(context, cookies, def);
    results.push(result);
    const icon = result.status === 'ok' ? '✓' : result.status === 'warn' ? '⚠' : '✗';
    const shots = result.shots.length;
    const issues = result.issues.length;
    console.log(`${icon}  (${shots} shots${issues ? ', ' + issues + ' issue(s)' : ''})`);
    if (result.issues.length) {
      result.issues.slice(0, 2).forEach(i => console.log(`    ↳ ${i.slice(0, 100)}`));
    }
  }

  const duration = Date.now() - start;

  // Build and save report
  console.log('\n[ Building report… ]');
  const html = buildReport(results, duration);
  const reportPath = path.join(REPORT_DIR, 'index.html');
  fs.writeFileSync(reportPath, html);

  // Summary
  const ok     = results.filter(r => r.status === 'ok').length;
  const warn   = results.filter(r => r.status === 'warn').length;
  const broken = results.filter(r => r.status === 'broken').length;

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  DONE in ${(duration/1000).toFixed(0)}s`);
  console.log(`  ✓ ${ok} OK   ⚠ ${warn} warnings   ✗ ${broken} broken`);
  console.log(`\n  Report: ${reportPath}`);
  console.log('═══════════════════════════════════════════════════\n');

  await browser.close();
  await rc.dispose();

  // Auto-open the report
  const { execSync } = require('child_process');
  try { execSync(`open "${reportPath}"`); } catch {}
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
