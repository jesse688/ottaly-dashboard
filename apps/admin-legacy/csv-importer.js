const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { normalizeCompany, normalizePerson } = require('./location-normalizer');

class ApolloCSVImporter {
  constructor(db) {
    this.db = db;
  }

  // Clean job title — keep only the primary title, strip secondary roles and noise
  normalizeJobTitle(title) {
    if (!title) return '';
    let t = title.trim();
    // Remove parenthetical notes: (Contract), (Clinical Studies), (Maternity Cover) etc
    t = t.replace(/\s*\([^)]*\)/g, '');
    // Keep only the first role if comma-separated: "Associate Director, Design & Studios" → "Associate Director"
    t = t.replace(/\s*,\s*.+$/, '');
    // Remove " - specialisation/region": "Business Manager - IT Recruitment UK" → "Business Manager"
    t = t.replace(/\s+[-–—]\s+.+$/, '');
    // Strip secondary role after &: "Director & Head of Fine Wine Buying" → "Director"
    t = t.replace(/\s+[&]\s+(Head|Manager|Director|Lead|VP|Chief|Officer|Partner|President|Founder|Owner|Project|Account|Business|Senior|Junior|Associate)\b.+$/i, '');
    // "X And Y Manager" → "X Manager" (strip middle dept word, keep role at end)
    const ROLES = 'Manager|Director|Officer|Lead|Head|President|Coordinator|Analyst|Executive|Advisor|Consultant|Specialist|Partner|Founder|Owner|Strategist';
    const roleAtEnd = new RegExp(`\\s+[Aa]nd\\s+\\w+\\s+(${ROLES})\\s*$`, 'i');
    const m = t.match(roleAtEnd);
    if (m) {
      t = t.replace(roleAtEnd, ' ' + m[1]);
    } else {
      // Fallback: "Analyst And Project Manager" → strip whole "And ..." secondary role
      t = t.replace(new RegExp(`\\s+[Aa]nd\\s+(Head|${ROLES}|Project|Account|Business|Senior|Junior|Associate)\\b.+$`, 'i'), '');
    }
    // Remove bare department suffix: "Associate Director Human Resources" → "Associate Director"
    t = t.replace(/\s+(Human Resources?|Finance|Marketing|Sales|Operations|Technology|IT|Legal|Compliance|Strategy|Communications?|PR|HR)$/i, '');
    // Remove pipe/slash alternates
    t = t.replace(/\s*[|\/\\]\s*.+$/, '');
    // Collapse whitespace
    t = t.replace(/\s+/g, ' ').trim();
    // Title case — preserve known acronyms
    return t.replace(/\b\w+/g, w => {
      const upper = ['CEO','CTO','CFO','CMO','COO','CIO','VP','SVP','EVP','MD','HR','IT','AI','ML','UK','US','EU','PR','BD'];
      return upper.includes(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
  }

  // Clean company names — remove corporate suffixes, sub-brand separators,
  // parentheticals, leading "The". Also title-cases all-caps inputs
  // ("THE DOUBLE A TRADING" → "Double A") while leaving mixed-case names
  // alone so brands like "iPhone", "eBay", "WeWork" aren't mangled.
  cleanCompanyName(name) {
    if (!name) return '';
    let n = name
      .trim()
      // Strip a leading "The " (any case). Keeps "The North Face" → "North Face".
      // Done first so the all-caps detection below treats "The X" the same as "X".
      .replace(/^the\s+/i, '')
      // Remove parenthetical additions: "OLS (The Online Studio)" → "OLS"
      .replace(/\s*\([^)]*\)/g, '')
      // Remove "- Sub brand": "B4B Payments - A Banking Circle Group" → "B4B Payments"
      .replace(/\s+[-–—]\s+.+$/, '')
      // Remove " | anything"
      .replace(/\s*\|.*$/, '')
      // Remove trailing corporate suffixes. Expanded with Trading, Enterprises,
      // Industries, Manufacturing, Distribution etc. — common in B2B exports.
      .replace(/[\s,]+(Inc\.?|Ltd\.?|LLC\.?|L\.L\.C\.?|Corporation|Corp\.?|Co\.?|Company|GmbH|AG|SA|Pty\.?|Ltée|PLC|plc|Limited|Group|Holdings?|Holding|International|Intl\.?|Worldwide|Global|Solutions?|Services?|Consulting|Consultancy|Associates?|Partners?|Ventures?|Technologies?|Systems?|Trading|Enterprises?|Industries|Manufacturing|Distribution|Logistics|Brands?)\.?\s*$/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    // If the result is all-caps (only uppercase letters + spaces/punctuation),
    // title-case it. Mixed-case names ("iPhone", "WeWork") are preserved.
    // Acronyms inside an all-caps string can't be detected so we keep the
    // common ones from the whitelist; everything else gets initial-cap only.
    const hasLower = /[a-z]/.test(n);
    if (!hasLower && /[A-Z]/.test(n)) {
      const acronyms = ['UK','US','USA','EU','AI','ML','IT','HR','PR','BD','IBM','BMW','BBC','HSBC','EY','PwC','KPMG','TSB','RBS','BP','GE','HP','3M'];
      n = n.toLowerCase().replace(/\b[a-z][a-z'']*/g, w => {
        const up = w.toUpperCase();
        if (acronyms.includes(up)) return up;
        return w.charAt(0).toUpperCase() + w.slice(1);
      });
    }
    return n;
  }

  // Parse address string to extract city, state, country.
  // Apollo "Company Address" is usually "City, State, Country" (3 parts).
  // PlusVibe "address_line" is usually "Street, City, State, Country, Postcode"
  // (4–5 parts, leading segment is a street with a number / road suffix).
  parseAddress(address) {
    if (!address) return { city: null, state: null, country: null };

    let parts = address.split(',').map(p => p.trim()).filter(Boolean);
    const result = { city: null, state: null, country: null };

    // Drop a leading street segment: starts with digit, contains a number,
    // or ends in a known thoroughfare suffix.
    const looksLikeStreet = (s) =>
      /^\d/.test(s) ||
      /\b(Road|Rd|Street|St|Avenue|Ave|Lane|Ln|Drive|Dr|Way|Court|Ct|Close|Cl|Place|Pl|Square|Sq|Boulevard|Blvd|Park|Crescent|Terrace|Mews|Wharf|Quay|Hill|Gardens?|Estate)\b\.?$/i.test(s);
    if (parts.length >= 4 && looksLikeStreet(parts[0])) {
      parts = parts.slice(1);
    }

    // Drop a trailing UK/US-style postcode segment (e.g. "OX3 8SX", "SW1V 1", "94107").
    const looksLikePostcode = (s) =>
      /^[A-Z]{1,2}\d[A-Z\d]?\s*\d?[A-Z]{0,2}$/i.test(s) || /^\d{4,6}(-\d{4})?$/.test(s);
    if (parts.length >= 3 && looksLikePostcode(parts[parts.length - 1])) {
      parts = parts.slice(0, -1);
    }

    if (parts.length >= 3) {
      result.city = parts[0];
      result.state = parts[1];
      result.country = parts[2];
    } else if (parts.length === 2) {
      result.city = parts[0];
      result.country = parts[1];
    } else if (parts.length === 1) {
      result.country = parts[0];
    }

    return result;
  }

  // Detect CSV source format. PlusVibe exports have distinctive columns like
  // camp_name / sender_acc_email / is_email_verified; Apollo uses Title-Case headers.
  detectSource(row) {
    if ('camp_name' in row || 'sender_acc_email' in row || 'is_email_verified' in row || 'ws_last_sent_at' in row) {
      return 'plusvibe_csv';
    }
    return 'apollo_csv';
  }

  // Map a CSV row (Apollo OR PlusVibe format) to the contacts schema.
  mapApolloRow(row) {
    const source = this.detectSource(row);

    const rawTitle = row['Title'] || row['Clean Job Title'] || row['Job Title'] || row['job_title'] || '';
    const cleanTitle = this.normalizeJobTitle(rawTitle);
    const rawCompanyName = row['Company Name'] || row['Company'] || row['company_name'] || '';
    const cleanCompanyName = this.cleanCompanyName(rawCompanyName);

    // Person location — direct columns from Apollo or PlusVibe
    const personCity    = row['City']    || row['city']    || '';
    const personState   = row['State']   || row['state']   || '';
    const personCountry = row['Country'] || row['country'] || '';

    // Company location — Apollo has dedicated Company * columns; PlusVibe only
    // has address_line which we parse heuristically.
    const addressStr = row['Company Address'] || row['address_line'] || '';
    const parsedAddress = this.parseAddress(addressStr);
    const companyCity    = row['Company City']    || parsedAddress.city    || '';
    const companyState   = row['Company State']   || parsedAddress.state   || '';
    const companyCountry = row['Company Country'] || parsedAddress.country || '';

    // PlusVibe stores phone as phone_number (with stray leading apostrophe from
    // CSV anti-coercion); strip it.
    let phone = row['Work Direct Phone'] || row['Phone Number'] || row['Phone']
             || row['phone'] || row['phone_number'] || '';
    if (typeof phone === 'string') phone = phone.replace(/^'/, '').trim();

    // Last-emailed timestamp from PlusVibe so the global 90-day cooldown
    // protects against contacts already burned in someone else's campaign.
    // Pick the most recent of last_sent_at / ws_last_sent_at; ISO format
    // ('2025-11-12T09:22:53.458Z') drops straight into a TIMESTAMP column.
    const lastSentCandidates = [row['last_sent_at'], row['ws_last_sent_at']]
      .map(v => (v || '').toString().trim())
      .filter(Boolean);
    const lastEmailedAt = lastSentCandidates.length
      ? lastSentCandidates.reduce((a, b) => (a > b ? a : b))
      : '';

    const essentialFields = {
      email: (row['Email'] || row['email'] || '').trim().toLowerCase(),
      firstName: row['First Name'] || row['first_name'] || '',
      lastName: row['Last Name'] || row['last_name'] || '',
      phone,
      companyName: cleanCompanyName,
      companyDomain: row['Website'] || row['Domain'] || row['website'] || row['company_website'] || '',
      jobTitle: rawTitle,
      jobTitleCleaned: cleanTitle,
      seniority: this.mapSeniority(row['Seniority'] || row['seniority'] || ''),
      // Apollo exports "Departments" (plural); PlusVibe exports "department" (singular lowercase)
      department: row['Departments'] || row['Department'] || row['department'] || '',
      subDepartments: row['Sub Departments'] || row['sub_departments'] || '',
      apolloId: row['Apollo Contact Id'] || row['Apollo ID'] || row['apollo_id'] || '',
      // LinkedIn / industry — extract here so they land in dedicated columns
      // for both Apollo and PlusVibe rows (the SQL backfill only knows Apollo keys).
      linkedinUrl: row['Person Linkedin Url'] || row['LinkedIn URL'] || row['linkedin_person_url'] || '',
      companyLinkedinUrl: row['Company Linkedin Url'] || row['linkedin_company_url'] || '',
      industry: row['Industry'] || row['industry'] || '',
      // Keywords + technologies — comma-separated strings; populate dedicated
      // columns so the filter dropdown + ILIKE queries hit indexed columns
      // instead of raw_data JSONB scans.
      keywords: (row['Keywords'] || row['keywords'] || '').toString().trim(),
      technologies: (row['Technologies'] || row['technologies'] || '').toString().trim(),
      // Company size — Apollo encodes it as a range string ("1-10",
      // "10000+") or a bare integer. Normalise to the LOWER bound int
      // so the BETWEEN buckets in the filter match correctly.
      numEmployees: this.parseEmployees(row['# Employees'] || row['Employees'] || row['employees'] || row['Company Size'] || row['num_employees'] || ''),
      // Person location
      city: personCity,
      state: personState,
      country: personCountry,
      // Company location
      companyCity,
      companyState,
      companyCountry,
      companyAddress: addressStr,
      lastEmailedAt: lastEmailedAt || null,
      // Campaign name from PlusVibe — used by the per-campaign dedup check
      // on push to avoid re-adding contacts that already sit in this
      // campaign on PlusVibe's side.
      lastCampaignName: (row['camp_name'] || '').toString().trim() || null,
      source,
      tags: this.extractTags(row, source)
    };

    // Normalise location into the clean Country>Region>County>City>Town
    // hierarchy. Company is the default target; person mirrors it. The raw
    // company_* / person fields above feed the normaliser.
    const companyLoc = normalizeCompany({
      company_address: addressStr,
      company_city: companyCity,
      company_state: companyState,
      company_country: companyCountry,
    });
    const personLoc = normalizePerson({
      city: personCity,
      state: personState,
      country: personCountry,
    });

    const normalizedLocation = {
      // Company — overwrite city/country with cleaned values, add the rest.
      companyCountry: companyLoc.country || companyCountry || null,
      companyRegion: companyLoc.region || null,
      companyCounty: companyLoc.county || null,
      companyCityNorm: companyLoc.city || companyCity || null,
      companyTown: companyLoc.town || null,
      locationSource: companyLoc.source || null,
      locationNeedsReview: !!companyLoc.needsReview,
      locationReviewReason: companyLoc.reviewReason || null,
      // Person
      personRegion: personLoc.region || null,
      personCounty: personLoc.county || null,
      personTown: personLoc.town || null,
    };

    return {
      ...essentialFields,
      ...normalizedLocation,
      rawData: row  // Store entire CSV row with all columns
    };
  }

  // Parse Apollo's `# Employees` cell into an integer (lower bound for
  // ranges). Returns null for unparseable / empty values so the column
  // stays NULL — that maps to the 'Unknown' bucket.
  parseEmployees(value) {
    if (value == null) return null;
    const s = value.toString().replace(/[,\s]/g, '').trim();
    if (!s) return null;
    let m;
    if ((m = s.match(/^(\d+)-(\d+)$/))) return parseInt(m[1], 10);
    if ((m = s.match(/^(\d+)\+$/)))     return parseInt(m[1], 10);
    if ((m = s.match(/^(\d+)$/)))       return parseInt(m[1], 10);
    return null;
  }

  // Map Apollo seniority levels
  mapSeniority(value) {
    if (!value) return null;
    const map = {
      'junior': 'junior',
      'entry': 'junior',
      'manager': 'manager',
      'senior': 'manager',
      'director': 'director',
      'vp': 'vp',
      'c_level': 'c_suite',
      'ceo': 'c_suite',
      'owner': 'c_suite',
      'founder': 'c_suite'
    };
    return map[value.toLowerCase()] || null;
  }

  // Detect email provider from technologies field
  detectEmailProvider(technologiesStr) {
    if (!technologiesStr) return null;
    const tech = technologiesStr.toLowerCase();

    // Google detection
    if (tech.includes('google') || tech.includes('gmail') || tech.includes('workspace') || tech.includes('g suite')) {
      return 'email_google';
    }
    // Outlook detection
    if (tech.includes('outlook') || tech.includes('microsoft 365') || tech.includes('exchange') || tech.includes('office 365')) {
      return 'email_outlook';
    }
    // Other email providers
    if (tech.includes('mail') || tech.includes('email') || tech.includes('smtp') || tech.includes('imap') || tech.includes('pop')) {
      return 'email_other';
    }
    return null;
  }

  // Extract tags from various Apollo / PlusVibe fields
  extractTags(row, source) {
    const tags = [];

    // Apollo verified flag
    if (row['Verified'] === 'true' || row['Verified'] === true) tags.push('verified');
    if (row['Last Activity Date']) tags.push('active');

    // PlusVibe verification: is_email_verified is a string like "verified" / "not verified"
    const pvVerified = (row['is_email_verified'] || '').toString().toLowerCase();
    if (pvVerified === 'verified' || pvVerified === 'true' || pvVerified === '1') tags.push('verified');

    // PlusVibe engagement state from `status` (REPLIED, BOUNCED, SKIPPED, OPENED…)
    const pvStatus = (row['status'] || '').toString().trim().toLowerCase();
    if (pvStatus) tags.push(`pv_${pvStatus}`);

    // PlusVibe email-server flag (mx: MICROSOFT365 / GOOGLE / etc.)
    const mx = (row['mx'] || '').toString().toLowerCase();
    if (mx.includes('microsoft') || mx.includes('365')) tags.push('email_outlook');
    else if (mx.includes('google')) tags.push('email_google');

    // PlusVibe campaign name → tag (sanitised) so we can filter by campaign later
    const camp = (row['camp_name'] || '').toString().trim();
    if (camp) tags.push(`camp:${camp.slice(0, 80)}`);

    // Engagement counters from PlusVibe
    if (+row['replied_count'] > 0) tags.push('replied');
    if (+row['opened_count'] > 0) tags.push('opened');
    if ((row['bounce_desc'] || '').toString().trim()) tags.push('bounced');

    // Detect email provider from Apollo technologies field
    const technologiesStr = row['Technologies'] || row['technologies'] || '';
    const emailProvider = this.detectEmailProvider(technologiesStr);
    if (emailProvider) tags.push(emailProvider);

    // Dedupe
    return Array.from(new Set(tags));
  }

  // Validate contact data — email required, at least one name required
  validateContact(contact) {
    const errors = [];
    if (!contact.email) {
      errors.push('Missing email');
    } else if (!this.isValidEmail(contact.email)) {
      errors.push('Invalid email format');
    }
    if (!contact.firstName && !contact.lastName) {
      errors.push('No name (skipped)');
    }
    return errors;
  }

  isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // Main import function
  async importFromFile(workspaceId, filePath, options = {}) {
    const { skipValidation = false, batchSize = 1000 } = options;

    return new Promise((resolve, reject) => {
      const results = {
        total: 0,
        imported: 0,
        duplicates: 0,
        errors: [],
        batch: {
          id: require('crypto').randomUUID(),
          filename: path.basename(filePath),
          status: 'processing'
        }
      };

      const contacts = [];
      const emailsSeen = new Set();

      const parser = parse({ columns: true, skip_empty_lines: true });

      parser.on('readable', () => {
        let row;
        while ((row = parser.read())) {
          try {
            results.total++;
            const contact = this.mapApolloRow(row);

            if (!contact.email) {
              results.errors.push({
                row: results.total,
                error: 'Missing email'
              });
              continue;
            }

            // Check for duplicates in this batch
            if (emailsSeen.has(contact.email)) {
              results.duplicates++;
              continue;
            }
            emailsSeen.add(contact.email);

            // Validate
            if (!skipValidation) {
              const validationErrors = this.validateContact(contact);
              if (validationErrors.length) {
                results.errors.push({
                  row: results.total,
                  error: validationErrors.join('; ')
                });
                continue;
              }
            }

            contacts.push(contact);

            // Process in batches
            if (contacts.length >= batchSize) {
              this.db.bulkCreateContacts(workspaceId, contacts).then(res => {
                results.imported += res.created || 0;
              }).catch(err => {
                results.errors.push({
                  error: `Batch insert failed: ${err.message}`
                });
              });
              contacts.length = 0;
            }
          } catch (err) {
            results.errors.push({
              row: results.total,
              error: err.message
            });
          }
        }
      });

      parser.on('error', (err) => {
        reject(new Error(`CSV parsing error: ${err.message}`));
      });

      parser.on('end', async () => {
        // Insert remaining contacts
        if (contacts.length > 0) {
          try {
            const res = await this.db.bulkCreateContacts(workspaceId, contacts);
            results.imported += res.created || 0;
          } catch (err) {
            results.errors.push({
              error: `Final batch insert failed: ${err.message}`
            });
          }
        }

        results.batch.status = 'completed';
        results.batch.imported_rows = results.imported;
        results.batch.duplicate_rows = results.duplicates;
        results.batch.error_rows = results.errors.length;

        resolve(results);
      });

      // Start parsing
      fs.createReadStream(filePath).pipe(parser);
    });
  }

  // Batch import from directory
  async importBatchFromDirectory(workspaceId, dirPath) {
    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.csv'))
      .map(f => path.join(dirPath, f));

    const allResults = [];

    for (const file of files) {
      try {
        console.log(`[Importer] Processing ${path.basename(file)}...`);
        const result = await this.importFromFile(workspaceId, file);
        allResults.push(result);
        console.log(
          `[Importer] ${path.basename(file)}: ${result.imported} imported, ${result.duplicates} duplicates, ${result.errors.length} errors`
        );
      } catch (err) {
        console.error(`[Importer] Error processing ${file}:`, err.message);
        allResults.push({
          filename: path.basename(file),
          status: 'failed',
          error: err.message
        });
      }
    }

    return allResults;
  }
}

// Standalone access to the name cleaners — used by server.js at push time
// so values leaving the system are always cleaned, regardless of what's
// currently in the DB. Single source of truth: the methods on the class.
const _cleanerInstance = new ApolloCSVImporter();
function cleanCompanyName(name) {
  return _cleanerInstance.cleanCompanyName(name);
}
function normalizeJobTitle(title) {
  return _cleanerInstance.normalizeJobTitle(title);
}

module.exports = ApolloCSVImporter;
module.exports.cleanCompanyName = cleanCompanyName;
module.exports.normalizeJobTitle = normalizeJobTitle;
