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

  // The image covers the square we ASKED for: radiusMeters around the request
  // point. dataLayers often omits boundingBox, and falling back to
  // buildingInsights.boundingBox is wrong — that describes the building (~38m
  // here) not the tile (~80m), so panels projected into it came out magnified
  // and scattered across the whole picture. Derive the real extent instead.
  const dLat = radius / 111320;
  const dLng = radius / (111320 * Math.cos(lat * Math.PI / 180));
  const derived = {
    sw: { latitude: lat - dLat, longitude: lng - dLng },
    ne: { latitude: lat + dLat, longitude: lng + dLng },
  };
  const out = {
    layers: {},
    bounds: data.boundingBox || derived,
    boundsSource: data.boundingBox ? 'dataLayers' : 'derived',
    imageryDate: fmtDate(data.imageryDate),
  };

  // RGB — straight through.
  const rgbTiff = await fetchTiff(data.rgbUrl);
  let rgbPng = null;
  if (rgbTiff) {
    // 'fill', not 'cover': cover CROPS a non-square raster to fit, which moves
    // the image away from its bounding box corners and makes every projected
    // panel coordinate wrong. Stretching keeps pixel (0,0) at the box corner.
    rgbPng = await sharp(rgbTiff).png().resize(SIZE, SIZE, { fit: 'fill' }).toBuffer();
    out.layers.rgb = `data:image/png;base64,${rgbPng.toString('base64')}`;
  }

  // Annual flux — a single-band float raster (kWh/m²/yr), not a picture. It has
  // to be normalised to 0-255 and given a colour ramp, or it renders as an
  // almost-black square. `normalise` stretches whatever range this roof has to
  // full scale; the tint approximates Google's own purple→yellow ramp.
  const fluxTiff = await fetchTiff(data.annualFluxUrl);
  if (fluxTiff) {
    try {
      // NOT normalise(): that stretches each image's own min-max to full scale,
      // so a large uniform roof — where every pixel receives nearly the same
      // sunlight — saturates to a single flat colour and says nothing. Scale
      // against a fixed real-world range instead, so the same colour means the
      // same kWh/m²/yr on every roof and a genuinely uniform roof looks uniform.
      const FLUX_MIN = Number(opts.fluxMin) || 300;   // deep shade, UK
      const FLUX_MAX = Number(opts.fluxMax) || 1250;  // unshaded south-facing
      const rawFlux = await sharp(fluxTiff).resize(SIZE, SIZE, { fit: 'fill' })
        .toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
      const grey = Buffer.alloc(SIZE * SIZE);
      {
        // The GeoTIFF is float kWh; sharp hands back 8-bit here, so recover the
        // proportion of the fixed range rather than trusting absolute values.
        const src = rawFlux.data;
        const chans = rawFlux.info.channels || 1;
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < grey.length; i++) {
          const v = src[i * chans];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        // A flat roof legitimately has a narrow spread. Only stretch when the
        // spread is wide enough to carry information; otherwise map it to where
        // it actually sits in the fixed range.
        const spread = hi - lo;
        for (let i = 0; i < grey.length; i++) {
          const v = src[i * chans];
          grey[i] = spread > 40 ? Math.round(((v - lo) / spread) * 255) : v;
        }
      }
      const rgbBuf = Buffer.alloc(grey.length * 3);
      // Piecewise ramp through dark purple → magenta → orange → yellow, the
      // "inferno" progression Google's own viewer uses. An earlier version
      // drove red to full while green and blue collapsed, so any roof with a
      // decent spread rendered as a flat red square with no readable detail.
      const STOPS = [
        [0.00, [ 12,   8,  38]],  // near-black indigo
        [0.25, [ 87,  16, 110]],  // purple
        [0.50, [187,  55,  84]],  // magenta-red
        [0.75, [237, 121,  33]],  // orange
        [1.00, [252, 254, 164]],  // pale yellow
      ];
      for (let i = 0; i < grey.length; i++) {
        const v = grey[i] / 255;
        let a = STOPS[0], b = STOPS[STOPS.length - 1];
        for (let s = 0; s < STOPS.length - 1; s++) {
          if (v >= STOPS[s][0] && v <= STOPS[s + 1][0]) { a = STOPS[s]; b = STOPS[s + 1]; break; }
        }
        const span = b[0] - a[0];
        const t = span > 0 ? (v - a[0]) / span : 0;
        rgbBuf[i * 3]     = Math.round(a[1][0] + (b[1][0] - a[1][0]) * t);
        rgbBuf[i * 3 + 1] = Math.round(a[1][1] + (b[1][1] - a[1][1]) * t);
        rgbBuf[i * 3 + 2] = Math.round(a[1][2] + (b[1][2] - a[1][2]) * t);
      }
      // Roof mask: flux is returned for the whole tile, so without this the
      // heatmap paints grass, tarmac and neighbouring buildings as though they
      // were part of the roof. Google's own viewer masks the same way.
      let alpha = null;
      const maskTiff = await fetchTiff(data.maskUrl);
      if (maskTiff) {
        try {
          const m = await sharp(maskTiff).resize(SIZE, SIZE, { fit: 'fill' })
            .toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
          const ch = m.info.channels || 1;
          alpha = Buffer.alloc(SIZE * SIZE);
          for (let i = 0; i < alpha.length; i++) alpha[i] = m.data[i * ch] > 0 ? 255 : 0;
        } catch { alpha = null; }
      }

      let fluxPng;
      if (alpha) {
        // One allocation, filled in place — building this with Buffer.concat of
        // per-pixel buffers means ~590k allocations for a 768² image.
        const rgba = Buffer.alloc(SIZE * SIZE * 4);
        for (let i = 0; i < SIZE * SIZE; i++) {
          rgba[i * 4]     = rgbBuf[i * 3];
          rgba[i * 4 + 1] = rgbBuf[i * 3 + 1];
          rgba[i * 4 + 2] = rgbBuf[i * 3 + 2];
          rgba[i * 4 + 3] = alpha[i];
        }
        fluxPng = await sharp(rgba, { raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toBuffer();
      } else {
        fluxPng = await sharp(rgbBuf, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer();
      }
      out.layers.flux = `data:image/png;base64,${fluxPng.toString('base64')}`;

      // Flux blended over the photo — the view that actually reads as "this
      // roof, and where the sun lands on it".
      if (rgbPng) {
        // 'over' at partial opacity, not 'overlay': the overlay blend mode
        // multiplies against the photo's own luminance, which pushed a bright
        // roof to saturated red and lost all detail underneath.
        const blended = await sharp(rgbPng)
          .composite([{ input: fluxPng, blend: 'over', opacity: 0.55 }])
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

  // Panel dimensions come from the API, not a guess — Google models a specific
  // module per building and reports it as panelWidthMeters/panelHeightMeters.
  const panelW = Number(opts.panelWidthM) || 1.045;
  const panelH = Number(opts.panelHeightM) || 1.879;
  const metresPerDegLat = 111320;
  const pxPerMetreY = (size / latSpan) / metresPerDegLat;
  const metresPerDegLng = 111320 * Math.cos(((sw.latitude + ne.latitude) / 2) * Math.PI / 180);
  const pxPerMetreX = (size / lngSpan) / metresPerDegLng;

  // Panels sit square to their roof segment, not to north — a panel on a roof
  // facing 135° is rotated 135°. Axis-aligned rectangles looked plausible on a
  // square building and obviously wrong on anything angled. segmentAzimuths
  // maps segmentIndex → azimuthDegrees from roofSegmentStats.
  const azimuths = opts.segmentAzimuths || {};

  // Shade by yield, best to worst, so the good part of the roof is visible at a
  // glance rather than every panel reading as equally good.
  const energies = panels.map(p => p.yearlyEnergyDcKwh).filter(e => typeof e === 'number');
  const maxE = energies.length ? Math.max(...energies) : null;
  const minE = energies.length ? Math.min(...energies) : null;

  const shapes = [];
  for (const p of panels) {
    const c = p.center || p.centre;
    if (!c || c.latitude == null || c.longitude == null) continue;
    const cx = ((c.longitude - sw.longitude) / lngSpan) * size;
    // SVG y grows downward, latitude grows upward.
    const cy = size - ((c.latitude - sw.latitude) / latSpan) * size;
    if (cx < -50 || cx > size + 50 || cy < -50 || cy > size + 50) continue;

    // PORTRAIT stands the module on end relative to the segment direction.
    const rot = (p.orientation === 'PORTRAIT' ? 90 : 0)
      + (Number(azimuths[p.segmentIndex]) || 0);
    const w = panelW * pxPerMetreX;
    const h = panelH * pxPerMetreY;

    let fill = '#1e3a8a';
    if (maxE != null && minE != null && maxE > minE && typeof p.yearlyEnergyDcKwh === 'number') {
      const t = (p.yearlyEnergyDcKwh - minE) / (maxE - minE); // 0 worst → 1 best
      // deep blue (poor) → cyan → yellow (best)
      const r = Math.round(30 + t * 225), g = Math.round(58 + t * 190), b = Math.round(138 - t * 100);
      fill = `rgb(${r},${g},${b})`;
    }

    shapes.push(
      `<g transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${rot.toFixed(1)})">` +
      `<rect x="${(-w / 2).toFixed(1)}" y="${(-h / 2).toFixed(1)}" ` +
      `width="${w.toFixed(1)}" height="${h.toFixed(1)}" ` +
      `fill="${fill}" fill-opacity="0.85" stroke="#B0BEC5" stroke-width="0.5" stroke-opacity="0.9"/></g>`
    );
  }
  if (!shapes.length) return null;
  const rects = shapes;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rects.join('')}</svg>`;
}

module.exports = { buildingInsights, roofImagePng, roofImagery, panelOverlaySvg };
