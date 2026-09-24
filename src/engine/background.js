'use strict';

const { rgbToLab, deltaE, toHex } = require('./color.js');

/**
 * Finds the art's background when it is a painted-in shirt color, e.g. a
 * mockup on #141414 when the shirt is set to black. That background must print
 * nothing, even though it is not exactly the shirt color.
 *
 * Looks at the image border. If most of it is one color within maxDeltaE of
 * the shirt, returns that color as { rgb, hex }, otherwise null.
 */
function detectBackground(image, substrate, options = {}) {
  const maxDeltaE = options.maxDeltaE ?? 20;
  const { width, height, data } = image;
  const channels = image.channels || 4;
  const count = new Uint32Array(32768);
  const sum = new Float64Array(32768 * 3);
  let total = 0;
  const visit = (x, y) => {
    const p = (y * width + x) * channels;
    if (channels === 4 && data[p + 3] < 128) return; // transparent: already prints nothing
    const key = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3);
    count[key]++;
    sum[key * 3] += data[p];
    sum[key * 3 + 1] += data[p + 1];
    sum[key * 3 + 2] += data[p + 2];
    total++;
  };
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    visit(0, y);
    visit(width - 1, y);
  }
  if (total === 0) return null;
  let best = 0;
  for (let k = 1; k < 32768; k++) if (count[k] > count[best]) best = k;
  if (count[best] < total * 0.5) return null;
  const rgb = [0, 1, 2].map((c) => Math.round(sum[best * 3 + c] / count[best]));
  const d = deltaE(rgbToLab(...rgb), rgbToLab(...substrate));
  if (d > maxDeltaE) return null;
  return { rgb, hex: toHex(rgb) };
}

module.exports = { detectBackground };
