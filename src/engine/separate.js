'use strict';

const { rgbToLab, tintOf, deltaE } = require('./color.js');

/**
 * Builds a function that maps an sRGB color to (ink index, tint 0..1).
 *
 * Each pixel is explained as a tint of the single ink that fits it best:
 * the ink whose substrate->ink line passes closest to the pixel in Lab.
 * Tints become halftone dot sizes later, so a red-to-white gradient is one
 * red screen, and gray on a white shirt is the black screen at a lower tint.
 *
 * Results are memoized per 24-bit color, so big images stay fast.
 */
function createInkClassifier(inks, substrateRgb, options = {}) {
  const inkRgbs = inks.map((ink) => ink.rgb);
  // Colors that print nothing, e.g. a painted-in shirt background.
  const knockouts = (options.knockouts || []).map((rgb) => rgbToLab(rgb[0], rgb[1], rgb[2]));
  const knockoutDeltaE = options.knockoutDeltaE ?? 6;
  if (inkRgbs.length > 254) throw new Error('At most 254 inks are supported');

  // cache entry: 0 = not computed, else ((inkIndex + 1) << 8) | tint(0..255)
  let cache = null;
  const rgb = [0, 0, 0];
  const lab = [0, 0, 0];
  const fit = { t: 0, residual: 0 };

  /** Best ink for a color given as sRGB plus its Lab. */
  function classify(pixRgb, pixLab) {
    for (const k of knockouts) {
      if (deltaE(pixLab, k) < knockoutDeltaE) return { ink: 0, t: 0, residual: 0, knockedOut: true };
    }
    let best = -1;
    let bestRes = Infinity;
    let bestT = 0;
    for (let i = 0; i < inkRgbs.length; i++) {
      tintOf(pixRgb, pixLab, inkRgbs[i], substrateRgb, fit);
      if (fit.residual < bestRes) {
        bestRes = fit.residual;
        best = i;
        bestT = fit.t;
      }
    }
    return { ink: best, t: bestT, residual: bestRes };
  }

  /** Returns the packed ((ink + 1) << 8) | tint8 code for an 8-bit color. */
  function classifyPacked(r, g, b) {
    if (cache === null) cache = new Uint16Array(1 << 24);
    const key = (r << 16) | (g << 8) | b;
    let code = cache[key];
    if (code === 0) {
      rgb[0] = r;
      rgb[1] = g;
      rgb[2] = b;
      rgbToLab(r, g, b, lab);
      const c = classify(rgb, lab);
      code = ((c.ink + 1) << 8) | Math.round(c.t * 255);
      cache[key] = code;
    }
    return code;
  }

  return { classify, classifyPacked };
}

/**
 * Splits an image into one density map per ink.
 *
 * image: { width, height, data: Uint8Array, channels: 3 | 4 } (8-bit sRGB)
 * inks:  [{ rgb: [r, g, b] }]  (usually analyzeColors().inks)
 * returns: { width, height, densities: Uint8Array[] } with 0 = no ink, 255 = solid
 *
 * Semi-transparent pixels are composited over the substrate first, so a
 * transparent background prints nothing. options.background (from
 * detectBackground) is a painted-in background that also prints nothing.
 */
function separate(image, inks, options = {}) {
  const substrate = options.substrate || [255, 255, 255];
  const { width, height, data } = image;
  const channels = image.channels || 4;
  const n = width * height;
  const knockouts = options.background ? [options.background.rgb || options.background] : [];
  const classifier = options.classifier || createInkClassifier(inks, substrate, { knockouts });
  const densities = inks.map(() => new Uint8Array(n));
  const [sr, sg, sb] = substrate;

  for (let i = 0, p = 0; i < n; i++, p += channels) {
    let r = data[p];
    let g = data[p + 1];
    let b = data[p + 2];
    if (channels === 4) {
      const a = data[p + 3];
      if (a === 0) continue;
      if (a < 255) {
        const k = a / 255;
        r = Math.round(sr + (r - sr) * k);
        g = Math.round(sg + (g - sg) * k);
        b = Math.round(sb + (b - sb) * k);
      }
    }
    const code = classifier.classifyPacked(r, g, b);
    const tint = code & 255;
    if (tint > 0) densities[(code >> 8) - 1][i] = tint;
  }
  return { width, height, densities };
}

/**
 * Rebuilds an RGB preview from density maps (continuous tone, no halftone).
 * Used by tests to check that the separation reproduces the art.
 */
function recomposite(sep, inks, substrate = [255, 255, 255]) {
  const { width, height, densities } = sep;
  const out = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    let r = substrate[0];
    let g = substrate[1];
    let b = substrate[2];
    for (let k = 0; k < densities.length; k++) {
      const d = densities[k][i];
      if (d === 0) continue;
      const t = d / 255;
      const ink = inks[k].rgb;
      r += (ink[0] - substrate[0]) * t;
      g += (ink[1] - substrate[1]) * t;
      b += (ink[2] - substrate[2]) * t;
    }
    out[i * 3] = Math.round(r);
    out[i * 3 + 1] = Math.round(g);
    out[i * 3 + 2] = Math.round(b);
  }
  return out;
}

module.exports = { createInkClassifier, separate, recomposite };
