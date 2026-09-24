'use strict';

// Photoshop side of quickRIP: reads the open document's pixels, runs the
// engine, and builds a new separations document with one layer per screen.
// The original art is never modified.

const { app, core, imaging, constants } = require('photoshop');
const E = require('../engine/index.js');

const SRGB = 'sRGB IEC61966-2.1';
const STRIP_ROWS = 512; // film rows written per putPixels call
const ANALYSIS_SIZE = 1200; // longest side of the preview read used for analysis

function activeDocument() {
  const doc = app.activeDocument;
  if (!doc) throw new Error('Open the artwork first.');
  return doc;
}

/**
 * Reads the document composite as 8-bit sRGB, whatever its mode (RGB, CMYK,
 * 16-bit...). Photoshop does the color conversion with the document's profile.
 * Must run inside executeAsModal.
 */
async function readComposite(doc, maxSide) {
  const opts = { documentID: doc.id, colorSpace: 'RGB', colorProfile: SRGB, componentSize: 8 };
  const longest = Math.max(doc.width, doc.height);
  if (maxSide && longest > maxSide) {
    const k = maxSide / longest;
    opts.targetSize = { width: Math.round(doc.width * k), height: Math.round(doc.height * k) };
  }
  const { imageData } = await imaging.getPixels(opts);
  try {
    const data = await imageData.getData({ chunky: true });
    return { width: imageData.width, height: imageData.height, data, channels: imageData.components };
  } finally {
    imageData.dispose();
  }
}

/**
 * Color analysis of the active document, for the panel: suggested count and
 * the best inks for every count from 1 to 7.
 */
async function analyzeActiveDocument(settings = {}) {
  return core.executeAsModal(
    async () => {
      const doc = activeDocument();
      const image = await readComposite(doc, ANALYSIS_SIZE);
      return E.analyzeColors(image, { substrate: settings.substrate || [255, 255, 255] });
    },
    { commandName: 'quickRIP: analyze colors' }
  );
}

/**
 * Separates the active document into halftoned screens.
 *
 * settings:
 *   inkCount     color screens (2..7); default: suggested
 *   inks         explicit ink list ([{ rgb, hex, lab }]) to override the pick
 *   substrate    shirt color [r, g, b]
 *   underbase    add a base screen (default: on for dark shirts)
 *   lpi, angle, dot, minDot, maxDot   halftone settings (default 36 lpi, 22.5 deg, round)
 *   filmPpi      output resolution (default: document resolution, at least 300)
 *   layerColor   'ink' (colored preview) or 'black' (film-ready)
 *   sheet        true (default): lay each screen out on a 13 x 19 in film sheet
 *                with crop marks and a label; false: document is the art size
 *   sheetSize    { widthIn, heightIn } to override 13 x 19
 */
