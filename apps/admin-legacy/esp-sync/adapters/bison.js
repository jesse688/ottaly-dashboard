'use strict'

const { EspAdapter } = require('../adapter-interface')

/**
 * EmailBison adapter.
 *
 * Auth model differs from PlusVibe: Bison uses a single super-admin Bearer
 * token and a STATEFUL workspace switch (POST /api/workspaces/switch-workspace
 * { team_id }) rather than a per-request workspace_id param. Because the active
 * workspace lives on the token, every per-workspace fetch MUST be serialized
 * behind a switch — never run two workspaces' calls concurrently on one token.
 *
 * `workspaceId` passed into these methods is the Bison team_id (integer, as a
 * string). getWorkspaces() returns Bison team_ids as the canonical id so the
 * rest of the sync engine keys esp_* rows by them under source='bison'.
 *
 * See memory/reference_bison_api.md + bison-openapi-spec.yaml for full API.
 */

const BASE = (process.env.BISON_API_URL || 'https://send.ottaly.co.uk').replace(/\/$/, '')
const KEY  = process.env.BISON_API_KEY || ''  // super-admin token

async function bison(method, path, { params, body } = {}) {
  const url = new URL(`${BASE}${path}`)
  if (params && method === 'GET') {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }
  const init = {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20000),
  }
  if (body && method !== 'GET') init.body = JSON.stringify(body)

  const res = await fetch(url.toString(), init)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Bison ${method} ${path} → ${res.status}: ${txt.slice(0, 200)}`)
  }
  return res.json()
}

// Bison responses are usually { data: [...] } but some return a bare array.
function unwrap(d) {
  if (Array.isArray(d)) return d
  return d?.data ?? []
}

class BisonAdapter extends EspAdapter {
  constructor() {
    super()
    this._activeTeam = null // remember last switch to skip redundant switches
  }

  get source() { return 'bison' }

  /**
   * Switch the token's active workspace. No-op if already active.
   * MUST be awaited before any per-workspace call.
   */
  async _switch(teamId) {
    const id = String(teamId)
    if (this._activeTeam === id) return
    await bison('POST', '/api/workspaces/switch-workspace', { body: { team_id: Number(teamId) } })
    this._activeTeam = id
  }

  async getWorkspaces() {
    const data = await bison('GET', '/api/workspaces')
    return unwrap(data).map(w => ({
      id:   String(w.id),          // Bison team_id (int) → string, canonical id
      name: w.name,
      raw:  w,
    }))
  }

  async getCampaigns(workspaceId) {
    await this._switch(workspaceId)
    const results = []
    let page = 1
    const perPage = 100
    while (true) {
      const data = await bison('GET', '/api/campaigns', { params: { page, per_page: perPage } })
      const items = unwrap(data)
      for (const c of items) {
        const stats = c.stats ?? c.statistics ?? {}
        results.push({
          id:                   String(c.id),
          workspace_id:         String(workspaceId),
          name:                 c.name,
          status:               c.status ?? (c.archived_at ? 'archived' : (c.paused_at ? 'paused' : 'active')),
          campaign_type:        'parent',
          lead_count:           c.leads_count ?? stats.leads ?? 0,
          sent_count:           stats.sent ?? c.sent_count ?? 0,
          replied_count:        stats.replied ?? c.replied_count ?? 0,
          bounced_count:        stats.bounced ?? c.bounced_count ?? 0,
          // Bison's "interested" is the positive-reply equivalent (no separate field)
          positive_reply_count: stats.interested ?? c.interested_count ?? 0,
          reply_rate:           stats.reply_rate ?? 0,
          daily_limit:          c.daily_limit ?? null,
          last_lead_sent:       c.last_sent_at ?? null,
          last_lead_replied:    c.last_replied_at ?? null,
          created_at:           c.created_at,
          updated_at:           c.updated_at ?? c.created_at,
          raw:                  c,
        })
      }
      if (items.length < perPage) break
      page++
    }
    return results
  }

  async getEmailAccounts(workspaceId) {
    await this._switch(workspaceId)
    const results = []
    let page = 1
    const perPage = 100
    while (true) {
      const data = await bison('GET', '/api/sender-emails', { params: { page, per_page: perPage } })
      const items = unwrap(data)
      for (const a of items) {
        results.push({
          id:             String(a.id),
          workspace_id:   String(workspaceId),
          email:          a.email ?? a.email_address,
          status:         a.status ?? (a.is_connected === false ? 'DISCONNECTED' : 'ACTIVE'),
          warmup_enabled: Boolean(a.warmup_enabled ?? a.warmup?.enabled),
          warmup_score:   a.warmup?.score ?? a.warmup_health ?? null,
          daily_limit:    a.daily_limit ?? null,
          sent_today:     a.sent_today ?? a.stats?.sent_today ?? null,
          supplier:       a.smtp_host ?? a.provider ?? a.type ?? null,
          tags:           Array.isArray(a.tags) ? a.tags.map(t => t.name ?? t) : [],
          raw:            a,
        })
      }
      if (items.length < perPage) break
      page++
    }
    return results
  }

  async getLeads(workspaceId, status = 'interested') {
    await this._switch(workspaceId)
    const results = []
    let page = 1
    const perPage = 100
    while (true) {
      const data = await bison('GET', '/api/leads', {
        params: {
          'filters[lead_campaign_status]': 'replied',
          status: status === 'interested' ? 'interested' : status,
          page,
          per_page: perPage,
        },
      })
      const items = unwrap(data)
      for (const l of items) {
        const camp = Array.isArray(l.lead_campaign_data) ? l.lead_campaign_data[0] : null
        results.push({
          id:           String(l.id),
          workspace_id: String(workspaceId),
          campaign_id:  camp?.campaign_id != null ? String(camp.campaign_id) : null,
          email:        l.email,
          first_name:   l.first_name ?? null,
          last_name:    l.last_name ?? null,
          company_name: l.company ?? null,
          status:       l.status ?? status,
          // Bison status 'interested' maps to the PlusVibe INTERESTED label
          label:        (l.status === 'interested' || status === 'interested') ? 'INTERESTED' : (l.status ?? null),
          created_at:   l.created_at ?? null,
          updated_at:   l.updated_at ?? null,
          raw:          l,
        })
      }
      if (items.length < perPage) break
      page++
    }
    return results
  }

  async getAnalytics(workspaceId, startDate, endDate) {
    await this._switch(workspaceId)
    // Workspace-level normalized stats by date (v1.1). Events returned:
    // Replied, Total Opens, Unique Opens, Sent, Bounced, Unsubscribed, Interested.
    const data = await bison('GET', '/api/workspaces/v1.1/line-area-chart-stats', {
      params: { start_date: startDate, end_date: endDate },
    })
    const rows = unwrap(data)
    if (!rows.length) {
      // Fall back to the summary endpoint as a single-row period if no daily data.
      const summary = await bison('GET', '/api/workspaces/v1.1/stats', {
        params: { start_date: startDate, end_date: endDate },
      }).catch(() => null)
      const s = summary?.data ?? summary
      if (!s) return []
      return [{
        workspace_id: String(workspaceId),
        date:         startDate,
        sent:         s.sent ?? 0,
        opens:        s.unique_opens ?? s.total_opens ?? s.opens ?? 0,
        replies:      s.replied ?? s.replies ?? 0,
        bounces:      s.bounced ?? s.bounces ?? 0,
        new_leads:    s.interested ?? s.new_leads ?? 0,
        raw:          s,
      }]
    }
    return rows.map(r => ({
      workspace_id: String(workspaceId),
      date:         (r.date ?? r.day ?? startDate).slice(0, 10),
      sent:         r.sent ?? 0,
      opens:        r.unique_opens ?? r.total_opens ?? r.opens ?? 0,
      replies:      r.replied ?? r.replies ?? 0,
      bounces:      r.bounced ?? r.bounces ?? 0,
      new_leads:    r.interested ?? r.new_leads ?? 0,
      raw:          r,
    }))
  }
}

module.exports = { BisonAdapter }
