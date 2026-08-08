/**
 * enrich.js — fill industry, city and the ICP/social columns on synced leads.
 *
 * The minimum viable lead is EMAIL + INDUSTRY + LOCATION: a lead the marketing
 * team cannot segment may as well not exist. lead-sync.js supplies those from
 * Companies House when the domain matched a company, but roughly half the pool
 * has no CH record, so the values have to come off the page the scraper already
 * fetched.
 *
 * Three passes, each independent and idempotent — they only touch leads still
 * missing the field they fill, so running repeatedly is free and safe:
 *
 *   classifyIndustry()  meta description  -> contacts.industry
 *   backfillLocation()  scraped address   -> contacts.city
 *   backfillEnrichment() socials + icp    -> company_linkedin_url, technologies,
 *                                            num_employees, job_title
 *
 * Lives here rather than as a script on someone's laptop: this connects over the
 * internal network via the shared pool, so it survives reboots and needs no
 * public database port. An earlier version ran from a workstation over an
 * exposed 5432 and stopped the moment that port was (correctly) closed.
 *
 * Ported verbatim from ottaly-pipeline/src/{classify-industry,backfill-location,
 * backfill-enrichment}.js — the rule tables below are measured against real
 * output and should not be "tidied" without re-measuring.
 */
import { pool } from './db.js'

