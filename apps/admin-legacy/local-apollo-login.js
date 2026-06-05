#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const ROOT = __dirname;
const SESSION_DIR = path.join(ROOT, 'recordings', 'apollo-session');
const START_URL = 'https://app.apollo.io/#/login';

function waitForEnter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('\nLog into Apollo in the Chrome window. When Apollo is open, come back here and press Enter...\n', () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  console.log(`Saving Apollo browser session to: ${SESSION_DIR}`);

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    acceptDownloads: true,
    args: ['--start-maximized'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitForEnter();
  await context.close();
  console.log('Apollo browser session saved.');
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
