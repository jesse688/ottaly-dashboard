// Address/postcode -> { lat, lng }. Free postcodes.io for UK postcodes,
// Google Geocoding fallback. Uses admin-legacy's existing GOOGLE_API_KEY.

const usage = require('./usage');
const GOOGLE_KEY = () => usage.getGoogleKey();
const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

function extractPostcode(text) {
  const m = String(text || '').toUpperCase().match(UK_POSTCODE_RE);
  return m ? `${m[1]} ${m[2]}` : null;
}

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

async function geocode(address) {
  const pc = extractPostcode(address);
  if (pc) { const hit = await geocodePostcodeIO(pc); if (hit) return hit; }
  return geocodeGoogle(address);
}

module.exports = { geocode, extractPostcode };
