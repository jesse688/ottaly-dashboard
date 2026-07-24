// Address/postcode -> { lat, lng }. Free postcodes.io for UK postcodes,
// Google Geocoding fallback. Uses admin-legacy's existing GOOGLE_API_KEY.

const usage = require('./usage');
const { extractPostcode } = require('./address-match'); // shared, looser regex
const GOOGLE_KEY = () => usage.getGoogleKey();

async function geocodePostcodeIO(postcode) {
  try {
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.result) {
      return { lat: data.result.latitude, lng: data.result.longitude, source: 'postcodes.io' };
    }
  } catch { /* fall through */ }
  return null;
}

async function geocodeGoogle(address) {
  const key = GOOGLE_KEY();
  if (!key) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=uk&key=${key}`;
  usage.record('geocoding');
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'OK' && data.results.length) {
    const loc = data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng, source: 'google' };
  }
  return null;
}

// Google PLACES Text Search — resolves NAMED buildings ("Hercules House, Merlin
// Quay…") that the Geocoding API can't (it falls back to the postcode centroid,
// ~166m off on dense estates). Places knows these as places. Needs the Places API
// enabled on the key. This is what lands the roof on the actual building.
async function geocodePlaces(query) {
  const key = GOOGLE_KEY();
  if (!key) return null;
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&region=uk&key=${key}`;
  usage.record('geocoding');
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'OK' && data.results && data.results.length) {
      const loc = data.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng, source: 'places', place_name: data.results[0].name || null };
    }
  } catch { /* fall through */ }
  return null;
}

async function geocode(address) {
  const pc = extractPostcode(address);
  if (pc) { const hit = await geocodePostcodeIO(pc); if (hit) return { ...hit, postcode: pc }; }
  const g = await geocodeGoogle(address);
  if (!g) return null;
  // Recover a postcode from the coordinates when the text had none — this lets
  // ownership lookup work even for Apollo rows that only had "City, Country".
  const recovered = await reversePostcode(g.lat, g.lng);
  return { ...g, postcode: recovered || pc || null };
}

// PRECISE geocode — for a full building/unit address (e.g. a Land Registry CCOD
// property address). Skips the postcodes.io postcode-CENTROID shortcut (which lands
// mid-street and grabs the wrong roof on dense estates) and goes straight to
// Google's building-level geocoder. Falls back to the postcode centroid only if
// Google can't resolve it.
async function geocodePrecise(address) {
  const pc = extractPostcode(address);
  // 1) Places Text Search — resolves named buildings the Geocoding API can't.
  const places = await geocodePlaces(address);
  if (places) return { ...places, postcode: pc || await reversePostcode(places.lat, places.lng), precise: true };
  // 2) Geocoding API on the full address (building-level when it works).
  const g = await geocodeGoogle(address);
  if (g) return { ...g, postcode: pc || await reversePostcode(g.lat, g.lng), precise: true };
  // 3) Postcode centroid (coarse, ~mid-street — flagged precise:false).
  if (pc) { const hit = await geocodePostcodeIO(pc); if (hit) return { ...hit, postcode: pc, precise: false }; }
  return null;
}

// lat/lng -> nearest postcode via free postcodes.io reverse lookup.
async function reversePostcode(lat, lng) {
  try {
    const res = await fetch(`https://api.postcodes.io/postcodes?lon=${lng}&lat=${lat}&limit=1`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.result && data.result[0] && data.result[0].postcode) || null;
  } catch { return null; }
}

module.exports = {
  geocode, geocodePrecise, extractPostcode, reversePostcode,
  geocodeGoogleRaw: geocodeGoogle, geocodePlacesRaw: geocodePlaces,
};
