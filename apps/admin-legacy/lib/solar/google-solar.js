// Google Solar API — buildingInsights:findClosest with Detected Arrays.
// One call returns BOTH the roof/PPA potential AND whether panels already exist,
// so the cascade's stage 2 (roof) and stage 3 (already-solar) share it.
//
// Docs: https://developers.google.com/maps/documentation/solar/building-insights

const usage = require('./usage');
// Key comes from the settings page (volume) first, then env — so it's rotatable.
const GOOGLE_KEY = () => usage.getGoogleKey();

function fmtDate(d) {
  if (!d || d.year == null) return null;
  return `${d.year}-${String(d.month || 1).padStart(2, '0')}-${String(d.day || 1).padStart(2, '0')}`;
}

async function buildingInsights(lat, lng) {
  const key = GOOGLE_KEY();
  if (!key) throw new Error('No Google Solar API key (GOOGLE_SOLAR_API_KEY / GOOGLE_API_KEY)');

  const url = 'https://solar.googleapis.com/v1/buildingInsights:findClosest'
    + `?location.latitude=${lat}&location.longitude=${lng}`
    + `&requiredQuality=HIGH&additionalInsights=DETECTED_ARRAYS&key=${key}`;

  usage.record('buildingInsights');
  const res = await fetch(url);
  const data = await res.json();

  if (res.status === 404 || (data.error && data.error.status === 'NOT_FOUND')) {
    return { notFound: true };
  }
  if (data.error) {
    const e = new Error(data.error.message || 'Solar API error');
    e.apiStatus = data.error.status;
    throw e;
  }

  const sp = data.solarPotential || {};
  const da = data.detectedArrays;
  let hasSolar = 'unclear';
  if (da && da.detectionStatus === 'DETECTION_STATUS_ARRAYS_DETECTED') hasSolar = 'yes';
  else if (da && da.detectionStatus === 'DETECTION_STATUS_NO_ARRAYS_DETECTED') hasSolar = 'no';

  return {
    notFound: false,
    roofAreaM2: sp.wholeRoofStats && sp.wholeRoofStats.areaMeters2 != null ? Math.round(sp.wholeRoofStats.areaMeters2) : null,
    maxPanels: sp.maxArrayPanelsCount ?? null,
    panelWatts: sp.panelCapacityWatts ?? null,
    maxSunshineHoursPerYear: sp.maxSunshineHoursPerYear ?? null,
    hasSolar,
    imageryDate: (da && da.latestCaptureDate ? fmtDate(da.latestCaptureDate) : null) || fmtDate(data.imageryDate),
    raw: data,
  };
}

// On-demand roof image: dataLayers RGB GeoTIFF -> PNG (needs sharp).
async function roofImagePng(lat, lng) {
  const key = GOOGLE_KEY();
  if (!key) return { error: 'no_key' };
  const url = 'https://solar.googleapis.com/v1/dataLayers:get'
    + `?location.latitude=${lat}&location.longitude=${lng}`
    + `&radiusMeters=40&view=IMAGERY_LAYERS&requiredQuality=HIGH&pixelSizeMeters=0.1&key=${key}`;
  usage.record('dataLayers');
  const res = await fetch(url);
  const data = await res.json();
  if (res.status === 404 || (data.error && data.error.status === 'NOT_FOUND')) return { error: 'no_imagery' };
  if (data.error || !data.rgbUrl) return { error: (data.error && data.error.message) || 'no_rgb' };

  const tiffRes = await fetch(`${data.rgbUrl}&key=${key}`);
  if (!tiffRes.ok) return { error: `download_${tiffRes.status}` };
  const tiff = Buffer.from(await tiffRes.arrayBuffer());

  let sharp;
  try { sharp = require('sharp'); } catch { return { error: 'sharp_not_installed' }; }
  const png = await sharp(tiff).png().resize(768, 768, { fit: 'cover' }).toBuffer();
  return { base64: png.toString('base64') };
}

module.exports = { buildingInsights, roofImagePng };
