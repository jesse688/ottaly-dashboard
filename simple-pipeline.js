#!/usr/bin/env node
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { chromium } = require('playwright');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { google } = require('googleapis');

const ROOT = __dirname;
const DOWNLOAD_DIR = path.resolve(ROOT, process.env.AUTOMATION_DOWNLOAD_DIR || 'downloads');
const RUN_DIR = path.resolve(ROOT, process.env.AUTOMATION_RUN_DIR || 'automation-runs');
const APOLLO_BASE = 'https://app.apollo.io';
const PV_BASE = process.env.PLUSVIBE_API_BASE || 'https://api.plusvibe.ai/api/v1';

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

function boolEnv(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeName(value) {
  return String(value || 'apollo-campaign').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
}

function plusVibeKeyFor(workspaceId) {
  const keyName = `PV_KEY_${String(workspaceId).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return process.env[keyName] || process.env.PLUSVIBE_KEY || '';
}

function browserLaunchOptions() {
  const options = { headless: boolEnv('HEADLESS', true) };
  if (process.env.PROXY_SERVER) {
    options.proxy = {
      server: process.env.PROXY_SERVER,
      username: process.env.PROXY_USERNAME || undefined,
      password: process.env.PROXY_PASSWORD || undefined,
    };
  }
  return options;
}

function campaignNameFromUrl(rawUrl, fallbackWorkspace = 'Campaign') {
  try {
    const u = new URL(rawUrl);
    const parts = [];
    const title = u.searchParams.get('personTitles') || u.searchParams.get('person_titles') || u.searchParams.get('titles[]');
    const country = u.searchParams.get('countries') || u.searchParams.get('personLocations') || u.searchParams.get('locations[]');
    const industry = u.searchParams.get('qOrganizationKeywordTags') || u.searchParams.get('organizationIndustryTagIds');
    if (title) parts.push(title);
    if (country) parts.push(country);
    if (industry) parts.push(industry);
    return parts.length ? parts.map(v => decodeURIComponent(v).replace(/[,+]/g, ' ')).join(' - ') : `${fallbackWorkspace} Apollo Import ${new Date().toISOString().slice(0, 10)}`;
  } catch {
    return `${fallbackWorkspace} Apollo Import ${new Date().toISOString().slice(0, 10)}`;
  }
}

function createLogger(runId) {
  ensureDir(RUN_DIR);
  const logPath = path.join(RUN_DIR, `${runId}.log`);
  function log(message, data) {
    const line = `[${new Date().toISOString()}] ${message}${data ? ` ${JSON.stringify(data)}` : ''}`;
    fs.appendFileSync(logPath, `${line}\n`);
    console.log(line);
  }
  return { log, logPath };
}

async function clickFirst(page, labels, timeout = 8000) {
  const candidates = Array.isArray(labels) ? labels : [labels];
  for (const label of candidates) {
    const locators = [
      page.getByRole('button', { name: label }),
      page.getByRole('link', { name: label }),
      page.getByText(label, { exact: false }),
    ];
    if (typeof label === 'string') {
      locators.push(page.locator(`[aria-label*="${label}"]`));
      locators.push(page.locator(`text=${label}`));
    }
    for (const locator of locators) {
      try {
        await locator.first().click({ timeout });
        return true;
      } catch {}
    }
  }
  return false;
}

async function fillFirst(page, labels, value, timeout = 6000) {
  const candidates = Array.isArray(labels) ? labels : [labels];
  for (const label of candidates) {
    const locators = [
      page.getByLabel(label),
      page.getByPlaceholder(label),
      page.locator(`input[name*="${label}" i]`),
      page.locator(`input[aria-label*="${label}" i]`),
    ];
    for (const locator of locators) {
      try {
        await locator.first().fill(value, { timeout });
        return true;
      } catch {}
    }
  }
  return false;
}

async function saveDebugSnapshot(page, runDownloadDir, name, log) {
  const safeName = sanitizeName(name || 'snapshot');
  const screenshotPath = path.join(runDownloadDir, `${safeName}-${stamp()}.png`);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 10000 });
    log('Saved browser snapshot', { screenshotPath, url: page.url() });
  } catch (err) {
    log('Could not save browser snapshot', { error: err.message, url: page.url() });
  }
}

async function loginApollo(page, runDownloadDir, log) {
  if (!process.env.APOLLO_EMAIL || !process.env.APOLLO_PASSWORD) {
    throw new Error('APOLLO_EMAIL and APOLLO_PASSWORD are required');
  }
  log('Logging into Apollo');
  await page.goto(`${APOLLO_BASE}/#/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const filledEmail = await fillFirst(page, ['Email', 'email'], process.env.APOLLO_EMAIL, 12000);
  const filledPassword = await fillFirst(page, ['Password', 'password'], process.env.APOLLO_PASSWORD, 12000);
  if (!filledEmail || !filledPassword) {
    await saveDebugSnapshot(page, runDownloadDir, 'apollo-login-fields-missing', log);
    throw new Error('Apollo login fields were not found. Check the saved screenshot for the login page state.');
  }
  const clickedLogin = await clickFirst(page, [/log in/i, /sign in/i, 'Log In', 'Sign In'], 8000);
  if (!clickedLogin) {
    await saveDebugSnapshot(page, runDownloadDir, 'apollo-login-button-missing', log);
    throw new Error('Apollo login button was not found. Check the saved screenshot for the login page state.');
  }
  await page.waitForURL(url => !String(url).includes('/login'), { timeout: 45000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  if (page.url().includes('/login')) {
    await saveDebugSnapshot(page, runDownloadDir, 'apollo-login-not-complete', log);
    throw new Error('Apollo login did not complete. Apollo may require verification, the password may be wrong, or the account may need a manual login check.');
  }
  log('Apollo login completed', { url: page.url() });
}

async function sortApolloSearch(page, log) {
  if (!boolEnv('APOLLO_ENABLE_SORT', false)) {
    log('Skipping Apollo sort during calibration', { enableWith: 'APOLLO_ENABLE_SORT=true' });
    return;
  }
  log('Applying Apollo sort order');
  const sortedName = await clickFirst(page, ['Sort by Name', 'Person Name'], 2500).catch(() => false);
  const sortedTitle = await clickFirst(page, ['Sort by Job Title', 'Job Title'], 2500).catch(() => false);
  log('Apollo sort attempt finished', { sortedName, sortedTitle });
}

async function scrapeApollo(page, apolloUrl, pages, runDownloadDir, log) {
  log('Opening Apollo search', { apolloUrl });
  await page.goto(apolloUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await saveDebugSnapshot(page, runDownloadDir, 'apollo-search-loaded', log);
  await sortApolloSearch(page, log);

  log('Starting Apollo scrape', { pages });
  const opened = await clickFirst(page, ['Attention', 'Scrape', 'Export', 'Download'], 5000);
  if (!opened) {
    await saveDebugSnapshot(page, runDownloadDir, 'apollo-scrape-control-missing', log);
    throw new Error('Could not find Apollo scrape/export control. Open the saved screenshot and tell me the exact button text for the scrape menu.');
  }
  await fillFirst(page, ['Pages', 'Number of pages', 'page'], String(pages), 4000).catch(() => {});
  const downloadPromise = page.waitForEvent('download', { timeout: 10 * 60 * 1000 });
  const started = await clickFirst(page, ['Scrape', 'Start scrape', 'Start', 'Download CSV', 'Export'], 5000);
  if (!started) {
    await saveDebugSnapshot(page, runDownloadDir, 'apollo-start-scrape-missing', log);
    throw new Error('Opened scrape/export menu but could not find the final scrape/start/download button.');
  }
  const download = await downloadPromise;
  const filePath = path.join(runDownloadDir, `contacts-${stamp()}.csv`);
  await download.saveAs(filePath);
  log('Apollo scrape downloaded', { filePath });
  return filePath;
}

async function uploadAndExportApollo(page, csvPath, campaignName, runDownloadDir, log) {
  log('Uploading scrape back to Apollo and exporting saved contacts');
  await page.goto(`${APOLLO_BASE}/#/people`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await clickFirst(page, ['Upload', 'Import'], 12000);
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(csvPath);
  await fillFirst(page, ['List name', 'Name'], campaignName, 5000).catch(() => {});
  await clickFirst(page, ['Create list', 'Add to list', 'Upload', 'Next', 'Confirm'], 8000).catch(() => {});
  await page.waitForTimeout(120000);

  await clickFirst(page, ['Saved', 'Saved contacts', 'Lists'], 12000).catch(() => {});
  await clickFirst(page, ['Select all', 'All'], 8000).catch(() => {});
  const downloadPromise = page.waitForEvent('download', { timeout: 8 * 60 * 1000 });
  await clickFirst(page, ['Export', 'Export CSV', 'Download CSV'], 12000);
  const download = await downloadPromise;
  const filePath = path.join(runDownloadDir, `apollo-export-${stamp()}.csv`);
  await download.saveAs(filePath);
  log('Apollo export downloaded', { filePath });
  return filePath;
}

function driveClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function verifyViaDrive(csvPath, runDownloadDir, log) {
  const folderId = process.env.VERIFIER_FOLDER_ID;
  const drive = driveClient();
  if (!folderId || !drive) {
    log('Google Drive verifier not configured; using Apollo export as verified file');
    return csvPath;
  }

  const basename = path.basename(csvPath);
  log('Uploading CSV to verifier folder', { folderId, basename });
  const uploaded = await drive.files.create({
    requestBody: { name: basename, parents: [folderId] },
    media: { mimeType: 'text/csv', body: fs.createReadStream(csvPath) },
    fields: 'id,name',
  });

  const pollSeconds = Number(process.env.VERIFIER_POLL_SECONDS || 30);
  const timeoutMs = Number(process.env.VERIFIER_TIMEOUT_MINUTES || 12) * 60 * 1000;
  const starts = Date.now();
  const baseNoExt = basename.replace(/\.csv$/i, '');
  while (Date.now() - starts < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollSeconds * 1000));
    const q = `'${folderId}' in parents and trashed=false and name contains '${baseNoExt}'`;
    const list = await drive.files.list({ q, fields: 'files(id,name,createdTime)', orderBy: 'createdTime desc', pageSize: 20 });
    const verified = (list.data.files || []).find(f => /verified|valid|clean/i.test(f.name) && f.id !== uploaded.data.id);
    if (verified) {
      const dest = path.join(runDownloadDir, `verified-${sanitizeName(verified.name)}`);
      const response = await drive.files.get({ fileId: verified.id, alt: 'media' }, { responseType: 'stream' });
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        response.data.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
      });
      log('Downloaded verified file', { filePath: dest });
      return dest;
    }
    log('Waiting for verifier output');
  }

  log('Verifier timed out; using Apollo export as fallback');
  return csvPath;
}

function readCsvLeads(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(text, { columns: true, skip_empty_lines: true, bom: true, relax_quotes: true });
  return rows.map(row => ({
    first_name: row.first_name || row['First Name'] || row.FirstName || '',
    last_name: row.last_name || row['Last Name'] || row.LastName || '',
    email: row.email || row.Email || row['Email Address'] || '',
    company_name: row.company_name || row.Company || row['Company Name'] || row.organization_name || '',
    job_title: row.job_title || row.Title || row['Job Title'] || '',
    city: row.city || row.City || '',
    country: row.country || row.Country || '',
    linkedin_url: row.linkedin_url || row.LinkedIn || row['LinkedIn URL'] || '',
    website: row.website || row.Website || row['Company Website'] || '',
    phone: row.phone || row.Phone || row['Phone Number'] || '',
  })).filter(lead => lead.email);
}

async function pvRequest(method, endpoint, apiKey, body) {
  const res = await axios({
    method,
    url: `${PV_BASE}${endpoint}`,
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    data: body,
    timeout: 60000,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw new Error(`PlusVibe ${res.status}: ${JSON.stringify(res.data).slice(0, 500)}`);
  }
  return res.data;
}

async function createPlusVibeCampaign(workspaceId, campaignName, apiKey, log) {
  log('Creating PlusVibe campaign', { workspaceId, campaignName });
  const payloads = [
    { workspace_id: workspaceId, name: campaignName },
    { workspace_id: workspaceId, campaign_name: campaignName },
  ];
  let lastError;
  for (const payload of payloads) {
    try {
      const data = await pvRequest('POST', '/campaign/create', apiKey, payload);
      return data.id || data._id || data.campaign_id || data.campaign?.id || data.data?.id;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Could not create PlusVibe campaign');
}

async function uploadPlusVibeLeads(verifiedCsv, workspaceId, campaignId, apiKey, log) {
  const leads = readCsvLeads(verifiedCsv);
  if (!leads.length) throw new Error('No leads with email addresses found in verified CSV');
  log('Uploading leads to PlusVibe', { count: leads.length, campaignId });

  for (let i = 0; i < leads.length; i += 500) {
    const batch = leads.slice(i, i + 500);
    const body = { workspace_id: workspaceId, campaign_id: campaignId, leads: batch };
    try {
      await pvRequest('POST', '/lead/import', apiKey, body);
    } catch {
      await pvRequest('POST', '/lead/create/bulk', apiKey, body);
    }
    log('Uploaded PlusVibe lead batch', { from: i + 1, to: i + batch.length });
  }
  return leads.length;
}

async function run() {
  const apolloUrl = arg('url');
  const workspaceId = arg('workspace-id') || arg('workspace');
  const workspaceName = arg('workspace-name', workspaceId || 'Workspace');
  const dryRun = process.argv.includes('--dry-run');
  if (!apolloUrl || !workspaceId) {
    console.error('Usage: node simple-pipeline.js --url "<apollo-url>" --workspace-id "<plusvibe-workspace-id>" [--workspace-name "Client"] [--dry-run]');
    process.exit(2);
  }

  const runId = `${sanitizeName(workspaceName)}-${stamp()}`;
  const { log, logPath } = createLogger(runId);
  const runDownloadDir = path.join(DOWNLOAD_DIR, runId);
  ensureDir(runDownloadDir);

  const campaignName = campaignNameFromUrl(apolloUrl, workspaceName);
  const pages = Number(process.env.APOLLO_SCRAPE_PAGES || 100);
  log('Automation run started', { runId, campaignName, workspaceId, dryRun, logPath });

  if (dryRun) {
    const sample = path.join(runDownloadDir, 'dry-run-verified.csv');
    fs.writeFileSync(sample, stringify([{ first_name: 'Test', last_name: 'Lead', email: 'test@example.com', company_name: 'Example Ltd', job_title: 'Founder' }], { header: true }));
    log('Dry run complete', { sample });
    return;
  }

  const launchOptions = browserLaunchOptions();
  log('Launching browser', { headless: launchOptions.headless, proxy: launchOptions.proxy ? launchOptions.proxy.server : 'none' });
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await loginApollo(page, runDownloadDir, log);
    const scrapedCsv = await scrapeApollo(page, apolloUrl, pages, runDownloadDir, log);
    const exportedCsv = await uploadAndExportApollo(page, scrapedCsv, campaignName, runDownloadDir, log);
    const verifiedCsv = await verifyViaDrive(exportedCsv, runDownloadDir, log);
    const apiKey = plusVibeKeyFor(workspaceId);
    if (!apiKey) throw new Error(`No PlusVibe API key configured for workspace ${workspaceId}`);
    const campaignId = await createPlusVibeCampaign(workspaceId, campaignName, apiKey, log);
    const uploaded = await uploadPlusVibeLeads(verifiedCsv, workspaceId, campaignId, apiKey, log);
    log('Automation run completed', { campaignId, uploaded });
  } catch (err) {
    log('Automation run failed', { error: err.message });
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

run().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