// ---- RULES (ported verbatim from ottaly-pipeline/src/classify-industry.js) ----
// [industry, /pattern/] — FIRST MATCH WINS, so order matters.
const RULES = [
  // Health & care — specific before general
  ['hospital & health care', /\b(dental|dentist|orthodontic|physiotherap|chiropract|osteopath|podiatr|optician|optometr|veterinar|\bvets?\b|gp surgery|medical practice|clinic|healthcare|health care|nursing home|care home|domiciliary care|home care)\b/i],
  ['health, wellness & fitness', /\b(gym|fitness|personal train|yoga|pilates|wellbeing|wellness|massage|nutrition|dietit|microbiome|slimming|weight loss|spa\b|beauty salon|aesthetics|botox)\b/i],
  ['individual & family services', /\b(childmind|nursery|nurseries|day care|daycare|pre-?school|childcare|fostering|adoption|counsell|psychotherap|support worker)\b/i],
  ['mental health care', /\b(mental health|psycholog|psychiatr|therapy service|cbt\b)\b/i],

  // Trades & construction
  ['construction', /\b(builder|building contractor|construction|extension|loft conversion|renovation|refurbish|groundwork|bricklay|scaffold|roofing|roofer|plaster|render)\b/i],
  ['electrical/electronic manufacturing', /\b(electrician|electrical contractor|rewir|pat testing|niceic)\b/i],
  ['mechanical or industrial engineering', /\b(plumb|heating engineer|boiler|gas safe|hvac|air conditioning|refrigeration|engineering services|cnc|fabricat)\b/i],
  ['building materials', /\b(timber merchant|builders merchant|glazing|glazier|window|conservatory|kitchen fitter|bathroom fitter|flooring|tiling|tiler)\b/i],
  ['facilities services', /\b(cleaning service|commercial clean|domestic clean|window clean|pest control|waste management|facilities management|grounds maintenance|landscap|garden|tree surgeon|arborist)\b/i],
  ['security & investigations', /\b(security service|cctv|alarm system|locksmith|door supervis|private investigat)\b/i],

  // Professional services
  ['accounting', /\b(accountant|accountancy|bookkeep|tax advis|tax return|payroll service|chartered accountant)\b/i],
  ['law practice', /\b(solicitor|law firm|barrister|legal advice|conveyanc|litigation|family law|criminal defence)\b/i],
  ['legal services', /\b(legal service|will writing|probate|notary|paralegal)\b/i],
  ['management consulting', /\b(business consult|management consult|strategy consult|business advis|business coach|change management)\b/i],
  ['marketing & advertising', /\b(marketing agency|digital marketing|seo\b|ppc\b|social media agency|advertising agency|branding agency|content marketing|email marketing)\b/i],
  ['design', /\b(graphic design|web design|interior design|product design|design studio|branding|illustrat)\b/i],
  ['information technology & services', /\b(it support|it services|managed service|software develop|web develop|app develop|cyber ?security|cloud service|network support|it consult)\b/i],
  ['staffing & recruiting', /\b(recruitment|recruiting|staffing|employment agency|headhunt|talent acquisition)\b/i],
  ['architecture & planning', /\b(architect|architectural|planning consult|town planning)\b/i],
  ['civil engineering', /\b(civil engineer|structural engineer|surveying|quantity surveyor|geotechnical)\b/i],
  ['real estate', /\b(estate agent|letting agent|property management|property developer|lettings|residential sales|commercial property)\b/i],
  ['financial services', /\b(financial advis|mortgage|independent financial|wealth management|investment advice|pension advice|financial planning)\b/i],
  ['insurance', /\b(insurance broker|insurance service|underwrit|claims management)\b/i],
  ['professional training & coaching', /\b(training provider|training course|apprenticeship|first aid training|health and safety training|life coach|executive coach|driving instructor|driving school)\b/i],
  ['public relations & communications', /\b(public relations|\bpr agency|communications agency|copywrit)\b/i],
  ['photography', /\b(photograph|videograph|film production|wedding photo)\b/i],
  ['translation & localization', /\b(translation service|interpret(er|ing) service|localisation)\b/i],

  // Retail / hospitality / consumer
  ['restaurants', /\b(restaurant|bistro|takeaway|fish and chip|pizzeria|indian cuisine|chinese takeaway|cafe|coffee shop|catering|private chef|caterer)\b/i],
  ['food & beverages', /\b(bakery|butcher|brewery|distiller|winery|farm shop|delicatessen|food producer|drinks brand)\b/i],
  ['hospitality', /\b(hotel|\bb&b\b|bed and breakfast|guest house|holiday let|self catering|caravan park|campsite|wedding venue)\b/i],
  ['leisure, travel & tourism', /\b(travel agent|tour operator|holiday|adventure|activity centre|tourist attraction)\b/i],
  ['apparel & fashion', /\b(clothing|fashion|boutique|menswear|womenswear|bridal|tailor|dressmaker)\b/i],
  ['retail', /\b(shop online|online store|retailer|gift shop|garden centre|convenience store|farm shop)\b/i],
  ['automotive', /\b(garage|mot\b|car repair|vehicle repair|bodyshop|car sales|used cars|car dealer|tyre|valeting|car hire)\b/i],
  ['transportation/trucking/railroad', /\b(haulage|courier|delivery service|removals|man and van|taxi|private hire|minibus|coach hire)\b/i],
  ['logistics & supply chain', /\b(logistics|freight|warehousing|supply chain|distribution)\b/i],
  ['events services', /\b(event management|event planner|party planner|entertainment agency|dj hire|marquee)\b/i],
  ['sports', /\b(football club|cricket club|rugby club|sports club|golf club|leisure centre|swimming)\b/i],

  // Education / nonprofit / other
  ['primary/secondary education', /\b(primary school|secondary school|academy trust|\bschool\b|college)\b/i],
  ['education management', /\b(tutor|tuition|education service|learning centre)\b/i],
  ['nonprofit organization management', /\b(charity|charitable|not[- ]for[- ]profit|community interest|volunteer|foundation|trust\b)\b/i],
  ['religious institutions', /\b(church|chapel|parish|mosque|synagogue|cathedral)\b/i],
  ['environmental services', /\b(recycling|renewable|solar panel|energy efficiency|environmental consult|sustainab)\b/i],
  ['farming', /\b(farm\b|farming|agricultur|livestock|arable|equestrian|stables)\b/i],
  ['printing', /\b(printing|printer|signage|sign maker|large format|embroider|garment print)\b/i],
  ['machinery', /\b(machinery|plant hire|tool hire|equipment hire|forklift)\b/i],
  ['wholesale', /\b(wholesale|distributor|trade supplier|trade only)\b/i],
  ['consumer services', /\b(dry clean|laundry|hairdress|barber|nail salon|tattoo|funeral director|florist|pet groom|dog walk)\b/i],
];

