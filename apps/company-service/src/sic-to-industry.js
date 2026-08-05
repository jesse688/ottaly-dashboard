/**
 * sic-to-industry.js — map UK SIC codes to the industry vocabulary already in
 * `contacts`.
 *
 * The team filters on `contacts.industry`, which holds Apollo-style names
 * ("construction", "accounting", "health, wellness & fitness"). Writing raw SIC
 * codes there would make new leads invisible to every existing filter and saved
 * view, since a million existing rows speak the other language.
 *
 * Targets are taken from the values actually in use, most-common first, so the
 * mapping lands on real filter options rather than plausible-looking synonyms.
 *
 * Deliberately partial. Codes with no confident mapping return null and the
 * field is left blank — a wrong industry is worse than an empty one, because it
 * puts a lead in the wrong campaign. 99999 ("dormant / not trading") is
 * explicitly excluded for the same reason.
 *
 * Coverage: the codes listed here account for the large majority of scraped
 * rows; the long tail is left unmapped by design.
 */

// Exact 5-digit SIC -> industry name.
const EXACT = {
  // Health & care — the single biggest cluster in the scraped set
  '86900': 'health, wellness & fitness',
  '86220': 'hospital & health care',
  '86210': 'hospital & health care',
  '86230': 'hospital & health care',
  '86101': 'hospital & health care',
  '86102': 'hospital & health care',
  '87100': 'hospital & health care',
  '87300': 'hospital & health care',
  '87900': 'hospital & health care',
  '88100': 'individual & family services',
  '88910': 'individual & family services',
  '88990': 'individual & family services',

  // Construction & trades
  '41100': 'construction',
  '41201': 'construction',
  '41202': 'construction',
  '42990': 'civil engineering',
  '42110': 'civil engineering',
  '43210': 'construction',
  '43220': 'construction',
  '43290': 'construction',
  '43310': 'construction',
  '43320': 'construction',
  '43330': 'construction',
  '43341': 'construction',
  '43342': 'construction',
  '43390': 'construction',
  '43910': 'construction',
  '43999': 'construction',
  '43120': 'construction',
  '43130': 'construction',

  // Property
  '68100': 'real estate',
  '68209': 'real estate',
  '68201': 'real estate',
  '68202': 'real estate',
  '68310': 'real estate',
  '68320': 'real estate',

  // Professional services
  '69101': 'law practice',
  '69102': 'legal services',
  '69109': 'legal services',
  '69201': 'accounting',
  '69202': 'accounting',
  '69203': 'accounting',
  '70100': 'management consulting',
  '70210': 'public relations & communications',
  '70221': 'management consulting',
  '70229': 'management consulting',
  '71111': 'architecture & planning',
  '71112': 'architecture & planning',
  '71121': 'civil engineering',
  '71122': 'civil engineering',
  '71129': 'mechanical or industrial engineering',
  '71200': 'mechanical or industrial engineering',
  '73110': 'marketing & advertising',
  '73120': 'marketing & advertising',
  '73200': 'market research',
  '74100': 'design',
  '74201': 'photography',
  '74202': 'photography',
  '74300': 'translation & localization',
  '74909': 'management consulting',
  '74990': 'management consulting',
  '78100': 'staffing & recruiting',
  '78200': 'staffing & recruiting',
  '78300': 'staffing & recruiting',
  '82990': 'business supplies & equipment',
  '82911': 'financial services',
  '82920': 'packaging & containers',

  // Finance & insurance
  '64191': 'banking',
  '64209': 'investment management',
  '64301': 'investment management',
  '64999': 'financial services',
  '65110': 'insurance',
  '65120': 'insurance',
  '66190': 'financial services',
  '66210': 'insurance',
  '66220': 'insurance',
  '66290': 'insurance',
  '66300': 'investment management',

  // IT & media
  '58210': 'computer games',
  '58290': 'computer software',
  '59111': 'media production',
  '59112': 'media production',
  '59120': 'media production',
  '60100': 'broadcast media',
  '60200': 'broadcast media',
  '62012': 'information technology & services',
  '62020': 'information technology & services',
  '62090': 'information technology & services',
  '63110': 'information technology & services',
  '63120': 'internet',
  '61100': 'telecommunications',
  '61200': 'telecommunications',
  '61900': 'telecommunications',

  // Retail & wholesale
  '46900': 'wholesale',
  '47110': 'retail',
  '47190': 'retail',
  '47300': 'retail',
  '47530': 'retail',
  '47599': 'retail',
  '47710': 'apparel & fashion',
  '47730': 'retail',
  '47789': 'retail',
  '47910': 'retail',
  '47990': 'retail',

  // Hospitality & leisure
  '55100': 'hospitality',
  '55201': 'hospitality',
  '55209': 'hospitality',
  '56101': 'restaurants',
  '56102': 'restaurants',
  '56103': 'restaurants',
  '56210': 'food & beverages',
  '56290': 'food & beverages',
  '56302': 'restaurants',
  '79110': 'leisure, travel & tourism',
  '79120': 'leisure, travel & tourism',
  '79900': 'leisure, travel & tourism',
  '93110': 'sports',
  '93120': 'sports',
  '93130': 'health, wellness & fitness',
  '93199': 'sports',
  '93290': 'entertainment',
  '90010': 'entertainment',
  '90020': 'entertainment',
  '90030': 'fine art',
  '90040': 'entertainment',

  // Manufacturing
  '10710': 'food production',
  '10890': 'food production',
  '11010': 'food & beverages',
  '13990': 'textiles',
  '14190': 'apparel & fashion',
  '16290': 'building materials',
  '18129': 'printing',
  '18130': 'printing',
  '22190': 'plastics',
  '22290': 'plastics',
  '23610': 'building materials',
  '25110': 'building materials',
  '25620': 'mechanical or industrial engineering',
  '25990': 'mechanical or industrial engineering',
  '26110': 'electrical/electronic manufacturing',
  '27900': 'electrical/electronic manufacturing',
  '28990': 'machinery',
  '31090': 'furniture',
  '32990': 'consumer goods',
  '33120': 'machinery',
  '33200': 'mechanical or industrial engineering',

  // Transport & logistics
  '49320': 'transportation/trucking/railroad',
  '49410': 'transportation/trucking/railroad',
  '52100': 'logistics & supply chain',
  '52290': 'logistics & supply chain',
  '53202': 'logistics & supply chain',

  // Education
  '85100': 'primary/secondary education',
  '85200': 'primary/secondary education',
  '85310': 'primary/secondary education',
  '85320': 'education management',
  '85410': 'higher education',
  '85421': 'higher education',
  '85590': 'professional training & coaching',
  '85600': 'education management',

  // Energy & environment
  '35110': 'utilities',
  '35140': 'utilities',
  '36000': 'utilities',
  '37000': 'environmental services',
  '38110': 'environmental services',
  '38210': 'environmental services',
  '39000': 'environmental services',

  // Other services
  '45112': 'automotive',
  '45200': 'automotive',
  '45320': 'automotive',
  '80100': 'security & investigations',
  '80200': 'security & investigations',
  '81210': 'facilities services',
  '81221': 'facilities services',
  '81300': 'facilities services',
  '94990': 'nonprofit organization management',
  '96010': 'consumer services',
  '96020': 'consumer services',
  '96030': 'consumer services',
  '96040': 'health, wellness & fitness',
  '96090': 'consumer services',
  '98000': 'consumer services',
  '99999': null,   // "dormant / not trading" — no meaningful industry
}

