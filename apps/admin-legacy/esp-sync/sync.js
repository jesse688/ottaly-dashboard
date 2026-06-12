'use strict'

/**
 * ESP Sync Runner
 *
 * Pulls all data from the configured ESP adapter and upserts into Postgres.
 * Safe to run repeatedly — uses ON CONFLICT DO UPDATE (upsert).
 *
 * first_replied_at is NEVER overwritten once set — protects against PlusVibe
 * changing the timestamp when a lead is re-labelled.
 *
 * Usage:
 *   node esp-sync/sync.js [--workspace=<id>] [--source=plusvibe]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') })

const { Pool } = require('pg')
const { PlusVibeAdapter } = require('./adapters/plusvibe')
const { BisonAdapter } = require('./adapters/bison')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
})

// Registry of ESP adapters by source name.
const ADAPTERS = {
  plusvibe: new PlusVibeAdapter(),
  bison:    new BisonAdapter(),
}

function log(msg) {
  console.log(`[esp-sync] ${new Date().toISOString()} ${msg}`)
}

async function upsertWorkspace(client, source, ws) {
  await client.query(
    `INSERT INTO esp_workspaces (id, source, name, raw, synced_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (id, source) DO UPDATE SET
       name = EXCLUDED.name,
       raw = EXCLUDED.raw,
       synced_at = now()`,
    [ws.id, source, ws.name, JSON.stringify(ws.raw)]
  )
}

async function upsertCampaigns(client, source, campaigns) {
  for (const c of campaigns) {
    await client.query(
      `INSERT INTO esp_campaigns
         (id, source, workspace_id, name, status, campaign_type,
          lead_count, sent_count, replied_count, bounced_count,
          positive_reply_count, reply_rate, daily_limit,
          last_lead_sent, last_lead_replied, created_at, updated_at, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now())
       ON CONFLICT (id, source) DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         lead_count = EXCLUDED.lead_count,
         sent_count = EXCLUDED.sent_count,
         replied_count = EXCLUDED.replied_count,
         bounced_count = EXCLUDED.bounced_count,
         positive_reply_count = EXCLUDED.positive_reply_count,
         reply_rate = EXCLUDED.reply_rate,
         last_lead_sent = EXCLUDED.last_lead_sent,
         last_lead_replied = EXCLUDED.last_lead_replied,
         updated_at = EXCLUDED.updated_at,
         raw = EXCLUDED.raw,
         synced_at = now()`,
      [
        c.id, source, c.workspace_id, c.name, c.status, c.campaign_type,
        c.lead_count, c.sent_count, c.replied_count, c.bounced_count,
        c.positive_reply_count, c.reply_rate, c.daily_limit,
        c.last_lead_sent, c.last_lead_replied, c.created_at, c.updated_at,
        JSON.stringify(c.raw),
      ]
    )
  }
  return campaigns.length
}

async function upsertEmailAccounts(client, source, accounts) {
  for (const a of accounts) {
    await client.query(
      `INSERT INTO esp_email_accounts
         (id, source, workspace_id, email, status, warmup_enabled,
          warmup_score, daily_limit, sent_today, supplier, tags, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (id, source) DO UPDATE SET
         status = EXCLUDED.status,
         warmup_enabled = EXCLUDED.warmup_enabled,
         warmup_score = EXCLUDED.warmup_score,
         daily_limit = EXCLUDED.daily_limit,
         sent_today = EXCLUDED.sent_today,
         supplier = EXCLUDED.supplier,
         tags = EXCLUDED.tags,
         raw = EXCLUDED.raw,
         synced_at = now()`,
      [
        a.id, source, a.workspace_id, a.email, a.status, a.warmup_enabled,
        a.warmup_score, a.daily_limit, a.sent_today, a.supplier,
        JSON.stringify(a.tags), JSON.stringify(a.raw),
      ]
    )
  }
  return accounts.length
}

async function upsertLeads(client, source, leads) {
  for (const l of leads) {
    // Determine first_replied_at from the lead data
    const repliedAt = l.raw?.lt?.replied_at ?? l.raw?.replied_at ?? null

    await client.query(
      `INSERT INTO esp_leads
         (id, source, workspace_id, campaign_id, email, first_name, last_name,
          company_name, status, label, first_replied_at, first_reply_campaign_id,
          created_at, updated_at, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
       ON CONFLICT (id, source) DO UPDATE SET
         status = EXCLUDED.status,
         label = EXCLUDED.label,
         updated_at = EXCLUDED.updated_at,
         raw = EXCLUDED.raw,
         synced_at = now(),
         -- NEVER overwrite first_replied_at once set
         first_replied_at = COALESCE(esp_leads.first_replied_at, EXCLUDED.first_replied_at),
         first_reply_campaign_id = COALESCE(esp_leads.first_reply_campaign_id, EXCLUDED.first_reply_campaign_id)`,
      [
        l.id, source, l.workspace_id, l.campaign_id, l.email,
        l.first_name, l.last_name, l.company_name, l.status, l.label,
        repliedAt, l.campaign_id,
        l.created_at, l.updated_at, JSON.stringify(l.raw),
      ]
    )
  }
  return leads.length
}

async function logSync(client, source, workspaceId, status, counts = {}, error = null) {
  await client.query(
    `INSERT INTO esp_sync_log
       (source, workspace_id, status, campaigns_synced, accounts_synced, leads_synced, error, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [source, workspaceId, status, counts.campaigns ?? 0, counts.accounts ?? 0, counts.leads ?? 0, error]
  )
}

async function syncWorkspace(adapter, workspaceId, workspaceName) {
  const source = adapter.source
  const client = await pool.connect()
  log(`  syncing ${workspaceName} (${workspaceId})`)

  try {
    const [campaigns, accounts, leads] = await Promise.all([
      adapter.getCampaigns(workspaceId).catch(e => { log(`    campaigns error: ${e.message}`); return [] }),
      adapter.getEmailAccounts(workspaceId).catch(e => { log(`    accounts error: ${e.message}`); return [] }),
      adapter.getLeads(workspaceId, 'interested').catch(e => { log(`    leads error: ${e.message}`); return [] }),
    ])

    await client.query('BEGIN')
    const c = await upsertCampaigns(client, source, campaigns)
    const a = await upsertEmailAccounts(client, source, accounts)
    const l = await upsertLeads(client, source, leads)
    await logSync(client, source, workspaceId, 'success', { campaigns: c, accounts: a, leads: l })
    await client.query('COMMIT')

    log(`    ✓ ${c} campaigns, ${a} accounts, ${l} leads`)
    return { campaigns: c, accounts: a, leads: l }
  } catch (err) {
    await client.query('ROLLBACK')
    await logSync(client, source, workspaceId, 'error', {}, err.message)
    log(`    ✗ ${err.message}`)
    return null
  } finally {
    client.release()
  }
}

/**
 * Build the per-workspace ESP routing map from the esp_routing table (Postgres).
 *
 * Keyed by PlusVibe workspace_id (the app's canonical client id, kept even after
 * a client moves to Bison). For Bison-routed clients bison_team_id gives the id
 * used by switch-workspace. Returns:
 *   { byPvId: Map<pvWorkspaceId, 'plusvibe'|'bison'>,
 *     bisonTeamId: Map<pvWorkspaceId, bisonTeamId> }
 * Any workspace with no row defaults to 'plusvibe' (current behaviour preserved).
 */
