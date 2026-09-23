'use strict';

// Color math shared by the engine. Everything works in CIE L*a*b* (D65)
// because ink decisions are about how different colors *look*.

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

function labF(t) {
  return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

/** 8-bit sRGB -> [L, a, b]. Accepts fractional channel values. */
function rgbToLab(r, g, b, out = [0, 0, 0]) {
  const rl = linearize(r);
  const gl = linearize(g);
  const bl = linearize(b);
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / XN;
  const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175) / YN;
  const z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) / ZN;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
  return out;
}

function linearize(v) {
  if (Number.isInteger(v) && v >= 0 && v <= 255) return SRGB_TO_LINEAR[v];
  const c = Math.min(Math.max(v, 0), 255) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** [L, a, b] -> 8-bit sRGB, clamped to gamut. */
function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (f) => (f * f * f > EPS ? f * f * f : (116 * f - 16) / KAPPA);
  const x = inv(fx) * XN;
  const y = L > KAPPA * EPS ? Math.pow(fy, 3) : L / KAPPA;
  const z = inv(fz) * ZN;
  const rl = x * 3.2404542 - y * 1.5371385 - z * 0.4985314;
  const gl = -x * 0.969266 + y * 1.8760108 + z * 0.041556;
  const bl = x * 0.0556434 - y * 0.2040259 + z * 1.0572252;
  const enc = (c) => {
    c = Math.min(Math.max(c, 0), 1);
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(v * 255);
  };
  return [enc(rl), enc(gl), enc(bl)];
}

/** CIE76 color difference. Good enough for clustering decisions. */
function deltaE(p, q) {
  const dl = p[0] - q[0];
  const da = p[1] - q[1];
  const db = p[2] - q[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/**
 * Naive CMYK (0-255 per channel) -> sRGB. Inside Photoshop the adapter asks
 * Photoshop to convert with the document's real profile instead; this is only
 * for standalone use (tests, CLI).
 */
function cmykToRgb(c, m, y, k) {
  const kk = 1 - k / 255;
  return [
    Math.round(255 * (1 - c / 255) * kk),
    Math.round(255 * (1 - m / 255) * kk),
    Math.round(255 * (1 - y / 255) * kk),
  ];
}

/** Convert an interleaved CMYK buffer (4 bytes/pixel) to RGBA. */
function cmykBufferToRgba(cmyk) {
  const n = cmyk.length / 4;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const rgb = cmykToRgb(cmyk[i * 4], cmyk[i * 4 + 1], cmyk[i * 4 + 2], cmyk[i * 4 + 3]);
    out[i * 4] = rgb[0];
    out[i * 4 + 1] = rgb[1];
    out[i * 4 + 2] = rgb[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

function toHex(rgb) {
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function parseHex(hex) {
  const h = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`Not a hex color: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/**
 * Model a pixel as a tint of one ink laid on the substrate:
 *   pixel ~= substrate + t * (ink - substrate),  t in [0, 1]
 *
 * t is found along the straight line in 8-bit sRGB, because that is how tints
 * are made in artwork (opacity or gradients over the shirt color) and roughly
 * how printers read dot percentages. How well the tint matches the pixel
 * (residual) is judged in Lab, i.e. by eye.
 */
function tintOf(pixRgb, pixLab, inkRgb, subRgb, out = { t: 0, residual: 0 }) {
  const dx = inkRgb[0] - subRgb[0];
  const dy = inkRgb[1] - subRgb[1];
  const dz = inkRgb[2] - subRgb[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (len2 > 0) {
    t = ((pixRgb[0] - subRgb[0]) * dx + (pixRgb[1] - subRgb[1]) * dy + (pixRgb[2] - subRgb[2]) * dz) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const lab = rgbToLab(subRgb[0] + t * dx, subRgb[1] + t * dy, subRgb[2] + t * dz, TINT_LAB);
  out.t = t;
  out.residual = deltaE(pixLab, lab);
  return out;
}
const TINT_LAB = [0, 0, 0];

module.exports = {
  rgbToLab,
  labToRgb,
  deltaE,
  cmykToRgb,
  cmykBufferToRgba,
  toHex,
  parseHex,
  tintOf,
};
