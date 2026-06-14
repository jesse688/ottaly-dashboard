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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
})

// Registry — add Email Bison here when ready
const ADAPTERS = {
  plusvibe: new PlusVibeAdapter(),
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
    // NOTE: esp_leads writes are DISABLED for the PlusVibe sync. The client
    // portal's lead set is owned by the revenue_leads backfill (the admin's
    // authoritative lead source) + Bison going forward. Letting esp-sync also
    // write esp_leads (with label='INTERESTED' on replied-but-not-lead rows)
    // caused the portal lead counts to drift above the admin count. Campaigns
    // and email-account sync still run.
    const l = (source === 'plusvibe') ? 0 : await upsertLeads(client, source, leads)
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

async function run() {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => a.slice(2).split('='))
  )

  const sourceName = args.source ?? process.env.ESP_SYNC_SOURCE ?? 'plusvibe'

  // PlusVibe is retired: the API key is deprecated and the esp_* tables are now
  // fed by Bison webhooks (esp_leads) + the revenue_leads backfill. Running the
  // PlusVibe sync just fails on getWorkspaces (invalid key) every hour. Skip it
  // unless explicitly forced (ESP_SYNC_FORCE=1 / --force), and exit cleanly so
  // the hourly scheduler doesn't log a fatal crash. A future Bison adapter can
  // be added to ADAPTERS and selected via ESP_SYNC_SOURCE=bison.
  const forced = args.force != null || process.env.ESP_SYNC_FORCE === '1'
  if (sourceName === 'plusvibe' && !forced) {
    log('PlusVibe sync is retired (key deprecated; esp_* now fed by Bison webhooks). Skipping. Set ESP_SYNC_FORCE=1 to override.')
    await pool.end()
    return
  }

  const adapter = ADAPTERS[sourceName]
  if (!adapter) { console.error(`Unknown source: ${sourceName}`); process.exit(1) }

  log(`Starting sync (source=${sourceName})`)

  const client = await pool.connect()
  let workspaces
  try {
    workspaces = await adapter.getWorkspaces()
    for (const ws of workspaces) await upsertWorkspace(client, sourceName, ws)
  } finally {
    client.release()
  }

  // Filter to specific workspace if requested
  const targetId = args.workspace
  const toSync = targetId ? workspaces.filter(w => w.id === targetId) : workspaces

  log(`Syncing ${toSync.length} workspaces...`)

  let total = { campaigns: 0, accounts: 0, leads: 0 }
  for (const ws of toSync) {
    const result = await syncWorkspace(adapter, ws.id, ws.name)
    if (result) {
      total.campaigns += result.campaigns
      total.accounts += result.accounts
      total.leads += result.leads
    }
  }

  log(`Done. Total: ${total.campaigns} campaigns, ${total.accounts} accounts, ${total.leads} leads`)
  await pool.end()
}

run().catch(err => {
  console.error('[esp-sync] Fatal:', err)
  process.exit(1)
})
