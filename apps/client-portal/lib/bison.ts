// EmailBison API client (replaces lib/plusvibe.ts).
// Auth: Authorization: Bearer <token>
// Base URL: BISON_API_URL env (defaults to self-hosted instance)
// Workspace context: each API key belongs to one workspace — no workspace_id param needed.

import pool from './db'

const BASE = (process.env.BISON_API_URL || 'https://send.ottaly.co.uk').replace(/\/$/, '')
const ENV_KEY = process.env.BISON_API_KEY || ''

// Bison key resolution: a key saved in the admin Settings UI (portal_settings
// 'bison_api_key') OVERRIDES the BISON_API_KEY env var, which is the fallback.
// Cached briefly so we don't hit the DB on every request, but a key changed in
// the UI takes effect within ~10s — no redeploy. Must be a SUPER-ADMIN key
// (one that can switch into every client team).
let _keyCache: { val: string; at: number } | null = null
export async function getBisonKey(): Promise<string> {
  if (_keyCache && Date.now() - _keyCache.at < 10_000) return _keyCache.val
  let saved = ''
  try {
    const r = await pool.query(`SELECT value FROM portal_settings WHERE key = 'bison_api_key'`)
    saved = (r.rows[0]?.value || '').trim()
  } catch { /* table may not exist yet on first boot */ }
  const val = saved || ENV_KEY
  _keyCache = { val, at: Date.now() }
  return val
}
export function bisonKeySource(): 'dashboard' | 'env' | 'none' {
  if (_keyCache?.val && _keyCache.val !== ENV_KEY) return 'dashboard'
  return ENV_KEY ? 'env' : 'none'
}
export function invalidateBisonKeyCache() { _keyCache = null; _activeTeam = null; _wsTokenCache = null }

// Per-workspace (user) Bison tokens: { [team_id]: plain_text_token }, stored in
// portal_settings 'bison_ws_tokens'. When a team has its own token we use IT as
// the bearer and SKIP switch-workspace entirely — so the portal never disturbs
// the shared session (no "one login at a time" kicking Jesse out of Bison, no
// cross-request collisions). The super-admin key stays as the fallback for teams
// without a minted token and for minting itself. Cached ~10s like the key.
let _wsTokenCache: { val: Record<string, string>; at: number } | null = null
export async function getBisonWsTokens(): Promise<Record<string, string>> {
  if (_wsTokenCache && Date.now() - _wsTokenCache.at < 10_000) return _wsTokenCache.val
  let val: Record<string, string> = {}
  try {
    const r = await pool.query(`SELECT value FROM portal_settings WHERE key = 'bison_ws_tokens'`)
    if (r.rows[0]?.value) val = JSON.parse(r.rows[0].value)
  } catch { /* missing / bad json → no per-ws tokens */ }
  _wsTokenCache = { val, at: Date.now() }
  return val
}
export async function getBisonWsToken(teamId: string | number | null | undefined): Promise<string | null> {
  if (teamId == null || teamId === '') return null
  const tokens = await getBisonWsTokens()
  return tokens[String(teamId)] ?? null
}

// The token the CURRENT serialized operation should use as its bearer. Set by
// withTeam() inside the lock (so it's never raced), read by bison(). null = use
// the super-admin key (getBisonKey).
let _activeToken: string | null = null

