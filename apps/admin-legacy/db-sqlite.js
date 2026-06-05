const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class SqliteDatabase {
  constructor() {
    this.db = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;

    const dbPath = process.env.DB_PATH || path.resolve(__dirname, 'contacts.db');
    const dbDir = path.dirname(dbPath);
    if (dbDir !== '.') { try { fs.mkdirSync(dbDir, { recursive: true }); } catch {} }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    try {
      await this.setupSchema();
      console.log('[SQLite] Connected to database at', dbPath);
      this.initialized = true;
    } catch (err) {
      console.error('[SQLite] Connection failed:', err.message);
      throw err;
    }
  }

  async setupSchema() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        email TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        phone TEXT,
        company_name TEXT,
        company_domain TEXT,
        job_title TEXT,
        job_title_cleaned TEXT,
        seniority TEXT,
        department TEXT,
        sub_departments TEXT,
        apollo_id TEXT,
        apollo_person_id TEXT,
        linkedin_url TEXT,
        industry TEXT,
        num_employees INTEGER,
        keywords TEXT,
        technologies TEXT,
        company_linkedin_url TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        company_address TEXT,
        company_city TEXT,
        company_state TEXT,
        company_country TEXT,
        corporate_phone TEXT,
        company_phone TEXT,
        email_verified_at TEXT,
        source TEXT DEFAULT 'api',
        raw_data TEXT,
        tags TEXT DEFAULT '[]',
        imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'new',
        UNIQUE(workspace_id, email)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_contacts_workspace ON contacts(workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)`,
      `CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_domain)`
    ];

    for (const stmt of statements) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        // Don't throw - tables/indexes might already exist
        if (!err.message.includes('already exists')) {
          console.error('[SQLite] Schema setup error:', err.message);
        }
      }
    }
  }

  async query(sql, params = []) {
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.all(...params);
      return { rows: result, rowCount: result.length };
    } catch (err) {
      console.error('[SQLite] Query error:', err.message);
      throw err;
    }
  }

  async exec(sql) {
    try {
      this.db.exec(sql);
    } catch (err) {
      console.error('[SQLite] Exec error:', err.message);
      throw err;
    }
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.initialized = false;
    }
  }

  // ── Contact Operations ──────────────────────────────────────

  async createContact(workspaceId, contactData) {
    const {
      email, firstName, lastName, phone, companyName, companyDomain,
      jobTitle, jobTitleCleaned, seniority, department, subDepartments,
      apolloId, apolloPersonId, linkedinUrl, industry, numEmployees,
      keywords, technologies, companyLinkedinUrl,
      city, state, country, companyAddress, companyCity, companyState, companyCountry,
      corporatePhone, companyPhone, emailVerifiedAt,
      source, rawData, tags
    } = contactData;

    const sql = `
      INSERT INTO contacts (
        workspace_id, email, first_name, last_name, phone,
        company_name, company_domain, job_title, job_title_cleaned,
        seniority, department, sub_departments, apollo_id, apollo_person_id,
        linkedin_url, industry, num_employees, keywords, technologies,
        company_linkedin_url, city, state, country,
        company_address, company_city, company_state, company_country,
        corporate_phone, company_phone, email_verified_at,
        source, raw_data, tags, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, email)
      DO UPDATE SET
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        phone = excluded.phone,
        company_name = excluded.company_name,
        company_domain = excluded.company_domain,
        job_title = excluded.job_title,
        job_title_cleaned = excluded.job_title_cleaned,
        seniority = excluded.seniority,
        department = excluded.department,
        sub_departments = excluded.sub_departments,
        apollo_id = excluded.apollo_id,
        linkedin_url = excluded.linkedin_url,
        industry = excluded.industry,
        num_employees = excluded.num_employees,
        keywords = excluded.keywords,
        technologies = excluded.technologies,
        company_linkedin_url = excluded.company_linkedin_url,
        city = excluded.city,
        state = excluded.state,
        country = excluded.country,
        company_address = excluded.company_address,
        company_city = excluded.company_city,
        company_state = excluded.company_state,
        company_country = excluded.company_country,
        corporate_phone = excluded.corporate_phone,
        company_phone = excluded.company_phone,
        email_verified_at = excluded.email_verified_at,
        raw_data = excluded.raw_data,
        updated_at = CURRENT_TIMESTAMP;
    `;

    const stmt = this.db.prepare(sql);
    stmt.run(
      workspaceId, email, firstName, lastName, phone,
      companyName, companyDomain, jobTitle, jobTitleCleaned,
      seniority, department || null, subDepartments || null, apolloId, apolloPersonId,
      linkedinUrl || null, industry || null, numEmployees || null,
      keywords || null, technologies || null, companyLinkedinUrl || null,
      city || null, state || null, country || null,
      companyAddress || null, companyCity || null, companyState || null, companyCountry || null,
      corporatePhone || null, companyPhone || null, emailVerifiedAt || null,
      source, rawData ? JSON.stringify(rawData) : null, JSON.stringify(tags || [])
    );

    return { id: stmt.lastID };
  }

  async getContact(workspaceId, email) {
    const sql = `
      SELECT * FROM contacts
      WHERE workspace_id = ? AND email = ?
      LIMIT 1;
    `;
    const stmt = this.db.prepare(sql);
    return stmt.get(workspaceId, email);
  }

  async getContactById(id) {
    const sql = `
      SELECT email, first_name, last_name, phone, company_name, company_domain, job_title
      FROM contacts WHERE id = ? LIMIT 1;
    `;
    const stmt = this.db.prepare(sql);
    return stmt.get(id);
  }

  async getContactsById(ids) {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const sql = `SELECT * FROM contacts WHERE id IN (${placeholders})`;
    const stmt = this.db.prepare(sql);
    return stmt.all(...ids);
  }

  _buildFilterClauses(filters) {
    const params = [];
    const clauses = [];

    const like = (col, val) => { clauses.push(`LOWER(${col}) LIKE LOWER(?)`); params.push(`%${val}%`); };
    const eq = (col, val) => { clauses.push(`${col} = ?`); params.push(val); };
    const jsonLike = (field, val) => {
      const values = val.split(',').map(v => v.trim()).filter(Boolean);
      if (values.length === 0) return;
      const orClauses = [];
      for (let i = 0; i < values.length; i++) {
        orClauses.push(`LOWER(raw_data) LIKE LOWER(?)`);
        params.push(`%"${field}"%${values[i]}%`);
      }
      clauses.push(`(${orClauses.join(' OR ')})`);
    };
    const jsonExclude = (field, val) => {
      const values = val.split(',').map(v => v.trim()).filter(Boolean);
      if (values.length === 0) return;
      for (let i = 0; i < values.length; i++) {
        clauses.push(`(raw_data IS NULL OR LOWER(raw_data) NOT LIKE LOWER(?))`);
        params.push(`%"${field}"%${values[i]}%`);
      }
    };

    if (filters.status) eq('status', filters.status);
    if (filters.seniority) eq('seniority', filters.seniority);
    if (filters.firstName) like('first_name', filters.firstName);
    if (filters.lastName) like('last_name', filters.lastName);
    if (filters.jobTitle) jsonLike('Title', filters.jobTitle);
    if (filters.jobTitleExclude) jsonExclude('Title', filters.jobTitleExclude);
    if (filters.department) jsonLike('Departments', filters.department);
    if (filters.subDepartments) jsonLike('Sub Departments', filters.subDepartments);
    if (filters.linkedinUrl) like('linkedin_url', filters.linkedinUrl);
    if (filters.industry) jsonLike('Industry', filters.industry);
    if (filters.industryExclude) jsonExclude('Industry', filters.industryExclude);
    if (filters.keywords) jsonLike('Keywords', filters.keywords);
    if (filters.keywordsExclude) jsonExclude('Keywords', filters.keywordsExclude);
    if (filters.technologies) jsonLike('Technologies', filters.technologies);
    if (filters.technologiesExclude) jsonExclude('Technologies', filters.technologiesExclude);
    if (filters.website) like('company_domain', filters.website);
    if (filters.companyLinkedin) like('company_linkedin_url', filters.companyLinkedin);
    if (filters.city) jsonLike('City', filters.city);
    if (filters.state) jsonLike('State', filters.state);
    if (filters.country) jsonLike('Country', filters.country);
    if (filters.companyCity) jsonLike('Company City', filters.companyCity);
    if (filters.companyState) jsonLike('Company State', filters.companyState);
    if (filters.companyCountry) jsonLike('Company Country', filters.companyCountry);
    if (filters.email) like('email', filters.email);
    if (filters.phone) {
      clauses.push(`(LOWER(corporate_phone) LIKE LOWER(?) OR LOWER(company_phone) LIKE LOWER(?))`);
      params.push(`%${filters.phone}%`, `%${filters.phone}%`);
    }
    if (filters.company) {
      clauses.push(`(LOWER(company_name) LIKE LOWER(?) OR LOWER(company_domain) LIKE LOWER(?))`);
      params.push(`%${filters.company}%`, `%${filters.company}%`);
    }
    if (filters.search) {
      clauses.push(`(LOWER(email) LIKE LOWER(?) OR LOWER(first_name) LIKE LOWER(?) OR LOWER(last_name) LIKE LOWER(?) OR LOWER(company_name) LIKE LOWER(?))`);
      params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
    }

    if (filters.emailProviders) {
      const providers = filters.emailProviders.split(',').map(prov => prov.trim());
      const orClauses = [];
      for (let i = 0; i < providers.length; i++) {
        orClauses.push(`tags LIKE ?`);
        params.push(`%"${providers[i]}"%`);
      }
      clauses.push(`(${orClauses.join(' OR ')})`);
    }

    // Intelligence filters
    if (filters.ownsBuilding)             { clauses.push(`owns_building = ?`); params.push(filters.ownsBuilding); }
    if (filters.worksRemote === 'true')   { clauses.push(`works_remote = 1`); }
    if (filters.excludeRemote === 'true') { clauses.push(`(works_remote IS NULL OR works_remote = 0)`); }
    if (filters.excludeDNC === 'true')    { clauses.push(`(do_not_contact IS NULL OR do_not_contact = 0)`); }

    // Client vertical filter
    if (filters.vertical) {
      const v = filters.vertical;
      const today = new Date().toISOString().slice(0, 10);
      // Exclude contacts snoozed for this vertical — check JSON array
      clauses.push(`(snoozed_verticals IS NULL OR NOT EXISTS (
        SELECT 1 FROM json_each(snoozed_verticals)
        WHERE json_extract(json_each.value,'$.vertical') = ? AND json_extract(json_each.value,'$.until') >= ?
      ))`);
      params.push(v, today);
      if (v === 'solar')            { clauses.push(`owns_building = 'yes'`); }
      if (v === 'office_furniture') { clauses.push(`(works_remote IS NULL OR works_remote = 0)`); }
    }

    return { clauses, params };
  }

  async searchContacts(workspaceId, filters, limit = 100, offset = 0) {
    const { clauses, params } = this._buildFilterClauses(filters);
    const where = clauses.length ? ' AND ' + clauses.join(' AND ') : '';

    const allowedSort = ['created_at', 'email', 'first_name', 'last_name', 'company_name', 'seniority', 'status'];
    const sortField = allowedSort.includes(filters.sortBy) ? filters.sortBy : 'created_at';
    const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';

    const sql = `SELECT * FROM contacts WHERE workspace_id = ?${where} ORDER BY ${sortField} ${sortDir} LIMIT ? OFFSET ?`;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(workspaceId, ...params, limit, offset);
    return rows;
  }

  async getContactsCount(workspaceId, filters = {}) {
    const { clauses, params } = this._buildFilterClauses(filters);
    const where = clauses.length ? ' AND ' + clauses.join(' AND ') : '';
    const sql = `SELECT COUNT(*) as count FROM contacts WHERE workspace_id = ?${where}`;
    const stmt = this.db.prepare(sql);
    const result = stmt.get(workspaceId, ...params);
    return parseInt(result.count, 10);
  }

  async bulkCreateContacts(workspaceId, contacts) {
    const batchSize = 1000;
    let created = 0;

    for (let i = 0; i < contacts.length; i += batchSize) {
      const batch = contacts.slice(i, i + batchSize);

      const stmt = this.db.prepare(`
        INSERT INTO contacts (
          workspace_id, email, first_name, last_name, phone,
          company_name, company_domain, job_title, job_title_cleaned,
          seniority, apollo_id,
          city, state, country,
          company_city, company_state, company_country,
          source, raw_data, tags, imported_at
        ) VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, CURRENT_TIMESTAMP)
        ON CONFLICT(workspace_id, email) DO UPDATE SET
          first_name        = COALESCE(NULLIF(excluded.first_name, ''), contacts.first_name),
          last_name         = COALESCE(NULLIF(excluded.last_name, ''), contacts.last_name),
          phone             = COALESCE(NULLIF(excluded.phone, ''), contacts.phone),
          company_name      = COALESCE(NULLIF(excluded.company_name, ''), contacts.company_name),
          company_domain    = COALESCE(NULLIF(excluded.company_domain, ''), contacts.company_domain),
          job_title         = COALESCE(NULLIF(excluded.job_title, ''), contacts.job_title),
          job_title_cleaned = COALESCE(NULLIF(excluded.job_title_cleaned, ''), contacts.job_title_cleaned),
          seniority         = COALESCE(NULLIF(excluded.seniority, ''), contacts.seniority),
          apollo_id         = COALESCE(NULLIF(excluded.apollo_id, ''), contacts.apollo_id),
          city              = COALESCE(NULLIF(excluded.city, ''), contacts.city),
          state             = COALESCE(NULLIF(excluded.state, ''), contacts.state),
          country           = COALESCE(NULLIF(excluded.country, ''), contacts.country),
          company_city      = COALESCE(NULLIF(excluded.company_city, ''), contacts.company_city),
          company_state     = COALESCE(NULLIF(excluded.company_state, ''), contacts.company_state),
          company_country   = COALESCE(NULLIF(excluded.company_country, ''), contacts.company_country),
          raw_data          = excluded.raw_data,
          tags              = excluded.tags,
          updated_at        = CURRENT_TIMESTAMP;
      `);

      for (const contact of batch) {
        const {
          email, firstName, lastName, phone, companyName, companyDomain,
          jobTitle, jobTitleCleaned, seniority, apolloId, source, rawData, tags
        } = contact;

        const { city, state, country, companyCity, companyState, companyCountry } = contact;
        const result = stmt.run(
          workspaceId, email, firstName || null, lastName || null, phone || null,
          companyName || null, companyDomain || null, jobTitle || null,
          jobTitleCleaned || null, seniority || null,
          apolloId || null,
          city || null, state || null, country || null,
          companyCity || null, companyState || null, companyCountry || null,
          source || 'api', rawData ? JSON.stringify(rawData) : null, JSON.stringify(tags || [])
        );

        if (result.changes > 0) created++;
      }
    }

    return { created };
  }

  async updateContactIntelligence(contactId, fields) {
    const allowed = ['works_remote','owns_building','do_not_contact','snoozed_verticals','reply_notes','last_reply_at','marked_as_lead_at','bounced_at'];
    const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
    if (!sets.length) return 0;
    const vals = Object.keys(fields).filter(k => allowed.includes(k)).map(k =>
      typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]
    );
    const r = this.db.prepare(`UPDATE contacts SET ${sets.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...vals, contactId);
    return r.changes;
  }

  async bulkUpdateVerification(updates) {
    if (!updates.length) return 0;
    const stmt = this.db.prepare(
      `UPDATE contacts SET email_status = ?, email_verified_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    );
    let updated = 0;
    for (const u of updates) {
      const r = stmt.run(u.email_status, u.email_verified_at || new Date().toISOString(), u.id);
      updated += r.changes || 0;
    }
    return updated;
  }

  async backfillLocations(workspaceId) {
    const rows = this.db.prepare(
      `SELECT id, raw_data FROM contacts WHERE workspace_id = ? AND raw_data IS NOT NULL`
    ).all(workspaceId);

    const stmt = this.db.prepare(`
      UPDATE contacts SET
        city=?, state=?, country=?,
        company_city=?, company_state=?, company_country=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `);

    let updated = 0;
    for (const row of rows) {
      try {
        const d = JSON.parse(row.raw_data);
        // Company Address fallback parse: "Street, City, State, Country, PostCode"
        const addrParts = (d['Company Address'] || '').split(',').map(s => s.trim());
        stmt.run(
          d['City'] || null,
          d['State'] || null,
          d['Country'] || null,
          d['Company City'] || addrParts[1] || null,
          d['Company State'] || addrParts[2] || null,
          d['Company Country'] || addrParts[3] || null,
          row.id
        );
        updated++;
      } catch {}
    }
    return updated;
  }

  async deleteNoNameContacts(workspaceId) {
    const stmt = this.db.prepare(
      `DELETE FROM contacts WHERE workspace_id = ?
       AND (first_name IS NULL OR first_name = '')
       AND (last_name IS NULL OR last_name = '')`
    );
    const result = stmt.run(workspaceId);
    return result.changes || 0;
  }

  async updateContactStatus(workspaceId, email, status) {
    const sql = `
      UPDATE contacts
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND email = ?;
    `;
    const stmt = this.db.prepare(sql);
    stmt.run(status, workspaceId, email);
    return { status };
  }

  // ── Analytics ──────────────────────────────────────────────────────────

  async getWorkspaceSummary(workspaceId) {
    const sql = `
      SELECT
        COUNT(*) as total_contacts,
        COUNT(CASE WHEN status = 'new' THEN 1 END) as new_contacts,
        COUNT(CASE WHEN status = 'interested' THEN 1 END) as interested,
        COUNT(CASE WHEN status = 'replied' THEN 1 END) as replied,
        COUNT(CASE WHEN status = 'bounced' THEN 1 END) as bounced,
        COUNT(DISTINCT company_domain) as unique_companies
      FROM contacts
      WHERE workspace_id = ?;
    `;
    const stmt = this.db.prepare(sql);
    return stmt.get(workspaceId);
  }

  async getDistinctValues(field, limit = 100) {
    // Map of table columns (fast query)
    const tableColumns = {
      'job_title': 'job_title_cleaned',
      'jobTitle': 'job_title_cleaned',
      'seniority': 'seniority',
      'status': 'status',
      'company_name': 'company_name',
      'company_domain': 'company_domain',
      'industry': 'industry',
      'job_title': 'job_title',
      'jobTitle':  'job_title_cleaned',
      'city': 'city', 'state': 'state', 'country': 'country',
      'company_city': 'company_city', 'company_state': 'company_state', 'company_country': 'company_country',
    };

    const tableColumn = tableColumns[field];
    if (tableColumn) {
      const sql = `
        SELECT DISTINCT ${tableColumn} as value, COUNT(*) as count
        FROM contacts
        WHERE ${tableColumn} IS NOT NULL AND ${tableColumn} != ''
        GROUP BY ${tableColumn}
        ORDER BY count DESC, ${tableColumn}
        LIMIT ?;
      `;
      const stmt = this.db.prepare(sql);
      const results = stmt.all(limit);
      return results.filter(r => r.value).map(r => ({
        value: r.value,
        count: r.count
      }));
    }

    // Comma-separated fields — split into individual values in JS
    if (field === 'Keywords' || field === 'Technologies') {
      try {
        const stmt = this.db.prepare(
          `SELECT json_extract(raw_data, '$."${field}"') as raw FROM contacts WHERE raw_data IS NOT NULL AND json_extract(raw_data, '$."${field}"') IS NOT NULL AND json_extract(raw_data, '$."${field}"') != ''`
        );
        const rows = stmt.all();
        const counts = {};
        for (const row of rows) {
          for (const item of row.raw.split(',')) {
            const v = item.trim();
            if (v) counts[v] = (counts[v] || 0) + 1;
          }
        }
        return Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([value, count]) => ({ value, count }));
      } catch (err) {
        console.error(`Error extracting ${field}:`, err);
        return [];
      }
    }

    // Extract from raw_data JSON for any CSV column
    const jsonField = field.replace('_', ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const sql = `
      SELECT
        json_extract(raw_data, '$."${jsonField}"') as value,
        COUNT(*) as count
      FROM contacts
      WHERE raw_data IS NOT NULL
        AND json_extract(raw_data, '$."${jsonField}"') IS NOT NULL
        AND json_extract(raw_data, '$."${jsonField}"') != ''
      GROUP BY value
      ORDER BY count DESC, value
      LIMIT ?;
    `;

    try {
      const stmt = this.db.prepare(sql);
      const results = stmt.all(limit);
      return results.filter(r => r.value).map(r => ({
        value: r.value,
        count: r.count
      }));
    } catch (err) {
      console.error(`Error extracting ${field} from raw_data:`, err);
      return [];
    }
  }

  async getEmailProviderStats() {
    const sql = `
      SELECT
        SUM(CASE WHEN tags LIKE '%"email_google"%' THEN 1 ELSE 0 END) as google,
        SUM(CASE WHEN tags LIKE '%"email_outlook"%' THEN 1 ELSE 0 END) as outlook,
        SUM(CASE WHEN tags LIKE '%"email_other"%' THEN 1 ELSE 0 END) as other
      FROM contacts;
    `;
    const stmt = this.db.prepare(sql);
    const row = stmt.get();
    return {
      google: row?.google || 0,
      outlook: row?.outlook || 0,
      other: row?.other || 0
    };
  }

  detectEmailProvider(technologiesStr) {
    if (!technologiesStr) return null;
    const tech = technologiesStr.toLowerCase();

    if (tech.includes('google') || tech.includes('gmail') || tech.includes('workspace') || tech.includes('g suite')) {
      return 'email_google';
    }
    if (tech.includes('outlook') || tech.includes('microsoft 365') || tech.includes('exchange') || tech.includes('office 365')) {
      return 'email_outlook';
    }
    if (tech.includes('mail') || tech.includes('email') || tech.includes('smtp')) {
      return 'email_other';
    }
    return null;
  }

  async backfillEmailProviders() {
    const sql = `SELECT id, technologies, tags FROM contacts WHERE technologies IS NOT NULL AND technologies != '' LIMIT 1000;`;
    const stmt = this.db.prepare(sql);
    const contacts = stmt.all();

    const batchSize = 100;
    let processed = 0;
    let updated = 0;

    for (let i = 0; i < contacts.length; i += batchSize) {
      const batch = contacts.slice(i, i + batchSize);

      for (const contact of batch) {
        const provider = this.detectEmailProvider(contact.technologies);
        if (provider) {
          const existingTags = contact.tags ? JSON.parse(contact.tags) : [];
          if (!existingTags.includes(provider)) {
            const newTags = [...existingTags, provider];
            const updateStmt = this.db.prepare('UPDATE contacts SET tags = ? WHERE id = ?');
            updateStmt.run(JSON.stringify(newTags), contact.id);
            updated++;
          }
        }
        processed++;
      }
    }

    console.log(`[SQLite] Backfilled ${updated}/${processed} email providers`);
    return { processed, updated };
  }
}

module.exports = SqliteDatabase;
