'use strict';
// Cloudflare Access sign-in.
//
// Access sits in front of admin.ottaly.co.uk and has already made the person
// prove their email. It forwards a signed token on every request
// (Cf-Access-Jwt-Assertion). We check that signature against Cloudflare's
// public keys ourselves, so a request that skips Cloudflare (the raw IP, the
// easypanel.host name) cannot fake the header.
//
// Off unless BOTH are set. With them unset nothing here runs.
//   CF_ACCESS_TEAM_DOMAIN  e.g. myteam.cloudflareaccess.com
//   CF_ACCESS_AUD          the Access application's AUD tag
//   ACCESS_ADMIN_EMAILS    comma list of emails that get an admin session.
//                          Anyone else still uses the login page (managers
//                          have their own name + password).
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');

const TEAM = process.env.CF_ACCESS_TEAM_DOMAIN || '';
const AUD  = process.env.CF_ACCESS_AUD || '';
const ADMIN_EMAILS = (process.env.ACCESS_ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

function enabled() { return !!(TEAM && AUD && ADMIN_EMAILS.length); }

let keys = new Map();
let fetchedAt = 0;

async function loadKeys() {
  const r = await fetch(`https://${TEAM}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error('certs ' + r.status);
  const j = await r.json();
  keys = new Map((j.keys || []).map(k => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
  fetchedAt = Date.now();
}

// The verified email from an Access token, or null. Never throws.
async function verifyAccessJwt(token) {
  if (!token || !enabled()) return null;
  try {
    const kid = jwt.decode(token, { complete: true })?.header?.kid;
    if (!kid) return null;
    // Keys rotate every few weeks: refresh hourly, or at most once a minute
    // when a token names a key we have not seen.
    const age = Date.now() - fetchedAt;
    if (!keys.size || age > 3600e3 || (!keys.has(kid) && age > 60e3)) await loadKeys();
    const key = keys.get(kid);
    if (!key) return null;
    const p = jwt.verify(token, key, { algorithms: ['RS256'], issuer: `https://${TEAM}`, audience: AUD });
    // Service tokens (scripts) carry no email. They get no session here.
    return typeof p.email === 'string' && p.email ? p.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isAdminEmail(email) { return ADMIN_EMAILS.includes(String(email).toLowerCase()); }

module.exports = { enabled, verifyAccessJwt, isAdminEmail };
