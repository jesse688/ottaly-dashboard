/**
 * ESP Adapter Interface
 *
 * Every ESP adapter must implement these methods.
 * Swap PlusVibe for Email Bison by writing a new file in /adapters/
 * that exports the same shape — zero changes needed elsewhere.
 */

/**
 * @typedef {Object} Workspace
 * @property {string} id
 * @property {string} name
 * @property {Object} raw  - full API response
 */

/**
 * @typedef {Object} Campaign
 * @property {string} id
 * @property {string} workspace_id
 * @property {string} name
 * @property {string} status
 * @property {string} campaign_type
 * @property {number} lead_count
 * @property {number} sent_count
 * @property {number} replied_count
 * @property {number} bounced_count
 * @property {number} positive_reply_count
 * @property {number} reply_rate
 * @property {number} daily_limit
 * @property {string|null} last_lead_sent
 * @property {string|null} last_lead_replied
 * @property {string} created_at
 * @property {string} updated_at
 * @property {Object} raw
 */

/**
 * @typedef {Object} EmailAccount
 * @property {string} id
 * @property {string} workspace_id
 * @property {string} email
 * @property {string} status
 * @property {boolean} warmup_enabled
 * @property {number|null} warmup_score
 * @property {number|null} daily_limit
 * @property {number|null} sent_today
 * @property {string|null} supplier
 * @property {string[]} tags
 * @property {Object} raw
 */

/**
 * @typedef {Object} Lead
 * @property {string} id
 * @property {string} workspace_id
 * @property {string|null} campaign_id
 * @property {string} email
 * @property {string|null} first_name
 * @property {string|null} last_name
 * @property {string|null} company_name
 * @property {string|null} status
 * @property {string|null} label
 * @property {string} created_at
 * @property {string} updated_at
 * @property {Object} raw
 */

/**
 * @typedef {Object} AnalyticsDay
 * @property {string} workspace_id
 * @property {string} date        - YYYY-MM-DD
 * @property {number} sent
 * @property {number} opens
 * @property {number} replies
 * @property {number} bounces
 * @property {number} new_leads
 * @property {Object} raw
 */

/**
 * Base class — extend this for each ESP.
 * Methods throw by default so missing implementations are caught early.
 */
class EspAdapter {
  get source() { throw new Error('source not implemented') }

  /** @returns {Promise<Workspace[]>} */
  async getWorkspaces() { throw new Error('getWorkspaces not implemented') }

  /** @param {string} workspaceId @returns {Promise<Campaign[]>} */
  async getCampaigns(workspaceId) { throw new Error('getCampaigns not implemented') }

  /** @param {string} workspaceId @returns {Promise<EmailAccount[]>} */
  async getEmailAccounts(workspaceId) { throw new Error('getEmailAccounts not implemented') }

  /** @param {string} workspaceId @param {string} status @returns {Promise<Lead[]>} */
  async getLeads(workspaceId, status = 'interested') { throw new Error('getLeads not implemented') }

  /**
   * @param {string} workspaceId
   * @param {string} startDate  YYYY-MM-DD
   * @param {string} endDate    YYYY-MM-DD
   * @returns {Promise<AnalyticsDay[]>}
   */
  async getAnalytics(workspaceId, startDate, endDate) { throw new Error('getAnalytics not implemented') }
}

module.exports = { EspAdapter }
