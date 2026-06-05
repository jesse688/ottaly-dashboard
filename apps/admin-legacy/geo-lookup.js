'use strict';

/**
 * geo-lookup.js — Reference data for normalising company/person locations
 * into a clean hierarchy: Country > Region > County > City > Town.
 *
 * DESIGN
 * ------
 * The single most reliable signal in our data is the UK POSTCODE (present in
 * ~62% of UK addresses as a full code, and most of the rest as a partial
 * outward code). A postcode's AREA (the 1–2 leading letters) maps
 * deterministically to a post town, a dominant county, and a region. That
 * mapping is the auditable core below (POSTCODE_AREAS).
 *
 * When there is no postcode we fall back to a curated CITY/TOWN name table
 * (PLACES), then to the country-level value, then we flag the row for review.
 *
 * AUDITABILITY
 * ------------
 * - REGIONS are the 9 ONS statistical regions of England, plus Scotland,
 *   Wales, Northern Ireland as nation-level "regions".
 * - REGION_COUNTIES lists the counties under each region (ceremonial /
 *   commonly-used counties, the ones that appear in B2B address data).
 * - POSTCODE_AREAS is the 124-area UK postcode list. Region is reliable;
 *   county is the DOMINANT county for that area (a few areas straddle a
 *   boundary — those are marked with a NOTE comment).
 *
 * Everything here is plain data + pure helpers. No DB, no network.
 */

// ---------------------------------------------------------------------------
// Countries — normalisation of the messy country slot into canonical names.
// England / Scotland / Wales / Northern Ireland all roll up to United Kingdom.
// Republic of Ireland is a SEPARATE country from Northern Ireland.
// ---------------------------------------------------------------------------
const COUNTRY_ALIASES = {
  'united kingdom': 'United Kingdom',
  'uk': 'United Kingdom',
  'u.k.': 'United Kingdom',
  'great britain': 'United Kingdom',
  'gb': 'United Kingdom',
  'gbr': 'United Kingdom',
  'britain': 'United Kingdom',
  'england': 'United Kingdom',
  'scotland': 'United Kingdom',
  'wales': 'United Kingdom',
  'cymru': 'United Kingdom',
  'northern ireland': 'United Kingdom',
  'n. ireland': 'United Kingdom',
  'n ireland': 'United Kingdom',

  // Republic of Ireland — distinct country
  'ireland': 'Ireland',
  'republic of ireland': 'Ireland',
  'eire': 'Ireland',
  'roi': 'Ireland',

  // Other common countries in the data
  'australia': 'Australia',
  'aus': 'Australia',
  'united states': 'United States',
  'usa': 'United States',
  'us': 'United States',
  'u.s.': 'United States',
  'united states of america': 'United States',
  'canada': 'Canada',
  'new zealand': 'New Zealand',
  'nz': 'New Zealand',
};

// The "home nation" recorded as the country/region slot in UK addresses.
// Used to distinguish nation when a postcode is absent.
const UK_HOME_NATIONS = {
  'england': 'England',
  'scotland': 'Scotland',
  'wales': 'Wales',
  'cymru': 'Wales',
  'northern ireland': 'Northern Ireland',
  'n. ireland': 'Northern Ireland',
  'n ireland': 'Northern Ireland',
};

