'use strict';

const { rgbToLab, labToRgb, deltaE, toHex, tintOf } = require('./color.js');
const { createInkClassifier } = require('./separate.js');
const { detectBackground } = require('./background.js');

// Jason's press: 8 heads, one kept for the base, so 7 color screens max.
const MAX_COLOR_SCREENS = 7;

const DEFAULTS = {
  substrate: [255, 255, 255], // garment / paper color, 8-bit sRGB
  maxInks: MAX_COLOR_SCREENS,
  maxSamples: 400000, // pixels sampled for analysis
  clusters: 32, // initial k-means clusters before merging
  mergeDeltaE: 8, // clusters closer than this are the same ink
  tintTolerance: 8, // a lighter cluster within this of an ink's tint line is a tint of it
  mergeTints: true, // false = solid spot seps, every shade is its own ink
  minCoverage: 0.002, // candidate inks under this share of the art are ignored
  substrateDeltaE: 4, // pixels this close to the substrate carry no ink
  targetDeltaE: 5, // suggested count: fewest inks whose average error is under this...
  colorDeltaE: 12, // ...and where no color covering 1%+ of the art is off by more than this
  seed: 1,
};

/**
 * Looks at an image and works out which inks it needs.
 *
 * image: { width, height, data: Uint8Array, channels: 3 | 4 } (8-bit sRGB)
 *
 * Returns:
 *   candidates     every distinct ink found, strongest first
 *   fits           fits[n] = { count: n, inks, meanDeltaE, p90DeltaE } for n = 1..maxInks,
 *                  where inks are the n most important candidates
 *   suggestedCount fewest inks that reproduce the art within targetDeltaE
 *   substrate      { rgb, hex }, darkSubstrate: true when a base is likely needed
 *
 * "Most important" is measured, not guessed: starting from all candidates, the
 * ink whose removal hurts the reproduction least is dropped, one at a time.
 */
function analyzeColors(image, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const substrate = opts.substrate;
  const subLab = rgbToLab(substrate[0], substrate[1], substrate[2]);

  // A painted-in background near the shirt color counts as shirt, not ink.
  const background = opts.background !== undefined ? opts.background : detectBackground(image, substrate);
  const bgLab = background ? rgbToLab(...background.rgb) : null;
  const { bins, total, substrateWeight } = histogram(image, opts, subLab, bgLab);
  const inkWeight = total - substrateWeight;
  if (bins.length === 0 || inkWeight / total < 1e-4) {
    return emptyResult(opts, total);
  }

  let clusters = kmeans(bins, Math.min(opts.clusters, bins.length), opts.seed);
  clusters = mergeClose(clusters, opts.mergeDeltaE);
  let candidates = opts.mergeTints ? mergeTints(clusters, substrate, subLab, opts.tintTolerance) : clusters;
  candidates = refineInks(candidates, bins, substrate, subLab);

  // Drop candidates too small to matter, then recompute shares.
  let shares = assignShares(candidates, bins, substrate, inkWeight);
  candidates = candidates.filter((_, i) => shares[i] >= opts.minCoverage);
  if (candidates.length === 0) return emptyResult(opts, total);
  shares = assignShares(candidates, bins, substrate, inkWeight);
  candidates.forEach((c, i) => (c.share = shares[i]));
  candidates.sort((a, b) => deltaE(b.lab, subLab) - deltaE(a.lab, subLab));

  const fits = rankByImportance(candidates, bins, substrate, inkWeight, opts);
  let suggestedCount = fits.length - 1;
  for (let n = 1; n < fits.length; n++) {
    if (fits[n].meanDeltaE <= opts.targetDeltaE && fits[n].worstColorDeltaE <= opts.colorDeltaE) {
      suggestedCount = n;
      break;
    }
  }

  return {
    substrate: { rgb: substrate.slice(), hex: toHex(substrate) },
    background,
    darkSubstrate: subLab[0] < 50,
    candidates: candidates.map(publicInk),
    fits: fits.map((f) => f && { ...f, inks: f.inks.map(publicInk) }),
    suggestedCount,
    maxInks: fits.length - 1,
    stats: {
      sampledPixels: total,
      substrateShare: substrateWeight / total,
      distinctColors: bins.length,
    },
  };
}