// ---- LOCATION TABLES (ported verbatim from backfill-location.js) ----
// UK postcode AREA (the letter prefix) -> the town it covers. Areas are
// geographically stable, so this needs no external lookup service.
const PC_AREA = {
  AB:'Aberdeen', AL:'St Albans', B:'Birmingham', BA:'Bath', BB:'Blackburn', BD:'Bradford',
  BH:'Bournemouth', BL:'Bolton', BN:'Brighton', BR:'Bromley', BS:'Bristol', BT:'Belfast',
  CA:'Carlisle', CB:'Cambridge', CF:'Cardiff', CH:'Chester', CM:'Chelmsford', CO:'Colchester',
  CR:'Croydon', CT:'Canterbury', CV:'Coventry', CW:'Crewe', DA:'Dartford', DD:'Dundee',
  DE:'Derby', DG:'Dumfries', DH:'Durham', DL:'Darlington', DN:'Doncaster', DT:'Dorchester',
  DY:'Dudley', E:'London', EC:'London', EH:'Edinburgh', EN:'Enfield', EX:'Exeter',
  FK:'Falkirk', FY:'Blackpool', G:'Glasgow', GL:'Gloucester', GU:'Guildford', HA:'Harrow',
  HD:'Huddersfield', HG:'Harrogate', HP:'Hemel Hempstead', HR:'Hereford', HS:'Isle of Lewis',
  HU:'Hull', HX:'Halifax', IG:'Ilford', IP:'Ipswich', IV:'Inverness', KA:'Kilmarnock',
  KT:'Kingston upon Thames', KW:'Kirkwall', KY:'Kirkcaldy', L:'Liverpool', LA:'Lancaster',
  LD:'Llandrindod Wells', LE:'Leicester', LL:'Llandudno', LN:'Lincoln', LS:'Leeds', LU:'Luton',
  M:'Manchester', ME:'Maidstone', MK:'Milton Keynes', ML:'Motherwell', N:'London', NE:'Newcastle upon Tyne',
  NG:'Nottingham', NN:'Northampton', NP:'Newport', NR:'Norwich', NW:'London', OL:'Oldham',
  OX:'Oxford', PA:'Paisley', PE:'Peterborough', PH:'Perth', PL:'Plymouth', PO:'Portsmouth',
  PR:'Preston', RG:'Reading', RH:'Redhill', RM:'Romford', S:'Sheffield', SA:'Swansea',
  SE:'London', SG:'Stevenage', SK:'Stockport', SL:'Slough', SM:'Sutton', SN:'Swindon',
  SO:'Southampton', SP:'Salisbury', SR:'Sunderland', SS:'Southend-on-Sea', ST:'Stoke-on-Trent',
  SW:'London', SY:'Shrewsbury', TA:'Taunton', TD:'Galashiels', TF:'Telford', TN:'Tonbridge',
  TQ:'Torquay', TR:'Truro', TS:'Middlesbrough', TW:'Twickenham', UB:'Southall', W:'London',
  WA:'Warrington', WC:'London', WD:'Watford', WF:'Wakefield', WN:'Wigan', WR:'Worcester',
  WS:'Walsall', WV:'Wolverhampton', YO:'York', ZE:'Lerwick',
};

