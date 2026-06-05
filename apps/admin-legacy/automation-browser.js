#!/usr/bin/env node
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = __dirname;
const SESSION_DIR = path.resolve(process.env.APOLLO_SESSION_DIR || '/data/apollo-session');
const DISPLAY = process.env.AUTOMATION_BROWSER_DISPLAY || ':99';
const WIDTH = process.env.AUTOMATION_BROWSER_WIDTH || '1440';
const HEIGHT = process.env.AUTOMATION_BROWSER_HEIGHT || '900';
const VNC_PORT = process.env.AUTOMATION_VNC_PORT || '5900';
const NOVNC_PORT = process.env.AUTOMATION_NOVNC_PORT || '6080';
const START_URL = process.env.AUTOMATION_BROWSER_START_URL || 'https://app.apollo.io/#/login';
process.env.DISPLAY = DISPLAY;

function log(message, data) {
  console.log(`[${new Date().toISOString()}] ${message}${data ? ` ${JSON.stringify(data)}` : ''}`);
}

function startProcess(name, command, args, env = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', code => log(`${name} exited`, { code }));
  return child;
}

function cleanupStaleBrowserProfile() {
  // A previous crashed browser can leave Chromium's profile lock behind.
  // The profile is only used by this automation service, so clear stale owners before launch.
  spawnSync('pkill', ['-f', SESSION_DIR], { stdio: 'ignore' });
  for (const file of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) {
    try { fs.rmSync(path.join(SESSION_DIR, file), { force: true, recursive: true }); } catch {}
  }
}

function browserLaunchOptions() {
  const options = {
    headless: false,
    viewport: null,
    acceptDownloads: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--window-position=0,0',
      `--window-size=${WIDTH},${HEIGHT}`,
    ],
  };
  if (process.env.PROXY_SERVER) {
    options.proxy = {
      server: process.env.PROXY_SERVER,
      username: process.env.PROXY_USERNAME || undefined,
      password: process.env.PROXY_PASSWORD || undefined,
    };
  }
  return options;
}

async function main() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  cleanupStaleBrowserProfile();
  log('Starting automation browser', { sessionDir: SESSION_DIR, novncPort: NOVNC_PORT });

  const children = [];
  let context;

  async function shutdown(exitCode = 0) {
    log('Stopping automation browser');
    if (context) await context.close().catch(() => {});
    for (const child of children.reverse()) child.kill('SIGTERM');
    setTimeout(() => process.exit(exitCode), 500);
  }

  try {
    children.push(startProcess('xvfb', 'Xvfb', [DISPLAY, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-ac']));
    await new Promise(resolve => setTimeout(resolve, 1000));
    children.push(startProcess('fluxbox', 'fluxbox', [], { DISPLAY }));
    await new Promise(resolve => setTimeout(resolve, 1000));
    children.push(startProcess('x11vnc', 'x11vnc', ['-display', DISPLAY, '-forever', '-shared', '-nopw', '-listen', '0.0.0.0', '-rfbport', VNC_PORT], { DISPLAY }));
    children.push(startProcess('novnc', 'websockify', ['--web=/usr/share/novnc', `0.0.0.0:${NOVNC_PORT}`, `localhost:${VNC_PORT}`]));
    await new Promise(resolve => setTimeout(resolve, 1000));

    context = await chromium.launchPersistentContext(SESSION_DIR, {
      ...browserLaunchOptions(),
      env: { ...process.env, DISPLAY },
    });
  } catch (err) {
    console.error(err.stack || err.message);
    await shutdown(1);
    return;
  }

  let page = context.pages()[0] || await context.newPage();
  await page.bringToFront().catch(() => {});
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(err => log('Initial page load failed', { error: err.message }));

  log('Automation browser ready', { url: page.url(), noVncPath: '/vnc.html?autoconnect=true&resize=scale' });

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  await new Promise(() => {});
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