// Fallback by 2-digit SIC division, used when the exact code isn't listed.
// Coarser but still correct at the division level.
const DIVISION = {
  '01': 'farming', '02': 'farming', '03': 'fishery',
  '10': 'food production', '11': 'food & beverages', '13': 'textiles',
  '14': 'apparel & fashion', '16': 'building materials', '17': 'paper & forest products',
  '18': 'printing', '20': 'chemicals', '21': 'pharmaceuticals', '22': 'plastics',
  '23': 'building materials', '24': 'mining & metals', '25': 'mechanical or industrial engineering',
  '26': 'electrical/electronic manufacturing', '27': 'electrical/electronic manufacturing',
  '28': 'machinery', '29': 'automotive', '30': 'automotive', '31': 'furniture',
  '32': 'consumer goods', '33': 'mechanical or industrial engineering',
  '35': 'utilities', '36': 'utilities', '37': 'environmental services',
  '38': 'environmental services', '39': 'environmental services',
  '41': 'construction', '42': 'civil engineering', '43': 'construction',
  '45': 'automotive', '46': 'wholesale', '47': 'retail',
  '49': 'transportation/trucking/railroad', '50': 'maritime', '51': 'airlines/aviation',
  '52': 'logistics & supply chain', '53': 'logistics & supply chain',
  '55': 'hospitality', '56': 'restaurants',
  '58': 'publishing', '59': 'media production', '60': 'broadcast media',
  '61': 'telecommunications', '62': 'information technology & services',
  '63': 'information technology & services',
  '64': 'financial services', '65': 'insurance', '66': 'financial services',
  '68': 'real estate', '69': 'legal services', '70': 'management consulting',
  '71': 'architecture & planning', '72': 'research', '73': 'marketing & advertising',
  '74': 'design', '75': 'veterinary', '77': 'consumer services',
  '78': 'staffing & recruiting', '79': 'leisure, travel & tourism',
  '80': 'security & investigations', '81': 'facilities services', '82': 'business supplies & equipment',
  '84': 'government administration', '85': 'education management',
  '86': 'hospital & health care', '87': 'hospital & health care', '88': 'individual & family services',
  '90': 'entertainment', '91': 'museums & institutions', '92': 'gambling & casinos',
  '93': 'sports', '94': 'nonprofit organization management',
  '95': 'consumer services', '96': 'consumer services',
}

/**
 * @param {string|null} sicCodes  ch_companies.sic_codes — may be comma-separated
 * @returns {string|null} industry name, or null when there's no confident match
 */
export function sicToIndustry(sicCodes) {
  if (!sicCodes) return null
  // Multi-code companies: first code is the primary activity.
  for (const raw of String(sicCodes).split(',')) {
    const code = raw.trim()
    if (!code) continue
    if (code in EXACT) {
      const v = EXACT[code]
      if (v) return v
      continue          // explicit null (e.g. 99999) — try the next code
    }
    const div = DIVISION[code.slice(0, 2)]
    if (div) return div
  }
  return null
}

export { EXACT as SIC_EXACT, DIVISION as SIC_DIVISION }