// Towns worth matching by name when no postcode is present. Longest first so
// "Newcastle upon Tyne" wins over "Newcastle".
const TOWNS = [
  'Newcastle upon Tyne','Kingston upon Thames','Stoke-on-Trent','Southend-on-Sea','Stratford-upon-Avon',
  'Weston-super-Mare','Berwick-upon-Tweed','Burton upon Trent','Bury St Edmunds','Royal Tunbridge Wells',
  'Hemel Hempstead','Milton Keynes','St Albans','Isle of Wight','Isle of Man',
  'London','Birmingham','Manchester','Liverpool','Leeds','Sheffield','Bristol','Glasgow','Edinburgh',
  'Cardiff','Belfast','Nottingham','Leicester','Coventry','Bradford','Newcastle','Sunderland',
  'Brighton','Hull','Plymouth','Stoke','Wolverhampton','Derby','Swansea','Southampton','Portsmouth',
  'Reading','Northampton','Luton','Aberdeen','Dundee','Norwich','Ipswich','Oxford','Cambridge',
  'Exeter','Gloucester','Blackpool','Middlesbrough','Bolton','Bournemouth','Peterborough','Preston',
  'Warrington','Huddersfield','Slough','York','Poole','Swindon','Basildon','Worthing','Colchester',
  'Chelmsford','Doncaster','Rotherham','Barnsley','Wakefield','Oldham','Rochdale','Salford','Stockport',
  'Wigan','Blackburn','Burnley','Chester','Carlisle','Lancaster','Harrogate','Scarborough','Grimsby',
  'Lincoln','Mansfield','Chesterfield','Telford','Shrewsbury','Worcester','Hereford','Bath','Taunton',
  'Torquay','Truro','Plymouth','Salisbury','Winchester','Guildford','Woking','Crawley','Maidstone',
  'Canterbury','Dover','Folkestone','Hastings','Eastbourne','Watford','Stevenage','Basingstoke',
  'Aylesbury','High Wycombe','Bedford','Kettering','Corby','Rugby','Nuneaton','Solihull','Walsall',
  'Dudley','Redditch','Kidderminster','Stafford','Crewe','Macclesfield','Wrexham','Bangor','Newport',
  'Llandudno','Aberystwyth','Inverness','Perth','Stirling','Falkirk','Paisley','Ayr','Kilmarnock',
  'Dumfries','Galashiels','Livingston','Motherwell','Hamilton','Greenock','Londonderry','Lisburn',
];
const TOWN_RES = TOWNS.map(t => [t, new RegExp(`\\b${t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i')]);

const POSTCODE_RE = /\b([A-Z]{1,2})\d[A-Z\d]?\s?\d[A-Z]{2}\b/i;

function classify(text) {
  if (!text) return null
  const t = String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  if (t.length < 15) return null   // too short to be reliable
  for (const [industry, re] of RULES) if (re.test(t)) return industry
  return null
}

function cityFrom(address) {
  if (!address) return null
  const s = String(address)
  // 1. Postcode area — definitive, and survives surrounding junk.
  const pc = s.toUpperCase().match(POSTCODE_RE)
  if (pc && PC_AREA[pc[1]]) return PC_AREA[pc[1]]
  // 2. A known town named in the string.
  for (const [town, re] of TOWN_RES) if (re.test(s)) return town
  return null
}

/**
 * extractNames() emits "Devika Sadhotra — Practice Manager" for a titled person
 * and a bare "Second Opinion" for anything it could not attribute. Only the
 * titled form is worth promoting: an untitled string is as likely to be a page
 * heading as a human, and a wrong job_title is worse than an empty one.
 */
function pickTitledPerson(rawNames) {
  for (const entry of rawNames || []) {
    const parts = String(entry).split('—')
    if (parts.length < 2) continue
    const words = parts[0].trim().split(/\s+/)
    if (words.length < 2) continue
    const tc = x => x.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase())
    const title = parts.slice(1).join('—').trim()
    if (!title) continue
    return { first: tc(words[0]), last: tc(words[words.length - 1]), title }
  }
  return null
}

/**
 * Company LinkedIn only. The scraper reads links off the page, so a /company/
 * URL is the business itself; a /in/ URL is as often whoever built the site as
 * the owner, and would be plainly wrong against a role address like info@.
 */
const companyLinkedIn = s =>
  (s?.linkedin && /\/company\//i.test(String(s.linkedin))) ? String(s.linkedin) : null

/** ICP tech[] -> the comma-joined string the existing `technologies` filter reads. */
function techString(icp) {
  const tech = Array.isArray(icp?.tech) ? icp.tech.filter(Boolean) : []
  if (icp?.platform && !tech.includes(icp.platform)) tech.unshift(icp.platform)
  return tech.length ? tech.join(', ') : null
}

const ROLE_RE = /^(info|hello|enquiries|enquiry|admin|contact|office|mail|reception|sales|support|team|accounts|bookings|hi|post|general)@/i

const CHUNK = 500

/** Industry from the site's own words, for leads with no CH SIC code. */
export async function classifyIndustry({ limit = 100000 } = {}) {
  const { rows } = await pool.query(`
    SELECT c.id, sc.description, sc.keywords, sc.business_type
      FROM contacts c
      JOIN scraped_contacts sc ON sc.domain = c.company_domain
     WHERE c.source = 'commoncrawl'
       AND c.industry IS NULL
       AND (sc.description IS NOT NULL OR array_length(sc.keywords,1) > 0
            OR sc.business_type IS NOT NULL)
     LIMIT $1`, [limit])

  const updates = []
  for (const r of rows) {
    const text = [r.description, (r.keywords || []).join(' '), r.business_type]
      .filter(Boolean).join(' . ')
    const ind = classify(text)
    if (ind) updates.push([r.id, ind])
  }
  for (let i = 0; i < updates.length; i += CHUNK) {
    const s = updates.slice(i, i + CHUNK)
    await pool.query(
      `UPDATE contacts SET industry = u.ind
         FROM (SELECT unnest($1::uuid[]) id, unnest($2::text[]) ind) u
        WHERE contacts.id = u.id`,
      [s.map(x => x[0]), s.map(x => x[1])])
  }
  return { candidates: rows.length, updated: updates.length }
}

/**
 * City from the scraped address. Anything unresolved is left NULL rather than
 * guessed — a wrong location is worse than a blank one, because it puts the lead
 * in the wrong regional campaign.
 */
export async function backfillLocation({ limit = 100000 } = {}) {
  const { rows } = await pool.query(`
    SELECT c.id, sc.address
      FROM contacts c
      JOIN scraped_contacts sc ON sc.domain = c.company_domain
     WHERE c.source = 'commoncrawl' AND c.city IS NULL AND sc.address IS NOT NULL
     LIMIT $1`, [limit])

  const updates = []
  for (const r of rows) {
    const city = cityFrom(r.address)
    if (city) updates.push([r.id, city.toUpperCase()])  // matches CH city casing
  }
  for (let i = 0; i < updates.length; i += CHUNK) {
    const s = updates.slice(i, i + CHUNK)
    await pool.query(
      `UPDATE contacts SET city = u.c
         FROM (SELECT unnest($1::uuid[]) id, unnest($2::text[]) c) u
        WHERE contacts.id = u.id`,
      [s.map(x => x[0]), s.map(x => x[1])])
  }
  return { candidates: rows.length, updated: updates.length }
}

/**
 * Socials, ICP signals and job titles onto leads synced before lead-sync.js
 * carried them. Strictly additive: every column goes through COALESCE so an
 * existing value always wins, and emailed_workspaces / sent_count are untouched.
 */
export async function backfillEnrichment({ limit = 100000 } = {}) {
  const { rows } = await pool.query(`
    SELECT c.id, c.email, c.first_name, c.last_name, sc.socials, sc.icp, sc.raw_names
      FROM contacts c
      JOIN scraped_contacts sc ON sc.domain = c.company_domain
     WHERE c.source = 'commoncrawl'
       AND (sc.socials IS NOT NULL OR sc.icp IS NOT NULL
            OR array_length(sc.raw_names,1) > 0)
       AND (c.company_linkedin_url IS NULL OR c.technologies IS NULL
            OR c.num_employees IS NULL OR c.job_title IS NULL)
     LIMIT $1`, [limit])

  const updates = []
  for (const r of rows) {
    const titled = pickTitledPerson(r.raw_names)
    const li = companyLinkedIn(r.socials)
    const tech = techString(r.icp)
    const emp = Number.isFinite(r.icp?.team_size) ? r.icp.team_size : null

    // A job title may only ride along with the person it belongs to; otherwise
    // the team is told that info@ is the Managing Director.
    const samePerson = titled && r.first_name && r.last_name
      && titled.first.toLowerCase() === String(r.first_name).toLowerCase()
      && titled.last.toLowerCase() === String(r.last_name).toLowerCase()
    const useTitled = titled && ROLE_RE.test(r.email || '') && !r.first_name && !r.last_name
    const title = (samePerson || useTitled) ? titled.title : null

    const socials = r.socials && Object.keys(r.socials).length ? r.socials : null
    if (!li && !tech && emp == null && !title && !socials) continue

    updates.push([r.id, li, tech, emp, title,
                  useTitled ? titled.first : null, useTitled ? titled.last : null,
                  JSON.stringify({ socials, icp: r.icp || null })])
  }

  for (let i = 0; i < updates.length; i += CHUNK) {
    const s = updates.slice(i, i + CHUNK)
    await pool.query(
      `UPDATE contacts c SET
         company_linkedin_url = COALESCE(c.company_linkedin_url, u.li),
         technologies         = COALESCE(c.technologies, u.tech),
         num_employees        = COALESCE(c.num_employees, u.emp),
         job_title            = COALESCE(c.job_title, u.title),
         first_name           = COALESCE(c.first_name, u.fn),
         last_name            = COALESCE(c.last_name, u.ln),
         raw_data             = COALESCE(c.raw_data, '{}'::jsonb) || u.extra
       FROM (SELECT unnest($1::uuid[]) id, unnest($2::text[]) li, unnest($3::text[]) tech,
                    unnest($4::int[]) emp, unnest($5::text[]) title,
                    unnest($6::text[]) fn, unnest($7::text[]) ln,
                    unnest($8::jsonb[]) extra) u
      WHERE c.id = u.id`,
      [s.map(x=>x[0]), s.map(x=>x[1]), s.map(x=>x[2]), s.map(x=>x[3]),
       s.map(x=>x[4]), s.map(x=>x[5]), s.map(x=>x[6]), s.map(x=>x[7])])
  }
  return { candidates: rows.length, updated: updates.length }
}

export const enrichState = {
  lastRun: null, lastError: null, running: false,
  industry: null, location: null, enrichment: null,
}

/** All three passes. Never throws — a failed pass must not stop the timer. */
export async function runEnrichment(opts = {}) {
  if (enrichState.running) return { skipped: 'already running' }
  enrichState.running = true
  try {
    enrichState.industry   = await classifyIndustry(opts)
    enrichState.location   = await backfillLocation(opts)
    enrichState.enrichment = await backfillEnrichment(opts)
    enrichState.lastRun = new Date().toISOString()
    enrichState.lastError = null
    const n = enrichState.industry.updated + enrichState.location.updated
            + enrichState.enrichment.updated
    if (n) console.log(`[enrich] industry ${enrichState.industry.updated}, `
      + `city ${enrichState.location.updated}, `
      + `enrichment ${enrichState.enrichment.updated}`)
    return enrichState
  } catch (e) {
    enrichState.lastError = e.message
    console.error('[enrich]', e.message)
    return enrichState
  } finally {
    enrichState.running = false
  }
}
