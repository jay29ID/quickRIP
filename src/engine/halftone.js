'use strict';

// AM halftone screening: turns a continuous-tone density map into a 1-bit
// dot pattern at a given line screen (lpi), angle and dot shape.

const GRID = 256; // spot-function samples per cell side

const DEFAULTS = {
  lpi: 36,
  angle: 22.5, // degrees; one angle for all spot screens keeps mesh moire down
  dot: 'round',
  minDot: 0.05, // dots smaller than this won't hold on the screen: dropped
  maxDot: 0.95, // dots larger than this plug up anyway: printed solid
  crispEdges: true, // anti-aliased edges of solid shapes are cut clean instead of screened
};

/**
 * Spot functions. Lower value = inked earlier as density rises.
 * u, v are cell coordinates in [-1, 1) with the dot centered at 0.
 */
const SPOT_FUNCTIONS = {
  // Euclidean round dot: round in highlights, checkerboard at 50%, round holes in shadows.
  round(u, v) {
    const au = Math.abs(u);
    const av = Math.abs(v);
    if (au + av <= 1) return u * u + v * v;
    const x = 1 - au;
    const y = 1 - av;
    return 2 - (x * x + y * y);
  },
  // Elliptical (chain) dot: dots join along one axis first, softer mid-tone jump.
  ellipse(u, v) {
    return 0.64 * u * u + 1.5625 * v * v;
  },
  square(u, v) {
    return Math.max(Math.abs(u), Math.abs(v));
  },
  diamond(u, v) {
    return Math.abs(u) + Math.abs(v);
  },
  line(u, v) {
    return Math.abs(v);
  },
};

const screenCache = new Map();

/**
 * Precomputes the spot function over one cell and the threshold for every
 * 8-bit density, so that density d inks exactly d of the cell's area.
 */
function buildScreen(dot, minDot, maxDot) {
  const key = `${dot}|${minDot}|${maxDot}`;
  if (screenCache.has(key)) return screenCache.get(key);
  const spot = SPOT_FUNCTIONS[dot];
  if (!spot) throw new Error(`Unknown dot shape "${dot}". Use: ${Object.keys(SPOT_FUNCTIONS).join(', ')}`);

  const spotLut = new Float32Array(GRID * GRID);
  for (let j = 0; j < GRID; j++) {
    const v = ((j + 0.5) / GRID) * 2 - 1;
    for (let i = 0; i < GRID; i++) {
      const u = ((i + 0.5) / GRID) * 2 - 1;
      spotLut[j * GRID + i] = spot(u, v);
    }
  }
  const sorted = Float32Array.from(spotLut).sort();
  const n = sorted.length;

  // Pixel is inked when spot < threshold[d]. threshold = the spot value at
  // quantile d, so the inked share of the cell equals d.
  const threshold = new Float32Array(256);
  for (let d = 0; d < 256; d++) {
    const frac = d / 255;
    if (d === 0 || frac < minDot) threshold[d] = -Infinity;
    else if (frac > maxDot || d === 255) threshold[d] = Infinity;
    else threshold[d] = sorted[Math.min(n - 1, Math.round(frac * n))];
  }
  const screen = { spotLut, threshold };
  screenCache.set(key, screen);
  return screen;
}

/**
 * Prepares a density map for screening. Returns { width, height, renderRows }
 * where renderRows(y0, y1) screens output rows [y0, y1). Rendering in strips
 * keeps memory flat on shirt-sized films.
 *
 * density:  Uint8Array, 0 = no ink, 255 = solid, srcWidth * srcHeight
 * options:  lpi, angle, dot, minDot, maxDot,
 *           inputPpi   resolution of the density map (required),
 *           outputPpi  resolution of the film (default: inputPpi),
 *           crispEdges keep solid shapes' outlines smooth (see findSolidEdges)
 * renderRows returns Uint8Array(width * (y1 - y0)) with 255 = ink, 0 = open.
 */
