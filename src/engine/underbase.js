'use strict';

/**
 * Builds the base screen: ink everywhere any color prints, pulled in
 * ("choked") by chokePx so the base never peeks out around the colors.
 *
 * densities: Uint8Array[] from separate()
 * returns:   Uint8Array density map, same size
 */
function makeUnderbase(densities, width, height, options = {}) {
  const chokePx = Math.max(0, Math.round(options.chokePx ?? 1));
  const n = width * height;
  const base = new Uint8Array(n);
  for (const d of densities) {
    for (let i = 0; i < n; i++) if (d[i] > base[i]) base[i] = d[i];
  }
  return chokePx > 0 ? erode(base, width, height, chokePx) : base;
}

/** Square min filter of radius r, done as two 1-D passes. */
function erode(src, width, height, r) {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let m = 255;
      const a = Math.max(0, x - r);
      const b = Math.min(width - 1, x + r);
      for (let k = a; k <= b && m > 0; k++) if (src[row + k] < m) m = src[row + k];
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let m = 255;
      const a = Math.max(0, y - r);
      const b = Math.min(height - 1, y + r);
      for (let k = a; k <= b && m > 0; k++) if (tmp[k * width + x] < m) m = tmp[k * width + x];
      out[y * width + x] = m;
    }
  }
  return out;
}

module.exports = { makeUnderbase };
