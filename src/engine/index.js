'use strict';

// quickRIP separation engine. Pure JavaScript with no Photoshop dependency, so
// it runs the same inside the UXP plugin, in Node tests and in the CLI.

const color = require('./color.js');
const { analyzeColors, pickInks, MAX_COLOR_SCREENS } = require('./analyze.js');
const { separate, recomposite, createInkClassifier } = require('./separate.js');
const { halftone, createHalftoner, SPOT_FUNCTIONS } = require('./halftone.js');
const { makeUnderbase } = require('./underbase.js');

/**
 * Plans the screens for an image: which inks, in what print order.
 *
 * options.inkCount   2..7 color screens chosen by the user (default: analysis.suggestedCount)
 * options.substrate  garment color as [r, g, b] (default white)
 * options.underbase  true to add a base screen (default: only on dark garments)
 * options.analysis   reuse an analyzeColors() result instead of re-analyzing
 * options.inks       use exactly these inks ([{ rgb }]), e.g. after the user edits the pick
 *
 * Returns { analysis, inks, underbase, screens: [{ name, kind, hex, rgb, inkIndex }] }
 * with screens in print order: base first, then lightest to darkest
 * (highlight white last on dark shirts).
 */
function planScreens(image, options = {}) {
  const substrate = options.substrate || [255, 255, 255];
  const analysis = options.inks ? null : options.analysis || analyzeColors(image, { ...options.analyze, substrate });
  const inks = (options.inks || pickInks(analysis, options.inkCount || analysis.suggestedCount)).map(withLab);
  const darkSubstrate = color.rgbToLab(...substrate)[0] < 50;
  const underbase = options.underbase ?? darkSubstrate;

  // Print order: light to dark on light shirts. On dark shirts, whites go last
  // as the highlight white.
  const isWhite = (ink) => ink.lab[0] > 90 && Math.hypot(ink.lab[1], ink.lab[2]) < 10;
  const rank = (ink) => (darkSubstrate && isWhite(ink) ? -1000 : 0) + ink.lab[0];
  const order = inks
    .map((ink, inkIndex) => ({ ink, inkIndex }))
    .sort((a, b) => rank(b.ink) - rank(a.ink));
  const screens = [];
  if (underbase) screens.push({ name: 'Base', kind: 'base', hex: '#FFFFFF', rgb: [255, 255, 255], inkIndex: -1 });
  order.forEach(({ ink, inkIndex }, i) => {
    screens.push({ name: `Color ${i + 1} ${ink.hex}`, kind: 'color', hex: ink.hex, rgb: ink.rgb, inkIndex });
  });
  return { analysis, inks, underbase, substrate, screens };
}

function withLab(ink) {
  const rgb = ink.rgb;
  return { ...ink, rgb, hex: ink.hex || color.toHex(rgb), lab: ink.lab || color.rgbToLab(...rgb) };
}

/**
 * Density map (0..255) for every screen in a plan, in the plan's order.
 */
function screenDensities(image, plan, options = {}) {
  const sep = separate(image, plan.inks, { substrate: plan.substrate });
  return plan.screens.map((s) =>
    s.kind === 'base'
      ? makeUnderbase(sep.densities, image.width, image.height, { chokePx: options.chokePx ?? 1 })
      : sep.densities[s.inkIndex]
  );
}

module.exports = {
  ...color,
  analyzeColors,
  pickInks,
  planScreens,
  screenDensities,
  separate,
  recomposite,
  createInkClassifier,
  halftone,
  createHalftoner,
  makeUnderbase,
  DOT_SHAPES: Object.keys(SPOT_FUNCTIONS),
  MAX_COLOR_SCREENS,
};
