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

// ── Full imagery set ───────────────────────────────────────────────────────
// dataLayers returns several GeoTIFF rasters for the same patch of roof:
//   rgb        — the aerial photo
//   annualFlux — sunlight received per m² per year, the yellow/purple heatmap
//   mask       — which pixels are roof at all
// Google does NOT return a rendered "panels on your roof" picture. What it
// gives is solarPanels[] in buildingInsights — each panel's centre lat/lng —
// which the client draws itself. That is what drawPanelOverlay does below.
//
// One dataLayers call is billed per lookup, so all layers are pulled from the
// single response rather than one call per layer.
async function roofImagery(lat, lng, opts = {}) {
  const key = GOOGLE_KEY();
  if (!key) return { error: 'no_key' };
  const radius = Number(opts.radiusMeters) || 40;

  const url = 'https://solar.googleapis.com/v1/dataLayers:get'
    + `?location.latitude=${lat}&location.longitude=${lng}`
    + `&radiusMeters=${radius}&view=FULL_LAYERS&requiredQuality=HIGH`
    + `&pixelSizeMeters=0.1&key=${key}`;
  usage.record('dataLayers');
  const res = await fetch(url);
  const data = await res.json();
  if (res.status === 404 || (data.error && data.error.status === 'NOT_FOUND')) return { error: 'no_imagery' };
  if (data.error) return { error: data.error.message || 'dataLayers_error' };

  let sharp;
  try { sharp = require('sharp'); } catch { return { error: 'sharp_not_installed' }; }

  const SIZE = 768;
  const fetchTiff = async (u) => {
    if (!u) return null;
    const r = await fetch(`${u}&key=${key}`);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  };

  const out = { layers: {}, bounds: data.boundingBox || null, imageryDate: fmtDate(data.imageryDate) };

  // RGB — straight through.
  const rgbTiff = await fetchTiff(data.rgbUrl);
  let rgbPng = null;
  if (rgbTiff) {
    rgbPng = await sharp(rgbTiff).png().resize(SIZE, SIZE, { fit: 'cover' }).toBuffer();
    out.layers.rgb = `data:image/png;base64,${rgbPng.toString('base64')}`;
  }

  // Annual flux — a single-band float raster (kWh/m²/yr), not a picture. It has
  // to be normalised to 0-255 and given a colour ramp, or it renders as an
  // almost-black square. `normalise` stretches whatever range this roof has to
  // full scale; the tint approximates Google's own purple→yellow ramp.
  const fluxTiff = await fetchTiff(data.annualFluxUrl);
  if (fluxTiff) {
    try {
      const grey = await sharp(fluxTiff).normalise().resize(SIZE, SIZE, { fit: 'cover' }).toColourspace('b-w').raw().toBuffer();
      const rgbBuf = Buffer.alloc(grey.length * 3);
      for (let i = 0; i < grey.length; i++) {
        const v = grey[i] / 255;
        // purple (low) → orange → yellow (high)
        rgbBuf[i * 3]     = Math.round(255 * Math.min(1, 0.3 + v * 1.4));
        rgbBuf[i * 3 + 1] = Math.round(255 * Math.max(0, v * 1.25 - 0.15));
        rgbBuf[i * 3 + 2] = Math.round(255 * Math.max(0, 0.55 - v * 0.75));
      }
      const fluxPng = await sharp(rgbBuf, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer();
      out.layers.flux = `data:image/png;base64,${fluxPng.toString('base64')}`;

      // Flux blended over the photo — the view that actually reads as "this
      // roof, and where the sun lands on it".
      if (rgbPng) {
        const blended = await sharp(rgbPng)
          .composite([{ input: fluxPng, blend: 'overlay', opacity: 0.65 }])
          .png().toBuffer();
        out.layers.flux_over_rgb = `data:image/png;base64,${blended.toString('base64')}`;
      }
    } catch (e) {
      out.fluxError = e.message;
    }
  }

  return out;
}

// Panel rectangles as an SVG overlay, positioned against the dataLayers
// bounding box. Google gives each panel a centre point and an orientation but
// no pixel geometry, so the client projects them. Equirectangular projection is
// fine at this scale — the box is ~80m across, where the error is sub-pixel.
function panelOverlaySvg(panels, bounds, size = 768, opts = {}) {
  if (!panels || !panels.length || !bounds || !bounds.sw || !bounds.ne) return null;
  const { sw, ne } = bounds;
  const latSpan = ne.latitude - sw.latitude;
  const lngSpan = ne.longitude - sw.longitude;
  if (!latSpan || !lngSpan) return null;

  // Panel footprint in metres → pixels. Defaults match Google's typical module.
  const panelW = Number(opts.panelWidthM) || 1.045;
  const panelH = Number(opts.panelHeightM) || 1.879;
  const metresPerDegLat = 111320;
  const pxPerMetreY = (size / latSpan) / metresPerDegLat;
  const metresPerDegLng = 111320 * Math.cos(((sw.latitude + ne.latitude) / 2) * Math.PI / 180);
  const pxPerMetreX = (size / lngSpan) / metresPerDegLng;

  const rects = [];
  for (const p of panels) {
    const c = p.center || p.centre;
    if (!c || c.latitude == null || c.longitude == null) continue;
    const x = ((c.longitude - sw.longitude) / lngSpan) * size;
    // SVG y grows downward, latitude grows upward.
    const y = size - ((c.latitude - sw.latitude) / latSpan) * size;
    if (x < -50 || x > size + 50 || y < -50 || y > size + 50) continue;
    // PORTRAIT panels stand tall relative to their azimuth; LANDSCAPE lie flat.
    const landscape = p.orientation === 'LANDSCAPE';
    const w = (landscape ? panelH : panelW) * pxPerMetreX;
    const h = (landscape ? panelW : panelH) * pxPerMetreY;
    rects.push(
      `<rect x="${(x - w / 2).toFixed(1)}" y="${(y - h / 2).toFixed(1)}" ` +
      `width="${w.toFixed(1)}" height="${h.toFixed(1)}" ` +
      `fill="#1e3a8a" fill-opacity="0.55" stroke="#60a5fa" stroke-width="0.6"/>`
    );
  }
  if (!rects.length) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rects.join('')}</svg>`;
}

module.exports = { buildingInsights, roofImagePng, roofImagery, panelOverlaySvg };