function createHalftoner(density, srcWidth, srcHeight, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!opts.inputPpi) throw new Error('halftone needs inputPpi (the image resolution)');
  const inputPpi = opts.inputPpi;
  const outputPpi = opts.outputPpi || inputPpi;
  const scale = outputPpi / inputPpi;
  const width = Math.round(srcWidth * scale);
  const height = Math.round(srcHeight * scale);

  const { spotLut, threshold } = buildScreen(opts.dot, opts.minDot, opts.maxDot);
  const cellPx = outputPpi / opts.lpi;
  const rad = (opts.angle * Math.PI) / 180;
  const cs = Math.cos(rad) / cellPx;
  const sn = Math.sin(rad) / cellPx;

  const edges = opts.crispEdges ? findSolidEdges(density, srcWidth, srcHeight, opts) : null;
  const sampler = scale === 1 ? null : makeBilinear(density, srcWidth, srcHeight, scale, edges);

  function renderRows(y0, y1) {
    const out = new Uint8Array(width * (y1 - y0));
    for (let y = y0; y < y1; y++) {
      const py = y + 0.5;
      const rowOut = (y - y0) * width;
      const rowIn = y * srcWidth;
      for (let x = 0; x < width; x++) {
        let d;
        let edge;
        if (sampler) {
          d = sampler.sample(x, y);
          edge = sampler.edge;
        } else {
          d = density[rowIn + x];
          edge = edges !== null && edges[rowIn + x] === 1;
        }
        if (d === 0) continue;
        if (edge) {
          if (d >= 128) out[rowOut + x] = 255;
          continue;
        }
        const px = x + 0.5;
        // Rotate into screen space, measured in cells.
        const su = px * cs + py * sn;
        const sv = -px * sn + py * cs;
        const iu = ((su - Math.floor(su)) * GRID) | 0;
        const iv = ((sv - Math.floor(sv)) * GRID) | 0;
        if (spotLut[iv * GRID + iu] < threshold[d]) out[rowOut + x] = 255;
      }
    }
    return out;
  }

  return { width, height, renderRows };
}

/**
 * Halftones a whole density map (or options.rows = [y0, y1) of it).
 * Returns { width, height, y0, y1, data } — see createHalftoner.
 */
function halftone(density, srcWidth, srcHeight, options = {}) {
  const h = createHalftoner(density, srcWidth, srcHeight, options);
  const [y0, y1] = options.rows || [0, h.height];
  return { width: h.width, height: h.height, y0, y1, data: h.renderRows(y0, y1) };
}

/**
 * Marks the anti-aliased rim of solid shapes: partial-density pixels that
 * touch both a solid pixel and an empty one. Screening those would turn a
 * clean outline into a row of half dots, so they are thresholded at 50%
 * instead. Real tonal areas (gradients, tints) never touch both extremes and
 * are screened as usual.
 */
function findSolidEdges(density, w, h, opts) {
  const solid = Math.max(1, Math.ceil(opts.maxDot * 255));
  const empty = Math.floor(opts.minDot * 255);
  const edges = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = density[y * w + x];
      if (d === 0 || d >= solid) continue;
      let hasSolid = false;
      let hasEmpty = false;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const n = density[yy * w + xx];
          if (n >= solid) hasSolid = true;
          else if (n <= empty) hasEmpty = true;
        }
      }
      if (hasSolid && hasEmpty) edges[y * w + x] = 1;
    }
  }
  return edges;
}

/**
 * Bilinear resampler for film output above the art's resolution. After each
 * sample(), .edge says whether the pixel sits on a solid shape's outline:
 * one of its source taps is an edge pixel, or the taps span solid and empty.
 */
function makeBilinear(density, w, h, scale, edges) {
  const solid = 250;
  const empty = 5;
  const s = {
    edge: false,
    sample(x, y) {
      const fx = Math.min(Math.max((x + 0.5) / scale - 0.5, 0), w - 1);
      const fy = Math.min(Math.max((y + 0.5) / scale - 0.5, 0), h - 1);
      const x0 = fx | 0;
      const y0 = fy | 0;
      const x1 = Math.min(x0 + 1, w - 1);
      const y1 = Math.min(y0 + 1, h - 1);
      const tx = fx - x0;
      const ty = fy - y0;
      const a = density[y0 * w + x0];
      const b = density[y0 * w + x1];
      const c = density[y1 * w + x0];
      const d = density[y1 * w + x1];
      if (edges !== null) {
        const lo = Math.min(a, b, c, d);
        const hi = Math.max(a, b, c, d);
        s.edge =
          (lo <= empty && hi >= solid) ||
          edges[y0 * w + x0] === 1 ||
          edges[y0 * w + x1] === 1 ||
          edges[y1 * w + x0] === 1 ||
          edges[y1 * w + x1] === 1;
      }
      return Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
    },
  };
  return s;
}

module.exports = { halftone, createHalftoner, buildScreen, SPOT_FUNCTIONS, DEFAULTS };