// ---------------------------------------------------------------------------
// Regions and their counties.
// England: 9 ONS regions. Scotland/Wales/NI/Ireland: nation-level regions
// whose "counties" are councils / traditional counties as they appear in data.
// ---------------------------------------------------------------------------
const REGION_COUNTIES = {
  'London': [
    'Greater London',
  ],
  'South East': [
    'Berkshire', 'Buckinghamshire', 'East Sussex', 'Hampshire',
    'Isle of Wight', 'Kent', 'Oxfordshire', 'Surrey', 'West Sussex',
  ],
  'South West': [
    'Bristol', 'Cornwall', 'Devon', 'Dorset', 'Gloucestershire',
    'Somerset', 'Wiltshire',
  ],
  'East of England': [
    'Bedfordshire', 'Cambridgeshire', 'Essex', 'Hertfordshire',
    'Norfolk', 'Suffolk',
  ],
  'East Midlands': [
    'Derbyshire', 'Leicestershire', 'Lincolnshire', 'Northamptonshire',
    'Nottinghamshire', 'Rutland',
  ],
  'West Midlands': [
    'Herefordshire', 'Shropshire', 'Staffordshire', 'Warwickshire',
    'West Midlands', 'Worcestershire',
  ],
  'Yorkshire and the Humber': [
    'East Riding of Yorkshire', 'North Yorkshire', 'South Yorkshire',
    'West Yorkshire',
  ],
  'North West': [
    'Cheshire', 'Cumbria', 'Greater Manchester', 'Lancashire', 'Merseyside',
  ],
  'North East': [
    'County Durham', 'Northumberland', 'Tyne and Wear',
  ],
  'Scotland': [
    'Aberdeen City', 'Aberdeenshire', 'Angus', 'Argyll and Bute',
    'Clackmannanshire', 'Dumfries and Galloway', 'Dundee City',
    'East Ayrshire', 'East Dunbartonshire', 'East Lothian',
    'East Renfrewshire', 'Edinburgh', 'Falkirk', 'Fife', 'Glasgow',
    'Highland', 'Inverclyde', 'Midlothian', 'Moray', 'North Ayrshire',
    'North Lanarkshire', 'Orkney', 'Perth and Kinross', 'Renfrewshire',
    'Scottish Borders', 'Shetland', 'South Ayrshire', 'South Lanarkshire',
    'Stirling', 'West Dunbartonshire', 'West Lothian', 'Western Isles',
  ],
  'Wales': [
    'Blaenau Gwent', 'Bridgend', 'Caerphilly', 'Cardiff', 'Carmarthenshire',
    'Ceredigion', 'Conwy', 'Denbighshire', 'Flintshire', 'Gwynedd',
    'Isle of Anglesey', 'Merthyr Tydfil', 'Monmouthshire', 'Neath Port Talbot',
    'Newport', 'Pembrokeshire', 'Powys', 'Rhondda Cynon Taf', 'Swansea',
    'Torfaen', 'Vale of Glamorgan', 'Wrexham',
  ],
  'Northern Ireland': [
    'Antrim and Newtownabbey', 'Ards and North Down', 'Armagh City Banbridge and Craigavon',
    'Belfast', 'Causeway Coast and Glens', 'Derry City and Strabane',
    'Fermanagh and Omagh', 'Lisburn and Castlereagh', 'Mid and East Antrim',
    'Mid Ulster', 'Newry Mourne and Down',
  ],
};

// Reverse map: county (lowercased) -> region. Built once.
const COUNTY_TO_REGION = {};
for (const [region, counties] of Object.entries(REGION_COUNTIES)) {
  for (const county of counties) {
    COUNTY_TO_REGION[county.toLowerCase()] = region;
  }
}