/** The n most important inks, for when the user picks the screen count. */
function pickInks(analysis, count) {
  if (!analysis.fits.length) return [];
  const n = Math.max(1, Math.min(count, analysis.maxInks));
  return analysis.fits[n].inks;
}

function publicInk(c) {
  const rgb = c.rgb || labToRgb(c.lab[0], c.lab[1], c.lab[2]);
  return {
    rgb,
    hex: toHex(rgb),
    lab: c.lab.map((v) => Math.round(v * 100) / 100),
    share: c.share !== undefined ? Math.round(c.share * 10000) / 10000 : undefined,
  };
}

function emptyResult(opts, total) {
  return {
    substrate: { rgb: opts.substrate.slice(), hex: toHex(opts.substrate) },
    background: null,
    darkSubstrate: false,
    candidates: [],
    fits: [],
    suggestedCount: 0,
    maxInks: 0,
    stats: { sampledPixels: total, substrateShare: 1, distinctColors: 0 },
  };
}

/**
 * 15-bit color histogram of a pixel sample. Each bin keeps its mean color so
 * precision isn't lost to the 5-bit quantization.
 */
function histogram(image, opts, subLab, bgLab) {
  const { width, height, data } = image;
  const channels = image.channels || 4;
  const n = width * height;
  const step = Math.max(1, Math.floor(Math.sqrt(n / opts.maxSamples)));
  const count = new Uint32Array(32768);
  const sum = new Float64Array(32768 * 3);
  const [sr, sg, sb] = opts.substrate;
  let total = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const p = (y * width + x) * channels;
      let r = data[p];
      let g = data[p + 1];
      let b = data[p + 2];
      if (channels === 4 && data[p + 3] < 255) {
        const k = data[p + 3] / 255;
        r = sr + (r - sr) * k;
        g = sg + (g - sg) * k;
        b = sb + (b - sb) * k;
      }
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      count[key]++;
      sum[key * 3] += r;
      sum[key * 3 + 1] += g;
      sum[key * 3 + 2] += b;
      total++;
    }
  }

  const bins = [];
  let substrateWeight = 0;
  for (let key = 0; key < 32768; key++) {
    const w = count[key];
    if (w === 0) continue;
    const rgb = [sum[key * 3] / w, sum[key * 3 + 1] / w, sum[key * 3 + 2] / w];
    const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
    if (deltaE(lab, subLab) < opts.substrateDeltaE || (bgLab && deltaE(lab, bgLab) < 6)) {
      substrateWeight += w;
      continue;
    }
    bins.push({ rgb, lab, w });
  }
  return { bins, total, substrateWeight };
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weighted k-means++ in Lab over histogram bins. Deterministic for a seed. */
function kmeans(bins, k, seed) {
  const rand = mulberry32(seed);
  const centers = [];
  const d2 = new Float64Array(bins.length).fill(Infinity);

  let totalW = 0;
  for (const b of bins) totalW += b.w;
  let pick = rand() * totalW;
  let first = 0;
  for (let i = 0; i < bins.length; i++) {
    pick -= bins[i].w;
    if (pick <= 0) {
      first = i;
      break;
    }
  }
  centers.push(bins[first].lab.slice());

  while (centers.length < k) {
    const c = centers[centers.length - 1];
    let sumD = 0;
    for (let i = 0; i < bins.length; i++) {
      const d = deltaE(bins[i].lab, c);
      if (d * d < d2[i]) d2[i] = d * d;
      sumD += d2[i] * bins[i].w;
    }
    if (sumD === 0) break;
    let r = rand() * sumD;
    let idx = bins.length - 1;
    for (let i = 0; i < bins.length; i++) {
      r -= d2[i] * bins[i].w;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    centers.push(bins[idx].lab.slice());
  }

  const assign = new Int32Array(bins.length);
  for (let iter = 0; iter < 20; iter++) {
    let moved = 0;
    for (let i = 0; i < bins.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = deltaE(bins[i].lab, centers[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) moved++;
      assign[i] = best;
    }
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < bins.length; i++) {
      const a = acc[assign[i]];
      const { lab, w } = bins[i];
      a[0] += lab[0] * w;
      a[1] += lab[1] * w;
      a[2] += lab[2] * w;
      a[3] += w;
    }
    acc.forEach((a, c) => {
      if (a[3] > 0) centers[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
    });
    if (iter > 0 && moved === 0) break;
  }

  const acc = centers.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < bins.length; i++) {
    const a = acc[assign[i]];
    const { rgb, w } = bins[i];
    a[0] += rgb[0] * w;
    a[1] += rgb[1] * w;
    a[2] += rgb[2] * w;
    a[3] += w;
  }
  return centers
    .map((lab, c) => ({ lab, rgb: acc[c].slice(0, 3).map((v) => v / acc[c][3]), w: acc[c][3] }))
    .filter((c) => c.w > 0);
}

/** Repeatedly merges the closest pair of clusters while closer than maxDelta. */
function mergeClose(clusters, maxDelta) {
  const cs = clusters.map((c) => ({ lab: c.lab.slice(), rgb: c.rgb.slice(), w: c.w }));
  for (;;) {
    let bi = -1;
    let bj = -1;
    let bd = maxDelta;
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const d = deltaE(cs[i].lab, cs[j].lab);
        if (d < bd) {
          bd = d;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0) return cs;
    const a = cs[bi];
    const b = cs[bj];
    const w = a.w + b.w;
    a.rgb = a.rgb.map((v, k) => (v * a.w + b.rgb[k] * b.w) / w);
    a.lab = rgbToLab(a.rgb[0], a.rgb[1], a.rgb[2]);
    a.w = w;
    cs.splice(bj, 1);
  }
}

/**
 * Folds lighter clusters into the ink they are a tint of. Strongest colors
 * (farthest from the substrate) are taken as inks first.
 */
function mergeTints(clusters, substrate, subLab, tolerance) {
  const sorted = clusters
    .map((c) => ({ lab: c.lab.slice(), rgb: c.rgb.slice(), w: c.w }))
    .sort((a, b) => deltaE(b.lab, subLab) - deltaE(a.lab, subLab));
  const inks = [];
  const fit = { t: 0, residual: 0 };
  for (const c of sorted) {
    let host = null;
    for (const ink of inks) {
      tintOf(c.rgb, c.lab, ink.rgb, substrate, fit);
      if (fit.residual < tolerance) {
        host = ink;
        break;
      }
    }
    if (host) host.w += c.w;
    else inks.push(c);
  }
  return inks;
}

/**
 * An ink's color should be its full-strength color, not the average of its
 * tints. Take the strongest 15% (by pixel weight) of the colors it prints.
 */
function refineInks(inks, bins, substrate, subLab) {
  const classifier = createInkClassifier(inks, substrate);
  const members = inks.map(() => []);
  for (const b of bins) members[classifier.classify(b.rgb, b.lab).ink].push(b);
  return inks
    .map((ink, i) => {
      const list = members[i];
      if (list.length === 0) return null;
      list.sort((a, b) => deltaE(b.lab, subLab) - deltaE(a.lab, subLab));
      let wTotal = 0;
      for (const b of list) wTotal += b.w;
      // Full strength = the strongest colors this ink prints: those within 93%
      // of its (outlier-proof) strongest color's distance from the shirt.
      let dRef = deltaE(list[0].lab, subLab);
      for (let k = 0, cw = 0; k < list.length; k++) {
        cw += list[k].w;
        dRef = deltaE(list[k].lab, subLab);
        if (cw >= wTotal * 0.02) break;
      }
      const acc = [0, 0, 0];
      let w = 0;
      for (const b of list) {
        if (w > 0 && deltaE(b.lab, subLab) < 0.93 * dRef) break;
        acc[0] += b.rgb[0] * b.w;
        acc[1] += b.rgb[1] * b.w;
        acc[2] += b.rgb[2] * b.w;
        w += b.w;
      }
      const rgb = acc.map((v) => Math.round(v / w));
      return { rgb, lab: rgbToLab(rgb[0], rgb[1], rgb[2]), w: wTotal };
    })
    .filter(Boolean);
}

function assignShares(inks, bins, substrate, inkWeight) {
  const classifier = createInkClassifier(inks, substrate);
  const shares = new Float64Array(inks.length);
  for (const b of bins) shares[classifier.classify(b.rgb, b.lab).ink] += b.w / inkWeight;
  return Array.from(shares);
}

/**
 * Backward elimination: from all candidates, drop the ink whose loss hurts
 * the reproduction least, one at a time. fits[n] holds the best n inks found.
 *
 * Error of a color = delta E between it and the closest tint any remaining ink
 * can print. Precomputed once per (color, candidate), so trials are cheap.
 */
function rankByImportance(candidates, bins, substrate, inkWeight, opts) {
  const K = candidates.length;
  const B = bins.length;
  const res = new Float64Array(B * K);
  const fit = { t: 0, residual: 0 };
  const home = new Int32Array(B); // which candidate each color belongs to with all inks available
  for (let b = 0; b < B; b++) {
    let best = Infinity;
    for (let k = 0; k < K; k++) {
      tintOf(bins[b].rgb, bins[b].lab, candidates[k].rgb, substrate, fit);
      res[b * K + k] = fit.residual;
      if (fit.residual < best) {
        best = fit.residual;
        home[b] = k;
      }
    }
  }

  const errorsFor = (active) => {
    const errs = new Float64Array(B);
    for (let b = 0; b < B; b++) {
      let m = Infinity;
      for (const k of active) if (res[b * K + k] < m) m = res[b * K + k];
      errs[b] = m;
    }
    return errs;
  };
  const meanOf = (errs) => {
    let s = 0;
    for (let b = 0; b < B; b++) s += errs[b] * bins[b].w;
    return s / inkWeight;
  };
  const record = (active) => {
    const errs = errorsFor(active);
    const order = Array.from(errs.keys()).sort((a, b) => errs[a] - errs[b]);
    let acc = 0;
    let p90 = 0;
    for (const b of order) {
      acc += bins[b].w;
      p90 = errs[b];
      if (acc >= inkWeight * 0.9) break;
    }
    // Worst average error over any original color covering 1%+ of the art.
    const sumE = new Float64Array(K);
    const sumW = new Float64Array(K);
    for (let b = 0; b < B; b++) {
      sumE[home[b]] += errs[b] * bins[b].w;
      sumW[home[b]] += bins[b].w;
    }
    let worst = 0;
    for (let k = 0; k < K; k++) {
      if (sumW[k] / inkWeight >= 0.01) worst = Math.max(worst, sumE[k] / sumW[k]);
    }
    const round2 = (v) => Math.round(v * 100) / 100;
    return {
      count: active.length,
      inks: active.map((k) => candidates[k]),
      meanDeltaE: round2(meanOf(errs)),
      p90DeltaE: round2(p90),
      worstColorDeltaE: round2(worst),
    };
  };

  const fits = [];
  let active = candidates.map((_, k) => k);
  if (K <= opts.maxInks) fits[K] = record(active);
  while (active.length > 1) {
    let bestSet = null;
    let bestErr = Infinity;
    for (const drop of active) {
      const trial = active.filter((k) => k !== drop);
      const e = meanOf(errorsFor(trial));
      if (e < bestErr) {
        bestErr = e;
        bestSet = trial;
      }
    }
    active = bestSet;
    if (active.length <= opts.maxInks) fits[active.length] = record(active);
  }
  fits.length = Math.min(fits.length, opts.maxInks + 1);
  return fits;
}

module.exports = { analyzeColors, pickInks, DEFAULTS, MAX_COLOR_SCREENS };