async function loadEspRouting(client) {
  const byPvId = new Map()
  const bisonTeamId = new Map()
  try {
    const { rows } = await client.query(
      `SELECT pv_workspace_id, esp_provider, bison_team_id FROM esp_routing`
    )
    for (const r of rows) {
      byPvId.set(String(r.pv_workspace_id), (r.esp_provider || 'plusvibe').toLowerCase())
      if (r.bison_team_id != null) bisonTeamId.set(String(r.pv_workspace_id), String(r.bison_team_id))
    }
  } catch (err) {
    // If the table doesn't exist yet (migration not run), fall back to all-PlusVibe.
    log(`esp_routing lookup failed (${err.message}) — defaulting all workspaces to plusvibe`)
  }
  return { byPvId, bisonTeamId }
}

/**
 * Mailbox dedup — Bison wins. For any email account email address present under
 * BOTH source='bison' and source='plusvibe', mark the PlusVibe copy as
 * superseded so stats/health count it once (the Bison row is authoritative).
 * This NEVER deletes the row or touches historical email_events — it only flags
 * the live roster duplicate. Idempotent.
 */
async function dedupeMailboxes(client) {
  const sql = `
    UPDATE esp_email_accounts pv
    SET superseded_by_bison = TRUE
    WHERE pv.source = 'plusvibe'
      AND pv.superseded_by_bison IS DISTINCT FROM TRUE
      AND EXISTS (
        SELECT 1 FROM esp_email_accounts b
        WHERE b.source = 'bison'
          AND lower(b.email) = lower(pv.email)
      )`
  try {
    const r = await client.query(sql)
    if (r.rowCount) log(`mailbox dedup: ${r.rowCount} PlusVibe account(s) superseded by Bison`)
  } catch (err) {
    log(`mailbox dedup skipped (${err.message}) — superseded_by_bison column may be missing`)
  }
}