async function separateActiveDocument(settings = {}, onProgress = () => {}) {
  return core.executeAsModal(
    async (ctx) => {
      const doc = activeDocument();
      const substrate = settings.substrate || [255, 255, 255];
      const ppi = doc.resolution;
      const filmPpi = settings.filmPpi || Math.max(ppi, 300);
      const progress = (value, text) => {
        ctx.reportProgress({ value, commandName: text });
        onProgress(value, text);
      };

      progress(0.02, 'Reading artwork');
      const image = await readComposite(doc);

      progress(0.1, 'Picking colors');
      const plan = E.planScreens(image, {
        substrate,
        inkCount: settings.inkCount,
        underbase: settings.underbase,
        analysis: settings.analysis,
        inks: settings.inks,
      });
      if (plan.screens.length === 0) throw new Error('No ink found: the art matches the shirt color.');

      progress(0.2, 'Separating');
      const densities = E.screenDensities(image, plan, { chokePx: settings.chokePx ?? 1 });

      const htOpts = {
        lpi: settings.lpi || 36,
        angle: settings.angle ?? 22.5,
        dot: settings.dot || 'round',
        minDot: settings.minDot ?? 0.05,
        maxDot: settings.maxDot ?? 0.95,
        inputPpi: ppi,
        outputPpi: filmPpi,
      };
      const artWidth = Math.round(image.width * (filmPpi / ppi));
      const artHeight = Math.round(image.height * (filmPpi / ppi));
      const useSheet = settings.sheet !== false;
      const layout = useSheet
        ? E.planSheet(artWidth, artHeight, filmPpi, settings.sheetSize)
        : { width: artWidth, height: artHeight, artLeft: 0, artTop: 0, artWidth, artHeight, fits: true };
      if (!layout.fits) {
        const o = layout.options;
        throw new Error(
          `The art is ${inches(artWidth, filmPpi)} x ${inches(artHeight, filmPpi)} in, but a ${o.widthIn} x ${o.heightIn} sheet ` +
            `holds up to ${layout.maxArtIn.width.toFixed(1)} x ${layout.maxArtIn.height.toFixed(1)} in. ` +
            'Scale the art down or turn off the film sheet.'
        );
      }
      const { width, height } = layout;
      const job = stripExtension(doc.title);

      const sepDoc = await app.documents.add({
        width,
        height,
        resolution: filmPpi,
        mode: constants.NewDocumentMode.RGB,
        fill: constants.DocumentFill.WHITE,
        name: `${job} seps`,
      });

      const suspension = await ctx.hostControl.suspendHistory({ documentID: sepDoc.id, name: 'quickRIP separations' });
      const film = settings.layerColor === 'black';
      try {
        const shirt = await fillLayer(sepDoc, 'Shirt', width, height, substrate);
        if (film) shirt.visible = false; // films print on clear stock
        const total = plan.screens.length;
        for (let i = 0; i < total; i++) {
          if (ctx.isCancelled) throw new Error('Cancelled');
          const screen = plan.screens[i];
          progress(0.25 + (0.75 * i) / total, `Screening ${screen.name}`);
          const rgb = film ? [0, 0, 0] : screen.rgb;
          const halftoner = E.createHalftoner(densities[i], image.width, image.height, htOpts);
          const renderRows = useSheet
            ? (() => {
                const marks = E.sheetMarks(layout, E.screenLabel(job, screen, i, total, htOpts));
                return (y0, y1) => E.renderSheetRows(layout, halftoner, marks, y0, y1);
              })()
            : halftoner.renderRows;
          await writeScreenLayer(sepDoc, `${i + 1}/${total} ${screen.name}`, width, height, renderRows, rgb);
        }
      } finally {
        await ctx.hostControl.resumeHistory(suspension);
      }
      progress(1, 'Done');
      return { plan, filmPpi, width, height, layout, documentID: sepDoc.id };
    },
    { commandName: 'quickRIP: separate' }
  );
}

/**
 * Adds a layer and writes a screen into it, strip by strip.
 * renderRows(y0, y1) returns that strip's mask (255 = ink).
 */
async function writeScreenLayer(doc, name, width, height, renderRows, rgb) {
  const layer = await doc.createPixelLayer({ name, blendMode: constants.BlendMode.NORMAL, opacity: 100 });
  for (let y0 = 0; y0 < height; y0 += STRIP_ROWS) {
    const y1 = Math.min(height, y0 + STRIP_ROWS);
    const mask = renderRows(y0, y1);
    if (mask.indexOf(255) === -1) continue; // blank film: nothing to write
    const buf = new Uint8Array(mask.length * 4);
    for (let p = 0; p < mask.length; p++) {
      if (mask[p] === 0) continue;
      const q = p * 4;
      buf[q] = rgb[0];
      buf[q + 1] = rgb[1];
      buf[q + 2] = rgb[2];
      buf[q + 3] = 255;
    }
    await putStrip(doc, layer, buf, width, y0, y1);
  }
  return layer;
}

/** A solid layer in the shirt color, so the preview reads like the print. */
async function fillLayer(doc, name, width, height, rgb) {
  const layer = await doc.createPixelLayer({ name });
  for (let y0 = 0; y0 < height; y0 += STRIP_ROWS) {
    const y1 = Math.min(height, y0 + STRIP_ROWS);
    const buf = new Uint8Array(width * (y1 - y0) * 4);
    for (let q = 0; q < buf.length; q += 4) {
      buf[q] = rgb[0];
      buf[q + 1] = rgb[1];
      buf[q + 2] = rgb[2];
      buf[q + 3] = 255;
    }
    await putStrip(doc, layer, buf, width, y0, y1);
  }
  return layer;
}

async function putStrip(doc, layer, buf, width, y0, y1) {
  const imageData = await imaging.createImageDataFromBuffer(buf, {
    width,
    height: y1 - y0,
    components: 4,
    chunky: true,
    colorSpace: 'RGB',
    colorProfile: SRGB,
  });
  try {
    // replace: false blends onto the (still empty) strip instead of clearing the layer.
    await imaging.putPixels({
      documentID: doc.id,
      layerID: layer.id,
      imageData,
      targetBounds: { left: 0, top: y0 },
      replace: false,
    });
  } finally {
    imageData.dispose();
  }
}

function inches(px, ppi) {
  return (px / ppi).toFixed(1);
}

function stripExtension(title) {
  return String(title).replace(/\.[^.]+$/, '');
}

module.exports = { analyzeActiveDocument, separateActiveDocument, readComposite };
