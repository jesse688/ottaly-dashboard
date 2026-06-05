'use strict'

const { EspAdapter } = require('../adapter-interface')

const BASE_URL = 'https://api.plusvibe.ai/api/v1'
const API_KEY  = process.env.PLUSVIBE_KEY

async function pvFetch(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`)
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v)
  })
  const res = await fetch(url.toString(), {
    headers: { 'x-api-key': API_KEY },
  })
  if (!res.ok) throw new Error(`PlusVibe ${path} → ${res.status}: ${await res.text()}`)
  return res.json()
}

class PlusVibeAdapter extends EspAdapter {
  get source() { return 'plusvibe' }

  async getWorkspaces() {
    const data = await pvFetch('/workspaces')
    const list = Array.isArray(data) ? data : data.workspaces ?? []
    return list.map(w => ({
      id: w.id ?? w._id,
      name: w.name,
      raw: w,
    }))
  }

  async getCampaigns(workspaceId) {
    const results = []
    let skip = 0
    const limit = 100
    while (true) {
      const page = await pvFetch('/campaign/list', { workspace_id: workspaceId, limit, skip })
      const items = Array.isArray(page) ? page : page.list ?? page.data ?? []
      for (const c of items) {
        results.push({
          id:                   c.id,
          workspace_id:         c.workspace_id ?? workspaceId,
          name:                 c.camp_name ?? c.name,
          status:               c.status,
          campaign_type:        c.campaign_type ?? 'parent',
          lead_count:           c.lead_count ?? 0,
          sent_count:           c.sent_count ?? 0,
          replied_count:        c.replied_count ?? 0,
          bounced_count:        c.bounced_count ?? 0,
          positive_reply_count: c.positive_reply_count ?? 0,
          reply_rate:           c.replied_rate ?? 0,
          daily_limit:          c.daily_limit ?? null,
          last_lead_sent:       c.last_lead_sent || null,
          last_lead_replied:    c.last_lead_replied || null,
          created_at:           c.created_at,
          updated_at:           c.modified_at ?? c.updated_at,
          raw:                  c,
        })
      }
      if (items.length < limit) break
      skip += limit
    }
    return results
  }

  async getEmailAccounts(workspaceId) {
    // PlusVibe v1 API doesn't expose email accounts directly — we use the
    // server.plusvibe.ai endpoint which the MCP uses internally.
    const results = []
    let skip = 0
    const limit = 100
    while (true) {
      const page = await fetch(
        `https://server.plusvibe.ai/api/v2/emailaccounts/list?workspace_id=${workspaceId}&limit=${limit}&skip=${skip}`,
        { headers: { 'x-api-key': process.env.PLUSVIBE_KEY } }
      ).then(r => r.ok ? r.json() : null).catch(() => null)

      const items = Array.isArray(page) ? page : page?.accounts ?? page?.data ?? []
      if (!items.length) break

      for (const a of items) {
        results.push({
          id:             a.id ?? a._id,
          workspace_id:   workspaceId,
          email:          a.email,
          status:         a.status ?? 'UNKNOWN',
          warmup_enabled: a.warmup_status === 'ACTIVE',
          warmup_score:   a.payload?.analytics?.health_scores?.['7d_overall_warmup_health'] ?? null,
          daily_limit:    a.payload?.daily_limit ?? null,
          sent_today:     a.payload?.analytics?.daily_counters?.email_sent_today ?? null,
          supplier:       a.payload?.smtp_host ?? a.provider ?? null,
          tags:           a.payload?.tags ?? [],
          raw:            a,
        })
      }
      if (items.length < limit) break
      skip += limit
    }
    return results
  }

  async getLeads(workspaceId, status = 'interested') {
    const results = []
    let page = 1
    const limit = 100
    while (true) {
      const data = await pvFetch('/lead/workspace-leads', { workspace_id: workspaceId, label: status === 'interested' ? 'INTERESTED' : status, page, limit })
      const items = Array.isArray(data) ? data : data.data ?? data.leads ?? []
      for (const l of items) {
        results.push({
          id:           l.id ?? l._id,
          workspace_id: workspaceId,
          campaign_id:  l.campaign_id ?? null,
          email:        l.email,
          first_name:   l.first_name ?? null,
          last_name:    l.last_name ?? null,
          company_name: l.company_name ?? null,
          status:       l.status ?? status,
          label:        l.label ?? null,
          created_at:   l.created_at ?? null,
          updated_at:   l.updated_at ?? null,
          raw:          l,
        })
      }
      if (items.length < limit) break
      page++
    }
    return results
  }

  async getAnalytics(workspaceId, startDate, endDate) {
    const data = await pvFetch('/analytics/get-campaign-analytics-overview', {
      workspace_id: workspaceId,
      start_date:   startDate,
      end_date:     endDate,
    })
    // PlusVibe returns aggregated stats, not daily breakdown
    // Store as a single row for the period
    const stats = Array.isArray(data) ? data[0] : data
    if (!stats) return []
    return [{
      workspace_id: workspaceId,
      date:         startDate,
      sent:         stats.emails_sent_count ?? stats.sent ?? 0,
      opens:        stats.open_count ?? stats.opens ?? 0,
      replies:      stats.reply_count ?? stats.replies ?? 0,
      bounces:      stats.bounced_count ?? stats.bounces ?? 0,
      new_leads:    stats.new_leads_count ?? stats.leads ?? 0,
      raw:          stats,
    }]
  }
}

module.exports = { PlusVibeAdapter }