// PlusVibe workspace_id → Bison team_id. portal_clients.workspace_id holds the
// PV id; Bison needs the team_id to switch workspace. Requires a SUPER-ADMIN
// BISON_API_KEY (one that can switch into every client team). Update when a
// client is added/migrated to Bison.
export const PV_TO_BISON_TEAM: Record<string, string> = {
  '690ee665bcb253de4fb44538': '3',   // Ottaly
  '6912ddfef9582848982b9a62': '4',   // AccrueAccounting
  '69a9db307af7ef2854f57637': '5',   // ButterflyEco
  '6a0cc49a4a80688441614dfb': '12',  // MagnaMoney
  '69ffaf6904ca7138af16013a': '13',  // Bruud
  '69c43d1e07bf312ff0026643': '14',  // GXI-Furniture
  '69c43d1407bf312ff0026642': '15',  // GXI
  '695259c3d6154e27d164bcf7': '17',  // Indigo
  '699714b02f0830a7148fcf3e': '18',  // Enviro
  '695259dc8de377db7577dc45': '19',  // PPC
  '697e20f02db8460f8ba68792': '20',  // Jumping Spider (JSM)
  '69525a0eceae00718efdaeaa': '21',  // HydrationCompany
  '69a686632f5aaca7d9602c1f': '22',  // Animo
  '6a1d40b3bb80380c1be750c6': '23',  // ButterflyEco SOP
  // Added 2026-06-15 from the Bison workspace lister (matched by team name).
  '6a0e29d0d004be93be3f33f2': '11',  // Bubble
  '6a15cda912293dbfe5eab6c3': '8',   // MDH
  '6a108e69cfbd57f86dbea524': '10',  // Lending Team
  '6a19a054d42a3f59aac110d6': '16',  // LVM
  '6a108e72b20829cbce44fa6c': '9',   // Meades Group (Bison team "Meades")
  '6a15cdb4e4f1d4a2e6d6062a': '7',   // ShireRecoveries (Bison team "Shire")
  '6989ac90bb085fcd05167fc9': '24',  // Josh - Commercial Flooring (Bison team "Josh Flooring")
  // Bison teams with no portal client: 2 (Jesse's Team), 6 (ByboDigital).
}
export function bisonTeamForWorkspace(workspaceId: string): string | null {
  return PV_TO_BISON_TEAM[workspaceId] ?? null
}

// Inverse of PV_TO_BISON_TEAM, computed once at module load. Bison webhooks
// carry the raw team_id; the portal keys everything off the PV workspace_id, so
// every inbound team_id must be reverse-mapped. Returns null for an unmapped
// team (a Bison workspace with no portal_clients row yet).
const BISON_TEAM_TO_PV: Record<string, string> = Object.fromEntries(
  Object.entries(PV_TO_BISON_TEAM).map(([pv, team]) => [team, pv])
)
export function bisonTeamToWorkspace(teamId: string | number): string | null {
  return BISON_TEAM_TO_PV[String(teamId)] ?? null
}

let _activeTeam: string | null = null

// Bison's API is STATEFUL: switch-workspace changes the active workspace for the
// WHOLE token and Bison enforces "one workspace per session". If two requests
// interleave a switch+fetch on the same token, Bison throws "Multiple workspaces
// detected in same session" and the fetch lands on the wrong workspace. So we
// chain every switch+fetch sequence through a single gate — only one runs at a
// time. (admin-legacy does the same with _bisonGate; this is the portal's copy.)
let _gate: Promise<unknown> = Promise.resolve()
function withBisonLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = _gate.then(fn, fn)
  // Keep the chain alive even if a step rejects.
  _gate = run.then(() => undefined, () => undefined)
  return run
}

// Switch the (super-admin) token's active workspace. Stateful — caller must hold
// the lock (use withTeam). Skips the network call if already on that team.
export async function switchWorkspace(teamId: string | number): Promise<void> {
  const id = String(teamId)
  if (_activeTeam === id) return
  await bison('POST', '/api/workspaces/v1.1/switch-workspace', undefined, { team_id: Number(teamId) })
  _activeTeam = id
}

// Atomically switch into a client's team and run a fetch, serialized against all
// other team operations so concurrent client loads never trip Bison's session
// guard. This is the correct entry point for any per-client Bison read.
export async function withTeam<T>(teamId: string | number | null | undefined, fn: () => Promise<T>): Promise<T> {
  return withBisonLock(async () => {
    const wsToken = await getBisonWsToken(teamId)
    if (wsToken) {
      // Per-workspace token: it's already scoped to this team — use it as the
      // bearer and DON'T switch the shared session. This is the preferred path.
      _activeToken = wsToken
      try {
        return await fn()
      } finally {
        _activeToken = null
      }
    }
    // Fallback (no minted token for this team): switch the super-admin key.
    if (teamId != null && teamId !== '') {
      try { await switchWorkspace(teamId) } catch { /* fall through on its own workspace */ }
    }
    return fn()
  })
}

async function headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  // Use the per-workspace token if the current operation set one; else the
  // super-admin key.
  const key = _activeToken ?? await getBisonKey()
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra }
}