// ---------------------------------------------------------------------------
// POSTCODE AREAS — the auditable core.
// area: { postTown, county, region, nation }
// `nation` is the UK home nation (England/Scotland/Wales/Northern Ireland) or
// a Crown Dependency. `region` is the ONS region (or nation for non-England).
//
// NOTE markers flag areas that straddle a county/region boundary; we assign
// the dominant one. Region is reliable; county is best-effort.
// ---------------------------------------------------------------------------
const POSTCODE_AREAS = {
  AB: { postTown: 'Aberdeen',            county: 'Aberdeen City',            region: 'Scotland',                 nation: 'Scotland' },
  AL: { postTown: 'St Albans',           county: 'Hertfordshire',            region: 'East of England',          nation: 'England' },
  B:  { postTown: 'Birmingham',          county: 'West Midlands',            region: 'West Midlands',            nation: 'England' },
  BA: { postTown: 'Bath',                county: 'Somerset',                 region: 'South West',               nation: 'England' },
  BB: { postTown: 'Blackburn',           county: 'Lancashire',               region: 'North West',               nation: 'England' },
  BD: { postTown: 'Bradford',            county: 'West Yorkshire',           region: 'Yorkshire and the Humber', nation: 'England' },
  BH: { postTown: 'Bournemouth',         county: 'Dorset',                   region: 'South West',               nation: 'England' },
  BL: { postTown: 'Bolton',              county: 'Greater Manchester',       region: 'North West',               nation: 'England' },
  BN: { postTown: 'Brighton',            county: 'East Sussex',              region: 'South East',               nation: 'England' },
  BR: { postTown: 'Bromley',             county: 'Greater London',           region: 'London',                   nation: 'England' },
  BS: { postTown: 'Bristol',             county: 'Bristol',                  region: 'South West',               nation: 'England' },
  BT: { postTown: 'Belfast',             county: 'Belfast',                  region: 'Northern Ireland',         nation: 'Northern Ireland' },
  CA: { postTown: 'Carlisle',            county: 'Cumbria',                  region: 'North West',               nation: 'England' },
  CB: { postTown: 'Cambridge',           county: 'Cambridgeshire',           region: 'East of England',          nation: 'England' },
  CF: { postTown: 'Cardiff',             county: 'Cardiff',                  region: 'Wales',                    nation: 'Wales' },
  CH: { postTown: 'Chester',             county: 'Cheshire',                 region: 'North West',               nation: 'England' }, // NOTE: CH also covers Flintshire (Wales) on the Wirral border
  CM: { postTown: 'Chelmsford',          county: 'Essex',                    region: 'East of England',          nation: 'England' },
  CO: { postTown: 'Colchester',          county: 'Essex',                    region: 'East of England',          nation: 'England' },
  CR: { postTown: 'Croydon',             county: 'Greater London',           region: 'London',                   nation: 'England' },
  CT: { postTown: 'Canterbury',          county: 'Kent',                     region: 'South East',               nation: 'England' },
  CV: { postTown: 'Coventry',            county: 'West Midlands',            region: 'West Midlands',            nation: 'England' },
  CW: { postTown: 'Crewe',               county: 'Cheshire',                 region: 'North West',               nation: 'England' },
  DA: { postTown: 'Dartford',            county: 'Kent',                     region: 'South East',               nation: 'England' },
  DD: { postTown: 'Dundee',              county: 'Dundee City',              region: 'Scotland',                 nation: 'Scotland' },
  DE: { postTown: 'Derby',               county: 'Derbyshire',               region: 'East Midlands',            nation: 'England' },
  DG: { postTown: 'Dumfries',            county: 'Dumfries and Galloway',    region: 'Scotland',                 nation: 'Scotland' },
  DH: { postTown: 'Durham',              county: 'County Durham',            region: 'North East',               nation: 'England' },
  DL: { postTown: 'Darlington',          county: 'County Durham',            region: 'North East',               nation: 'England' },
  DN: { postTown: 'Doncaster',           county: 'South Yorkshire',          region: 'Yorkshire and the Humber', nation: 'England' },
  DT: { postTown: 'Dorchester',          county: 'Dorset',                   region: 'South West',               nation: 'England' },
  DY: { postTown: 'Dudley',              county: 'West Midlands',            region: 'West Midlands',            nation: 'England' },
  E:  { postTown: 'London',              county: 'Greater London',           region: 'London',                   nation: 'England' },
  EC: { postTown: 'London',              county: 'Greater London',           region: 'London',                   nation: 'England' },
  EH: { postTown: 'Edinburgh',           county: 'Edinburgh',                region: 'Scotland',                 nation: 'Scotland' },
  EN: { postTown: 'Enfield',             county: 'Greater London',           region: 'London',                   nation: 'England' }, // NOTE: EN also reaches into Hertfordshire
  EX: { postTown: 'Exeter',              county: 'Devon',                    region: 'South West',               nation: 'England' },
  FK: { postTown: 'Falkirk',             county: 'Falkirk',                  region: 'Scotland',                 nation: 'Scotland' },
  FY: { postTown: 'Blackpool',           county: 'Lancashire',               region: 'North West',               nation: 'England' },
  G:  { postTown: 'Glasgow',             county: 'Glasgow',                  region: 'Scotland',                 nation: 'Scotland' },
  GL: { postTown: 'Gloucester',          county: 'Gloucestershire',          region: 'South West',               nation: 'England' },
  GU: { postTown: 'Guildford',           county: 'Surrey',                   region: 'South East',               nation: 'England' },
  GY: { postTown: 'Guernsey',            county: 'Guernsey',                 region: 'Channel Islands',          nation: 'Channel Islands' },
  HA: { postTown: 'Harrow',              county: 'Greater London',           region: 'London',                   nation: 'England' },
  HD: { postTown: 'Huddersfield',        county: 'West Yorkshire',           region: 'Yorkshire and the Humber', nation: 'England' },
  HG: { postTown: 'Harrogate',           county: 'North Yorkshire',          region: 'Yorkshire and the Humber', nation: 'England' },
  HP: { postTown: 'Hemel Hempstead',     county: 'Hertfordshire',            region: 'East of England',          nation: 'England' }, // NOTE: HP straddles Bucks/Herts
  HR: { postTown: 'Hereford',            county: 'Herefordshire',            region: 'West Midlands',            nation: 'England' },
  HS: { postTown: 'Isle of Lewis',       county: 'Western Isles',            region: 'Scotland',                 nation: 'Scotland' },
  HU: { postTown: 'Hull',                county: 'East Riding of Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },
  HX: { postTown: 'Halifax',             county: 'West Yorkshire',           region: 'Yorkshire and the Humber', nation: 'England' },
  IG: { postTown: 'Ilford',              county: 'Greater London',           region: 'London',                   nation: 'England' },
  IM: { postTown: 'Isle of Man',         county: 'Isle of Man',              region: 'Isle of Man',              nation: 'Isle of Man' },
  IP: { postTown: 'Ipswich',             county: 'Suffolk',                  region: 'East of England',          nation: 'England' },
  IV: { postTown: 'Inverness',           county: 'Highland',                 region: 'Scotland',                 nation: 'Scotland' },
  JE: { postTown: 'Jersey',              county: 'Jersey',                   region: 'Channel Islands',          nation: 'Channel Islands' },
  KA: { postTown: 'Kilmarnock',          county: 'East Ayrshire',            region: 'Scotland',                 nation: 'Scotland' },
  KT: { postTown: 'Kingston upon Thames', county: 'Surrey',                  region: 'South East',               nation: 'England' }, // NOTE: KT mixes Surrey + Greater London
  KW: { postTown: 'Kirkwall',            county: 'Orkney',                   region: 'Scotland',                 nation: 'Scotland' }, // NOTE: KW also covers north Highland mainland
  KY: { postTown: 'Kirkcaldy',           county: 'Fife',                     region: 'Scotland',                 nation: 'Scotland' },
  L:  { postTown: 'Liverpool',           county: 'Merseyside',               region: 'North West',               nation: 'England' },
  LA: { postTown: 'Lancaster',           county: 'Lancashire',               region: 'North West',               nation: 'England' }, // NOTE: LA includes south Cumbria
  LD: { postTown: 'Llandrindod Wells',   county: 'Powys',                    region: 'Wales',                    nation: 'Wales' },
  LE: { postTown: 'Leicester',           county: 'Leicestershire',           region: 'East Midlands',            nation: 'England' },
  LL: { postTown: 'Llandudno',           county: 'Conwy',                    region: 'Wales',                    nation: 'Wales' }, // NOTE: LL spans much of North Wales
  LN: { postTown: 'Lincoln',             county: 'Lincolnshire',             region: 'East Midlands',            nation: 'England' },
  LS: { postTown: 'Leeds',               county: 'West Yorkshire',           region: 'Yorkshire and the Humber', nation: 'England' },
  LU: { postTown: 'Luton',               county: 'Bedfordshire',             region: 'East of England',          nation: 'England' },
  M:  { postTown: 'Manchester',          county: 'Greater Manchester',       region: 'North West',               nation: 'England' },
  ME: { postTown: 'Medway',              county: 'Kent',                     region: 'South East',               nation: 'England' },
  MK: { postTown: 'Milton Keynes',       county: 'Buckinghamshire',          region: 'South East',               nation: 'England' },
  ML: { postTown: 'Motherwell',          county: 'North Lanarkshire',        region: 'Scotland',                 nation: 'Scotland' },
  N:  { postTown: 'London',              county: 'Greater London',           region: 'London',                   nation: 'England' },
  NE: { postTown: 'Newcastle upon Tyne', county: 'Tyne and Wear',            region: 'North East',               nation: 'England' },
  NG: { postTown: 'Nottingham',          county: 'Nottinghamshire',          region: 'East Midlands',            nation: 'England' },
  NN: { postTown: 'Northampton',         county: 'Northamptonshire',         region: 'East Midlands',            nation: 'England' },
  NP: { postTown: 'Newport',             county: 'Newport',                  region: 'Wales',                    nation: 'Wales' },
  NR: { postTown: 'Norwich',             county: 'Norfolk',                  region: 'East of England',          nation: 'England' },
  NW: { postTown: 'London',              county: 'Greater London',           region: 'London',                   nation: 'England' },
  OL: { postTown: 'Oldham',              county: 'Greater Manchester',       region: 'North West',               nation: 'England' },
  OX: { postTown: 'Oxford',              county: 'Oxfordshire',              region: 'South East',               nation: 'England' },
  PA: { postTown: 'Paisley',             county: 'Renfrewshire',             region: 'Scotland',                 nation: 'Scotland' },
  PE: { postTown: 'Peterborough',        county: 'Cambridgeshire',           region: 'East of England',          nation: 'England' }, // NOTE: PE is large, spans Cambs/Lincs/Norfolk
  PH: { postTown: 'Perth',               county: 'Perth and Kinross',        region: 'Scotland',                 nation: 'Scotland' },
  PL: { postTown: 'Plymouth',            county: 'Devon',                    region: 'South West',               nation: 'England' }, // NOTE: PL includes south-east Cornwall
  PO: { postTown: 'Portsmouth',          county: 'Hampshire',                region: 'South East',               nation: 'England' }, // NOTE: PO includes Isle of Wight
  PR: { postTown: 'Preston',             county: 'Lancashire',               region: 'North West',               nation: 'England' },
  RG: { postTown: 'Reading',             county: 'Berkshire',                region: 'South East',               nation: 'England' },
  RH: { postTown: 'Redhill',             county: 'Surrey',                   region: 'South East',               nation: 'England' }, // NOTE: RH spans Surrey/West Sussex
  RM: { postTown: 'Romford',             county: 'Greater London',           region: 'London',                   nation: 'England' },
  S:  { postTown: 'Sheffield',           county: 'South Yorkshire',          region: 'Yorkshire and the Humber', nation: 'England' },
  SA: { postTown: 'Swansea',             county: 'Swansea',                  region: 'Wales',                    nation: 'Wales' }, // NOTE: SA spans much of South West Wales
  SE: { postTown: 'London',              county: 'Greater London',           region: 'London',                   nation: 'England' },
  SG: { postTown: 'Stevenage',           county: 'Hertfordshire',            region: 'East of England',          nation: 'England' },
  SK: { postTown: 'Stockport',           county: 'Greater Manchester',       region: 'North West',               nation: 'England' }, // NOTE: SK spans Greater Manchester/Cheshire/Derbyshire
  SL: { postTown: 'Slough',              county: 'Berkshire',                region: 'South East',               nation: 'England' },
  SM: { postTown: 'Sutton',              county: 'Greater London',           region: 'London',                   nation: 'England' },
  SN: { postTown: 'Swindon',             county: 'Wiltshire',                region: 'South West',               nation: 'England' },
  SO: { postTown: 'Southampton',         county: 'Hampshire',                region: 'South East',               nation: 'England' },
  SP: { postTown: 'Salisbury',           county: 'Wiltshire',                region: 'South West',               nation: 'England' },
  SR: { postTown: 'Sunderland',          county: 'Tyne and Wear',            region: 'North East',               nation: 'England' },
  SS: { postTown: 'Southend-on-Sea',     county: 'Essex',                    region: 'East of England',          nation: 'England' },
  ST: { postTown: 'Stoke-on-Trent',      county: 'Staffordshire',            region: 'West Midlands',            nation: 'England' },
  SW: { postTown: 'London',              county: 'Greater London',           region: 'London',                   nation: 'England' },
  SY: { postTown: 'Shrewsbury',          county: 'Shropshire',               region: 'West Midlands',            nation: 'England' }, // NOTE: SY reaches into mid-Wales (Powys)
  TA: { postTown: 'Taunton',             county: 'Somerset',                 region: 'South West',               nation: 'England' },
  TD: { postTown: 'Galashiels',          county: 'Scottish Borders',         region: 'Scotland',                 nation: 'Scotland' },
  TF: { postTown: 'Telford',             county: 'Shropshire',               region: 'West Midlands',            nation: 'England' },
  TN: { postTown: 'Tonbridge',           county: 'Kent',                     region: 'South East',               nation: 'England' }, // NOTE: TN spans Kent/East Sussex
  TQ: { postTown: 'Torquay',             county: 'Devon',                    region: 'South West',               nation: 'England' },
  TR: { postTown: 'Truro',               county: 'Cornwall',                 region: 'South West',               nation: 'England' },
  TS: { postTown: 'Middlesbrough',       county: 'North Yorkshire',          region: 'North East',               nation: 'England' }, // NOTE: historic Cleveland; ONS puts Teesside in North East
  TW: { postTown: 'Twickenham',          county: 'Greater London',           region: 'London',                   nation: 'England' },
  UB: { postTown: 'Southall',            county: 'Greater London',           region: 'London',                   nation: 'England' },
  W:  { postTown: 'London',              county: 'Greater London',           region: 'London',                   nation: 'England' },
  WA: { postTown: 'Warrington',          county: 'Cheshire',                 region: 'North West',               nation: 'England' },
  WC: { postTown: 'London',              county: 'Greater London',           region: 'London',                   nation: 'England' },
  WD: { postTown: 'Watford',             county: 'Hertfordshire',            region: 'East of England',          nation: 'England' },
  WF: { postTown: 'Wakefield',           county: 'West Yorkshire',           region: 'Yorkshire and the Humber', nation: 'England' },
  WN: { postTown: 'Wigan',               county: 'Greater Manchester',       region: 'North West',               nation: 'England' },
  WR: { postTown: 'Worcester',           county: 'Worcestershire',           region: 'West Midlands',            nation: 'England' },
  WS: { postTown: 'Walsall',             county: 'West Midlands',            region: 'West Midlands',            nation: 'England' },
  WV: { postTown: 'Wolverhampton',       county: 'West Midlands',            region: 'West Midlands',            nation: 'England' },
  YO: { postTown: 'York',                county: 'North Yorkshire',          region: 'Yorkshire and the Humber', nation: 'England' },
  ZE: { postTown: 'Lerwick',             county: 'Shetland',                 region: 'Scotland',                 nation: 'Scotland' },
};

// ---------------------------------------------------------------------------
// PLACES — curated city/town name -> { county, region, nation } fallback.
// Used when no postcode is present. Keyed lowercase. This list covers the
// high-frequency named places that actually appear in our data (the long
// tail of villages falls through to postcode or gets flagged).
//
// Keep this list conservative: only places whose county is unambiguous.
// ---------------------------------------------------------------------------
const PLACES = {
  // Greater London (the city itself + common boroughs that show up as "city")
  'london': { county: 'Greater London', region: 'London', nation: 'England' },
  'city of london': { county: 'Greater London', region: 'London', nation: 'England' },
  'westminster': { county: 'Greater London', region: 'London', nation: 'England' },
  'croydon': { county: 'Greater London', region: 'London', nation: 'England' },
  'ealing': { county: 'Greater London', region: 'London', nation: 'England' },
  'islington': { county: 'Greater London', region: 'London', nation: 'England' },
  'hackney': { county: 'Greater London', region: 'London', nation: 'England' },
  'camden': { county: 'Greater London', region: 'London', nation: 'England' },
  'wimbledon': { county: 'Greater London', region: 'London', nation: 'England' },
  'wembley': { county: 'Greater London', region: 'London', nation: 'England' },

  // South East
  'guildford': { county: 'Surrey', region: 'South East', nation: 'England' },
  'woking': { county: 'Surrey', region: 'South East', nation: 'England' },
  'reigate': { county: 'Surrey', region: 'South East', nation: 'England' },
  'oxford': { county: 'Oxfordshire', region: 'South East', nation: 'England' },
  'reading': { county: 'Berkshire', region: 'South East', nation: 'England' },
  'slough': { county: 'Berkshire', region: 'South East', nation: 'England' },
  'bracknell': { county: 'Berkshire', region: 'South East', nation: 'England' },
  'maidenhead': { county: 'Berkshire', region: 'South East', nation: 'England' },
  'windsor': { county: 'Berkshire', region: 'South East', nation: 'England' },
  'milton keynes': { county: 'Buckinghamshire', region: 'South East', nation: 'England' },
  'high wycombe': { county: 'Buckinghamshire', region: 'South East', nation: 'England' },
  'aylesbury': { county: 'Buckinghamshire', region: 'South East', nation: 'England' },
  'brighton': { county: 'East Sussex', region: 'South East', nation: 'England' },
  'hove': { county: 'East Sussex', region: 'South East', nation: 'England' },
  'eastbourne': { county: 'East Sussex', region: 'South East', nation: 'England' },
  'hastings': { county: 'East Sussex', region: 'South East', nation: 'England' },
  'crawley': { county: 'West Sussex', region: 'South East', nation: 'England' },
  'chichester': { county: 'West Sussex', region: 'South East', nation: 'England' },
  'worthing': { county: 'West Sussex', region: 'South East', nation: 'England' },
  'horsham': { county: 'West Sussex', region: 'South East', nation: 'England' },
  'southampton': { county: 'Hampshire', region: 'South East', nation: 'England' },
  'portsmouth': { county: 'Hampshire', region: 'South East', nation: 'England' },
  'basingstoke': { county: 'Hampshire', region: 'South East', nation: 'England' },
  'winchester': { county: 'Hampshire', region: 'South East', nation: 'England' },
  'farnborough': { county: 'Hampshire', region: 'South East', nation: 'England' },
  'canterbury': { county: 'Kent', region: 'South East', nation: 'England' },
  'maidstone': { county: 'Kent', region: 'South East', nation: 'England' },
  'medway': { county: 'Kent', region: 'South East', nation: 'England' },
  'tunbridge wells': { county: 'Kent', region: 'South East', nation: 'England' },
  'dartford': { county: 'Kent', region: 'South East', nation: 'England' },
  'ashford': { county: 'Kent', region: 'South East', nation: 'England' },

  // South West
  'bristol': { county: 'Bristol', region: 'South West', nation: 'England' },
  'bath': { county: 'Somerset', region: 'South West', nation: 'England' },
  'taunton': { county: 'Somerset', region: 'South West', nation: 'England' },
  'exeter': { county: 'Devon', region: 'South West', nation: 'England' },
  'plymouth': { county: 'Devon', region: 'South West', nation: 'England' },
  'torquay': { county: 'Devon', region: 'South West', nation: 'England' },
  'truro': { county: 'Cornwall', region: 'South West', nation: 'England' },
  'gloucester': { county: 'Gloucestershire', region: 'South West', nation: 'England' },
  'cheltenham': { county: 'Gloucestershire', region: 'South West', nation: 'England' },
  'swindon': { county: 'Wiltshire', region: 'South West', nation: 'England' },
  'salisbury': { county: 'Wiltshire', region: 'South West', nation: 'England' },
  'bournemouth': { county: 'Dorset', region: 'South West', nation: 'England' },
  'poole': { county: 'Dorset', region: 'South West', nation: 'England' },
  'dorchester': { county: 'Dorset', region: 'South West', nation: 'England' },

  // East of England
  'cambridge': { county: 'Cambridgeshire', region: 'East of England', nation: 'England' },
  'peterborough': { county: 'Cambridgeshire', region: 'East of England', nation: 'England' },
  'norwich': { county: 'Norfolk', region: 'East of England', nation: 'England' },
  'ipswich': { county: 'Suffolk', region: 'East of England', nation: 'England' },
  'colchester': { county: 'Essex', region: 'East of England', nation: 'England' },
  'chelmsford': { county: 'Essex', region: 'East of England', nation: 'England' },
  'southend-on-sea': { county: 'Essex', region: 'East of England', nation: 'England' },
  'southend': { county: 'Essex', region: 'East of England', nation: 'England' },
  'basildon': { county: 'Essex', region: 'East of England', nation: 'England' },
  'watford': { county: 'Hertfordshire', region: 'East of England', nation: 'England' },
  'st albans': { county: 'Hertfordshire', region: 'East of England', nation: 'England' },
  'stevenage': { county: 'Hertfordshire', region: 'East of England', nation: 'England' },
  'hemel hempstead': { county: 'Hertfordshire', region: 'East of England', nation: 'England' },
  'luton': { county: 'Bedfordshire', region: 'East of England', nation: 'England' },
  'bedford': { county: 'Bedfordshire', region: 'East of England', nation: 'England' },

  // East Midlands
  'leicester': { county: 'Leicestershire', region: 'East Midlands', nation: 'England' },
  'nottingham': { county: 'Nottinghamshire', region: 'East Midlands', nation: 'England' },
  'derby': { county: 'Derbyshire', region: 'East Midlands', nation: 'England' },
  'lincoln': { county: 'Lincolnshire', region: 'East Midlands', nation: 'England' },
  'northampton': { county: 'Northamptonshire', region: 'East Midlands', nation: 'England' },
  'kettering': { county: 'Northamptonshire', region: 'East Midlands', nation: 'England' },

  // West Midlands
  'birmingham': { county: 'West Midlands', region: 'West Midlands', nation: 'England' },
  'coventry': { county: 'West Midlands', region: 'West Midlands', nation: 'England' },
  'wolverhampton': { county: 'West Midlands', region: 'West Midlands', nation: 'England' },
  'solihull': { county: 'West Midlands', region: 'West Midlands', nation: 'England' },
  'walsall': { county: 'West Midlands', region: 'West Midlands', nation: 'England' },
  'dudley': { county: 'West Midlands', region: 'West Midlands', nation: 'England' },
  'stoke-on-trent': { county: 'Staffordshire', region: 'West Midlands', nation: 'England' },
  'stoke': { county: 'Staffordshire', region: 'West Midlands', nation: 'England' },
  'stafford': { county: 'Staffordshire', region: 'West Midlands', nation: 'England' },
  'worcester': { county: 'Worcestershire', region: 'West Midlands', nation: 'England' },
  'hereford': { county: 'Herefordshire', region: 'West Midlands', nation: 'England' },
  'shrewsbury': { county: 'Shropshire', region: 'West Midlands', nation: 'England' },
  'telford': { county: 'Shropshire', region: 'West Midlands', nation: 'England' },
  'warwick': { county: 'Warwickshire', region: 'West Midlands', nation: 'England' },
  'coventry ': { county: 'West Midlands', region: 'West Midlands', nation: 'England' },

  // Yorkshire and the Humber
  'leeds': { county: 'West Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },
  'bradford': { county: 'West Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },
  'wakefield': { county: 'West Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },
  'huddersfield': { county: 'West Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },
  'halifax': { county: 'West Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },
  'sheffield': { county: 'South Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },
  'doncaster': { county: 'South Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },
  'rotherham': { county: 'South Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },
  'barnsley': { county: 'South Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },
  'york': { county: 'North Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },
  'harrogate': { county: 'North Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },
  'hull': { county: 'East Riding of Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },
  'kingston upon hull': { county: 'East Riding of Yorkshire', region: 'Yorkshire and the Humber', nation: 'England' },

  // North West
  'manchester': { county: 'Greater Manchester', region: 'North West', nation: 'England' },
  'bolton': { county: 'Greater Manchester', region: 'North West', nation: 'England' },
  'stockport': { county: 'Greater Manchester', region: 'North West', nation: 'England' },
  'oldham': { county: 'Greater Manchester', region: 'North West', nation: 'England' },
  'wigan': { county: 'Greater Manchester', region: 'North West', nation: 'England' },
  'rochdale': { county: 'Greater Manchester', region: 'North West', nation: 'England' },
  'salford': { county: 'Greater Manchester', region: 'North West', nation: 'England' },
  'liverpool': { county: 'Merseyside', region: 'North West', nation: 'England' },
  'birkenhead': { county: 'Merseyside', region: 'North West', nation: 'England' },
  'st helens': { county: 'Merseyside', region: 'North West', nation: 'England' },
  'southport': { county: 'Merseyside', region: 'North West', nation: 'England' },
  'preston': { county: 'Lancashire', region: 'North West', nation: 'England' },
  'blackpool': { county: 'Lancashire', region: 'North West', nation: 'England' },
  'blackburn': { county: 'Lancashire', region: 'North West', nation: 'England' },
  'lancaster': { county: 'Lancashire', region: 'North West', nation: 'England' },
  'burnley': { county: 'Lancashire', region: 'North West', nation: 'England' },
  'chester': { county: 'Cheshire', region: 'North West', nation: 'England' },
  'warrington': { county: 'Cheshire', region: 'North West', nation: 'England' },
  'crewe': { county: 'Cheshire', region: 'North West', nation: 'England' },
  'carlisle': { county: 'Cumbria', region: 'North West', nation: 'England' },

  // North East
  'newcastle': { county: 'Tyne and Wear', region: 'North East', nation: 'England' },
  'newcastle upon tyne': { county: 'Tyne and Wear', region: 'North East', nation: 'England' },
  'sunderland': { county: 'Tyne and Wear', region: 'North East', nation: 'England' },
  'gateshead': { county: 'Tyne and Wear', region: 'North East', nation: 'England' },
  'durham': { county: 'County Durham', region: 'North East', nation: 'England' },
  'darlington': { county: 'County Durham', region: 'North East', nation: 'England' },
  'middlesbrough': { county: 'North Yorkshire', region: 'North East', nation: 'England' },

  // Scotland
  'edinburgh': { county: 'Edinburgh', region: 'Scotland', nation: 'Scotland' },
  'glasgow': { county: 'Glasgow', region: 'Scotland', nation: 'Scotland' },
  'aberdeen': { county: 'Aberdeen City', region: 'Scotland', nation: 'Scotland' },
  'dundee': { county: 'Dundee City', region: 'Scotland', nation: 'Scotland' },
  'inverness': { county: 'Highland', region: 'Scotland', nation: 'Scotland' },
  'perth': { county: 'Perth and Kinross', region: 'Scotland', nation: 'Scotland' },
  'stirling': { county: 'Stirling', region: 'Scotland', nation: 'Scotland' },
  'paisley': { county: 'Renfrewshire', region: 'Scotland', nation: 'Scotland' },
  'falkirk': { county: 'Falkirk', region: 'Scotland', nation: 'Scotland' },
  'dunfermline': { county: 'Fife', region: 'Scotland', nation: 'Scotland' },
  'kilmarnock': { county: 'East Ayrshire', region: 'Scotland', nation: 'Scotland' },
  'dumfries': { county: 'Dumfries and Galloway', region: 'Scotland', nation: 'Scotland' },

  // Wales
  'cardiff': { county: 'Cardiff', region: 'Wales', nation: 'Wales' },
  'swansea': { county: 'Swansea', region: 'Wales', nation: 'Wales' },
  'newport': { county: 'Newport', region: 'Wales', nation: 'Wales' },
  'wrexham': { county: 'Wrexham', region: 'Wales', nation: 'Wales' },
  'bangor': { county: 'Gwynedd', region: 'Wales', nation: 'Wales' },
  'llandudno': { county: 'Conwy', region: 'Wales', nation: 'Wales' },
  'merthyr tydfil': { county: 'Merthyr Tydfil', region: 'Wales', nation: 'Wales' },
  'bridgend': { county: 'Bridgend', region: 'Wales', nation: 'Wales' },

  // Northern Ireland
  'belfast': { county: 'Belfast', region: 'Northern Ireland', nation: 'Northern Ireland' },
  'londonderry': { county: 'Derry City and Strabane', region: 'Northern Ireland', nation: 'Northern Ireland' },
  'derry': { county: 'Derry City and Strabane', region: 'Northern Ireland', nation: 'Northern Ireland' },
  'lisburn': { county: 'Lisburn and Castlereagh', region: 'Northern Ireland', nation: 'Northern Ireland' },
  'newry': { county: 'Newry Mourne and Down', region: 'Northern Ireland', nation: 'Northern Ireland' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise a raw country string to a canonical country name, or null. */
function normalizeCountry(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/\.$/, '');
  return COUNTRY_ALIASES[key] || null;
}

/** If a raw string names a UK home nation, return it (England/Scotland/...). */
function homeNationOf(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/\.$/, '');
  return UK_HOME_NATIONS[key] || null;
}

/**
 * Extract the UK postcode AREA (1–2 leading letters) from a postcode or any
 * string containing one (full or partial outward code). Returns e.g. "GU",
 * "EC", "B" — uppercased — or null.
 *
 * Scans ALL outward-code-shaped tokens and returns the area of the LAST one
 * that is a real postcode area. This is deliberate: UK addresses put the
 * postcode last, while A-road references ("A40", "A841") and similar tokens
 * appear earlier and would otherwise be mistaken for a postcode. A-roads also
 * never resolve to a valid area (no "A" postcode area exists), so requiring a
 * KNOWN area filters them out anyway.
 */
function extractPostcodeArea(str) {
  if (!str) return null;
  const s = String(str).toUpperCase();
  // 1–2 letters, a digit, optional 3rd char, on word boundaries.
  const re = /\b([A-Z]{1,2})[0-9][A-Z0-9]?\b/g;
  let lastValid = null;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (POSTCODE_AREAS[m[1]]) lastValid = m[1];
  }
  return lastValid;
}

/** Look up a postcode area code -> location object, or null. */
function lookupPostcodeArea(area) {
  if (!area) return null;
  return POSTCODE_AREAS[String(area).toUpperCase()] || null;
}

/** Look up a place name -> { county, region, nation }, or null. */
function lookupPlace(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return PLACES[key] || null;
}

/** county name -> region, or null. */
function regionForCounty(county) {
  if (!county) return null;
  return COUNTY_TO_REGION[String(county).trim().toLowerCase()] || null;
}

module.exports = {
  COUNTRY_ALIASES,
  UK_HOME_NATIONS,
  REGION_COUNTIES,
  COUNTY_TO_REGION,
  POSTCODE_AREAS,
  PLACES,
  normalizeCountry,
  homeNationOf,
  extractPostcodeArea,
  lookupPostcodeArea,
  lookupPlace,
  regionForCounty,
};