async function run() {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => a.slice(2).split('='))
  )

  // --source forces a single ESP for ALL workspaces (manual/debug). Without it,
  // each workspace is routed by its esp_routing (dual mode).
  const forcedSource = args.source || null
  if (forcedSource && !ADAPTERS[forcedSource]) {
    console.error(`Unknown source: ${forcedSource}`); process.exit(1)
  }

  log(forcedSource
    ? `Starting sync (forced source=${forcedSource})`
    : `Starting sync (per-workspace routing via esp_routing)`)

  // 1. Load routing + discover workspaces from PlusVibe (still the canonical
  //    client roster — every client has a PV workspace_id even after migrating).
  const setupClient = await pool.connect()
  let routing, pvWorkspaces
  try {
    routing = await loadEspRouting(setupClient)
    pvWorkspaces = await ADAPTERS.plusvibe.getWorkspaces()
    for (const ws of pvWorkspaces) await upsertWorkspace(setupClient, 'plusvibe', ws)
  } finally {
    setupClient.release()
  }

  const targetId = args.workspace
  const toSync = targetId ? pvWorkspaces.filter(w => w.id === targetId) : pvWorkspaces
  log(`Syncing ${toSync.length} workspaces...`)

  const total = { campaigns: 0, accounts: 0, leads: 0 }
  for (const ws of toSync) {
    const provider = forcedSource || routing.byPvId.get(String(ws.id)) || 'plusvibe'
    const adapter = ADAPTERS[provider]

    // Bison is keyed by team_id, not the PV workspace_id. Resolve it; skip if a
    // client is marked bison but has no team_id mapping (avoids syncing the
    // wrong workspace). PlusVibe uses the workspace_id directly.
    let adapterWsId = ws.id
    if (provider === 'bison') {
      const teamId = routing.bisonTeamId.get(String(ws.id))
      if (!teamId) { log(`  skip ${ws.name} — esp_provider=bison but no bison_team_id`); continue }
      adapterWsId = teamId
    }

    const result = await syncWorkspace(adapter, adapterWsId, `${ws.name} [${provider}]`)
    if (result) {
      total.campaigns += result.campaigns
      total.accounts += result.accounts
      total.leads += result.leads
    }
  }

  // 2. Bison-wins mailbox dedup across the freshly-synced roster.
  const dedupClient = await pool.connect()
  try { await dedupeMailboxes(dedupClient) } finally { dedupClient.release() }

  log(`Done. Total: ${total.campaigns} campaigns, ${total.accounts} accounts, ${total.leads} leads`)
  await pool.end()
}

run().catch(err => {
  console.error('[esp-sync] Fatal:', err)
  process.exit(1)
})