async function bison<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  body?: unknown,
): Promise<T> {
  const url = new URL(`${BASE}${path}`)
  if (params && method === 'GET') {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }
  const init: RequestInit = {
    method,
    headers: await headers(),
    signal: AbortSignal.timeout(15000),
  }
  if (body && method !== 'GET') init.body = JSON.stringify(body)

  const res = await fetch(url.toString(), init)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Bison ${method} ${path} -> ${res.status}: ${txt.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface BisonWorkspace {
  id: number
  name: string
  personal_team: boolean
  main: boolean
}

export interface BisonLead {
  id: number
  first_name?: string | null
  last_name?: string | null
  email: string
  title?: string | null
  company?: string | null
  notes?: string | null
  status?: string | null
  custom_variables?: Array<{ name: string; value: string }>
  tags?: Array<{ id: number; name: string }>
  lead_campaign_data?: unknown[]
  created_at?: string
  updated_at?: string
}

// A Bison lead counts as a real "lead" for the portal when it carries the
// "Interested" or "Meeting Booked" tag (Bison's actual signal — there is no
// `interested` boolean on the lead object). Case-insensitive name match.
const LEAD_TAG_NAMES = new Set(['interested', 'meeting booked'])
export function isInterestedLead(l: BisonLead): boolean {
  return (l.tags ?? []).some(t => LEAD_TAG_NAMES.has((t.name ?? '').trim().toLowerCase()))
}

export interface BisonReply {
  id: number
  uuid: string
  folder: string
  subject?: string | null
  read: boolean
  interested: boolean
  automated_reply: boolean
  html_body?: string | null
  text_body?: string | null
  date_received?: string | null
  campaign_id?: number | null
  lead_id?: number | null
  sender_email_id?: number | null
  raw_message_id?: string | null
  from_name?: string | null
  from_email_address?: string | null
  primary_to_email_address?: string | null
  to?: Array<{ name: string | null; address: string }>
  cc?: Array<{ name: string | null; address: string }> | null
  bcc?: Array<{ name: string | null; address: string }> | null
  parent_id?: number | null
  created_at?: string
  updated_at?: string
}

// ── Workspaces ────────────────────────────────────────────────────────────────

export async function getWorkspaces(): Promise<BisonWorkspace[]> {
  const data = await bison<{ data?: BisonWorkspace[] }>('GET', '/api/workspaces')
  return Array.isArray(data) ? (data as unknown as BisonWorkspace[]) : data.data ?? []
}

// ── Leads ────────────────────────────────────────────────────────────────────

// Fetch a client workspace's INTERESTED leads — the real leads.
//
// The lead marker is the `interested` BOOLEAN on each Bison lead (this is what
// the admin dashboard counts). NOTE: Bison's `status` field is the *verification*
// status (verified/risky/unverified/…), NOT the lead status — filtering by
// status=interested does NOT work. So we page through the workspace's leads and
// keep interested===true.
//
// teamId switches to the client's Bison team first (super-admin key) so each
// client's leads are pulled. Pagination is handled INTERNALLY: page 1 returns
// the FULL interested set; later pages return [] so existing while-loop callers
// (`if (!leads.length) break`) terminate after one pass.
const MAX_LEAD_PAGES = 100 // safety cap = 10k raw leads per workspace
export async function getLeads(page = 1, perPage = 100, teamId?: string | number | null): Promise<BisonLead[]> {
  if (page > 1) return []
  // Serialized switch+fetch so concurrent client loads don't trip Bison's
  // one-workspace-per-session guard ("Multiple workspaces detected").
  return withTeam(teamId, async () => {
    const interested: BisonLead[] = []
    let scanned = 0
    for (let p = 1; p <= MAX_LEAD_PAGES; p++) {
      const data = await bison<{ data?: BisonLead[] }>('GET', '/api/leads', { page: p, per_page: 100 })
      const batch = Array.isArray(data) ? (data as unknown as BisonLead[]) : data.data ?? []
      if (!batch.length) break
      scanned += batch.length
      // A real "lead" carries the Interested / Meeting Booked TAG (Bison has no
      // `interested` boolean on the lead — the signal is its tags). Match by name.
      for (const l of batch) if (isInterestedLead(l)) interested.push(l)
      if (batch.length < 100) break
    }
    console.log(`[bison.getLeads] team=${teamId ?? 'default'} scanned ${scanned} → ${interested.length} interested lead(s)`)
    return interested
  })
}

export interface BisonCampaign {
  id: number
  name: string
  status?: string | null
}

// List a team's campaigns (serialized switch+fetch, like getLeads). Used to let
// an admin associate an unmapped/forwarded reply with the right campaign.
export async function getCampaigns(teamId?: string | number | null): Promise<BisonCampaign[]> {
  return withTeam(teamId, async () => {
    const out: BisonCampaign[] = []
    for (let p = 1; p <= 20; p++) {
      const data = await bison<{ data?: BisonCampaign[] }>('GET', '/api/campaigns', { page: p, per_page: 100 })
      const batch = Array.isArray(data) ? (data as unknown as BisonCampaign[]) : data.data ?? []
      if (!batch.length) break
      for (const c of batch) out.push({ id: c.id, name: c.name, status: c.status ?? null })
      if (batch.length < 100) break
    }
    return out
  })
}

// Fetch a campaign's replies — these are TRACKED replies by definition (a reply
// matched to an email the campaign sent). status filters Bison's own
// automated/interested axis; folder filters inbox/spam/all. Used by the unibox
// reconciler to re-pull replies the real-time webhook may have missed.
//
// Bison IGNORES per_page (returns ~15/page), so we page until a repeated-page
// signature (same set of ids as the previous page) rather than trusting page
// size. The caller wraps this in withTeam() so it runs on the team's scoped token.
const MAX_REPLY_PAGES = 200 // safety cap (~3k replies/campaign)
export async function getCampaignReplies(
  campaignId: number | string,
  opts: { status?: 'interested' | 'not_automated_reply' | 'automated_reply'; folder?: 'inbox' | 'spam' | 'all' } = {},
): Promise<BisonReply[]> {
  const out: BisonReply[] = []
  let lastSig = ''
  for (let p = 1; p <= MAX_REPLY_PAGES; p++) {
    const data = await bison<{ data?: BisonReply[] }>('GET', `/api/campaigns/${campaignId}/replies`, {
      page: p, status: opts.status, folder: opts.folder ?? 'inbox',
    })
    const batch = Array.isArray(data) ? (data as unknown as BisonReply[]) : data.data ?? []
    if (!batch.length) break
    const sig = batch.map((r) => r.id).join(',')
    if (sig === lastSig) break // same page repeated → end of data (per_page ignored)
    lastSig = sig
    out.push(...batch)
  }
  return out
}

// Fetch a single lead by ID or email.
export async function getLead(idOrEmail: string | number): Promise<BisonLead | null> {
  try {
    const data = await bison<{ data?: BisonLead }>('GET', `/api/leads/${idOrEmail}`)
    return data.data ?? null
  } catch {
    return null
  }
}

// Fetch all replies for a specific lead (their email thread).
// Returns inbox + sent messages so callers can distinguish direction via `folder`.
export async function getLeadReplies(leadId: number | string): Promise<BisonReply[]> {
  const data = await bison<{ data?: BisonReply[] }>('GET', `/api/leads/${leadId}/replies`, {
    folder: 'all',
  })
  return Array.isArray(data) ? (data as unknown as BisonReply[]) : data.data ?? []
}

// Fetch a lead's email thread by EMAIL within a specific client workspace.
// This is the correct entry point for the portal: the stored esp_leads.id may be
// a PlusVibe id (for backfilled history), which Bison doesn't recognise. So we
// (1) switch into the client's team, (2) resolve the real Bison lead by email,
// (3) pull that Bison lead's replies. Returns [] if the lead has no Bison record
// (e.g. pure PV-history lead never sent through Bison) — no thread to show.
export async function getLeadRepliesByEmail(
  email: string,
  teamId?: string | number | null,
): Promise<BisonReply[]> {
  if (!email) return []
  // Serialized so a thread-open doesn't race a list-load's workspace switch.
  return withTeam(teamId, async () => {
    const lead = await getLead(email)
    if (!lead?.id) return []
    return getLeadReplies(lead.id)
  })
}

// ── Replies / sending ────────────────────────────────────────────────────────

// Reply to an existing message thread.
export async function sendReply(input: {
  replyId: number
  bodyText: string
  bodyHtml?: string
  senderEmailId?: number
  ccEmails?: string[]
  replyAll?: boolean
}): Promise<{ ok: boolean; reason?: string }> {
  try {
    await bison('POST', `/api/replies/${input.replyId}/reply`, undefined, {
      message: input.bodyHtml ?? input.bodyText,
      content_type: input.bodyHtml ? 'html' : 'text',
      reply_all: input.replyAll ?? true,
      ...(input.senderEmailId ? { sender_email_id: input.senderEmailId } : {}),
      ...(input.ccEmails?.length
        ? { cc_emails: input.ccEmails.map(e => ({ email_address: e, name: null })) }
        : {}),
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

// ── Lead status ───────────────────────────────────────────────────────────────

// Mark a lead as inactive (equivalent to PlusVibe NON_LEAD).
// Bison status enum: verified | unverified | unknown | risky | inactive
export async function updateLeadStatus(
  leadIdOrEmail: string | number,
  status: 'inactive' | 'verified' | 'unverified' | 'unknown' | 'risky',
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await bison('PATCH', `/api/leads/${leadIdOrEmail}/update-status`, undefined, { status })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

// ── Tags ──────────────────────────────────────────────────────────────────────

interface BisonTag { id: number; name: string }

// Tag a lead as "lead" within a client's Bison team. Best-effort: switches into
// the team, ensures a "lead" tag exists (creating it if absent), then attaches
// it to the lead. Never throws — returns {ok:false, reason} so the caller (the
// mark-as-lead flow) can record bison_tag_state without rolling back billing.
export async function tagInBison(
  teamId: string | number,
  leadId: string | number | null,
  leadEmail?: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  if (teamId == null || teamId === '') {
    return { ok: false, reason: 'missing-team' }
  }
  try {
    return await withTeam(teamId, async () => {
      // Resolve the numeric Bison lead ID. If we don't have one (untracked reply),
      // look it up by email — Bison stores every lead it's contacted by email.
      let resolvedId: number | null = leadId != null && leadId !== '' ? Number(leadId) : null
      if (!resolvedId && leadEmail) {
        const found = await getLead(leadEmail)
        resolvedId = found?.id ?? null
      }
      if (!resolvedId) return { ok: false, reason: 'lead-not-found-in-bison' }

      // 1) Find or create the "Interested" tag (Bison's own signal for interested leads).
      const list = await bison<{ data?: BisonTag[] }>('GET', '/api/tags')
      const existing = (Array.isArray(list) ? (list as unknown as BisonTag[]) : list.data ?? [])
        .find(t => (t.name ?? '').toLowerCase() === 'interested')
      let tagId = existing?.id
      if (!tagId) {
        const created = await bison<{ data?: BisonTag }>('POST', '/api/tags', undefined, { name: 'Interested' })
        tagId = (created as { data?: BisonTag; id?: number }).data?.id
          ?? (created as { id?: number }).id
      }
      if (!tagId) return { ok: false, reason: 'tag-create-failed' }

      // 2) Attach the tag to the lead via the bulk attach endpoint.
      await bison('POST', '/api/tags/attach-to-leads', undefined, { tag_ids: [tagId], lead_ids: [resolvedId] })
      return { ok: true }
    })
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

// ── Blocklist ─────────────────────────────────────────────────────────────────

// Add an email to a client's Bison blocklist so a confirmed lead stops getting
// cold outreach. Best-effort: switches into the team and POSTs the email to the
// blacklisted-emails endpoint. Never throws — returns {ok:false, reason} so the
// caller (mark-as-lead) records the outcome without rolling back the lead.
// (#10 auto-unsubscribe will reuse this helper.)
export async function addToBlocklist(
  teamId: string | number,
  email: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (teamId == null || teamId === '' || !email) {
    return { ok: false, reason: 'missing-team-or-email' }
  }
  try {
    return await withTeam(teamId, async () => {
      await bison('POST', '/api/blacklisted-emails', undefined, { email })
      return { ok: true }
    })
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

// Unsubscribe a lead in Bison by email (stops the campaign sequence for them).
// Best-effort: resolves the Bison lead by email then calls unsubscribe. Pairs
// with addToBlocklist for #10 auto-unsubscribe. Never throws.
export async function unsubscribeLead(
  teamId: string | number,
  email: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (teamId == null || teamId === '' || !email) {
    return { ok: false, reason: 'missing-team-or-email' }
  }
  try {
    return await withTeam(teamId, async () => {
      const lead = await getLead(email)
      if (!lead?.id) return { ok: false, reason: 'lead-not-found' }
      // Bison: POST /api/leads/{id}/unsubscribe (unsubscribeLead).
      await bison('POST', `/api/leads/${lead.id}/unsubscribe`, undefined, {})
      return { ok: true }
    })
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

// MUST point at THIS portal's webhook route: /api/webhooks/plusvibe (handles
// Bison payloads via handleBison). The old default was a stale admin-legacy URL
// + wrong path, so Bison replies never reached the unibox. Override with
// BISON_WEBHOOK_TARGET_URL if the portal lives on a different host.
const WEBHOOK_TARGET =
  process.env.BISON_WEBHOOK_TARGET_URL ||
  process.env.PLUSVIBE_WEBHOOK_TARGET_URL ||
  'https://login.ottaly.co.uk/api/webhooks/plusvibe'

const WEBHOOK_EVENTS = ['lead_interested', 'lead_replied', 'untracked_reply_received']

interface BisonHook { id: number; name: string; url: string; events: string[] }

// Register the webhook in the CURRENT workspace context (the active token's
// workspace). Idempotent — skips if the exact URL is already registered.
async function registerWebhookHere(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const list = await bison<{ data?: BisonHook[] }>('GET', '/api/webhook-url').catch(() => ({ data: [] as BisonHook[] }))
    const exact = (list.data ?? []).some(h => h.url === WEBHOOK_TARGET)
    if (exact) return { ok: true, reason: 'already-exists' }
    await bison('POST', '/api/webhook-url', undefined, {
      name: 'Ottaly Portal', url: WEBHOOK_TARGET, events: WEBHOOK_EVENTS,
    })
    return { ok: true, reason: 'created' }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

export async function registerWebhook(): Promise<{ ok: boolean; reason?: string }> {
  if (!await getBisonKey()) return { ok: false, reason: 'no-api-key' }
  return registerWebhookHere()
}

// Register the webhook in EVERY mapped workspace. Bison webhooks are
// PER-WORKSPACE, so a single boot-time register only covers one team and every
// other client's replies never fire. This loops all teams (each via withTeam so
// the per-workspace token / switch is used) and registers in each.
export async function registerWebhookAllWorkspaces(): Promise<{ ok: boolean; results: Record<string, string> }> {
  if (!await getBisonKey()) return { ok: false, results: {} }
  const teamIds = Array.from(new Set(Object.values(PV_TO_BISON_TEAM)))
  const results: Record<string, string> = {}
  for (const teamId of teamIds) {
    try {
      const r = await withTeam(teamId, () => registerWebhookHere())
      results[teamId] = r.reason ?? (r.ok ? 'ok' : 'failed')
    } catch (err) {
      results[teamId] = `error: ${String(err).slice(0, 80)}`
    }
  }
  return { ok: true, results }
}

// Best-effort sync flag (env presence). The real key may also come from the
// Settings override — use getBisonKey() when correctness matters.
export const BISON_CONFIGURED = ENV_KEY.length > 0

// Mint a per-workspace (user) Bison token for one team, using the SUPER-ADMIN
// key. POST /api/workspaces/v1.1/{team_id}/api-tokens → plain_text_token.
// Returns the token, or null on failure. Goes through the lock with NO ws-token
// active so it uses the super-admin key.
export async function mintBisonWsToken(teamId: string | number, name: string): Promise<string | null> {
  try {
    return await withBisonLock(async () => {
      _activeToken = null // ensure super-admin key is used for minting
      const data = await bison<{ data?: { plain_text_token?: string } }>(
        'POST', `/api/workspaces/v1.1/${teamId}/api-tokens`, undefined, { name }
      )
      return data?.data?.plain_text_token ?? null
    })
  } catch (err) {
    console.error(`[bison] mint token for team ${teamId} failed:`, String(err))
    return null
  }
}

// Persist the per-workspace token map and bust the cache so it takes effect now.
export async function saveBisonWsTokens(tokens: Record<string, string>): Promise<void> {
  await pool.query(
    `INSERT INTO portal_settings (key, value, updated_at) VALUES ('bison_ws_tokens', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(tokens)]
  )
  _wsTokenCache = null
}
