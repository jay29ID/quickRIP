'use strict';

// Film sheet layout: puts a screen's halftone on a fixed-size sheet of film
// (13 x 19 in by default) with crop marks, a registration target and a label
// across the top, so each layer can be printed as-is.

const { textRects, textWidth, CHAR_H } = require('./font.js');

const SHEET_DEFAULTS = {
  widthIn: 13,
  heightIn: 19,
  artTopIn: 1.25, // art starts this far down; marks and label live above it
  marginIn: 0.25, // art must stay this far inside the other three edges
  labelHeightIn: 0.12, // cap height of the label text
};

/**
 * Where the art goes on the sheet. Art is centered left to right and hangs
 * from artTopIn.
 * artWidth/artHeight are film pixels at ppi.
 */
function planSheet(artWidth, artHeight, ppi, options = {}) {
  const o = { ...SHEET_DEFAULTS, ...options };
  const width = Math.round(o.widthIn * ppi);
  const height = Math.round(o.heightIn * ppi);
  const margin = Math.round(o.marginIn * ppi);
  const artLeft = Math.floor((width - artWidth) / 2);
  const artTop = Math.round(o.artTopIn * ppi);
  const fits = artWidth <= width - 2 * margin && artTop + artHeight <= height - margin;
  return {
    width,
    height,
    ppi,
    artLeft,
    artTop,
    artWidth,
    artHeight,
    fits,
    maxArtIn: { width: (width - 2 * margin) / ppi, height: (height - margin - artTop) / ppi },
    options: o,
  };
}

/**
 * Crop marks at the art's top corners, a registration target centered above
 * the art, and the label text. Everything sits above the art, so every film
 * of a job lines up on the same marks.
 * Returns { rects, rings } in sheet pixels.
 */
function sheetMarks(layout, label) {
  const { ppi, artLeft, artTop, artWidth, width } = layout;
  const t = Math.max(2, Math.round(0.01 * ppi)); // line weight, about 0.7 pt
  const half = Math.floor(t / 2);
  const off = Math.round(0.125 * ppi); // gap between mark and art
  const len = Math.round(0.375 * ppi);
  const artRight = artLeft + artWidth;
  const rects = [];

  for (const x of [artLeft, artRight]) {
    const outward = x === artLeft ? -1 : 1;
    // Vertical tick above the corner.
    rects.push({ x0: x - half, x1: x - half + t, y0: artTop - off - len, y1: artTop - off });
    // Horizontal tick beside the corner, pointing away from the art.
    const a = x + outward * off;
    const b = x + outward * (off + len);
    rects.push({ x0: Math.min(a, b), x1: Math.max(a, b), y0: artTop - half, y1: artTop - half + t });
  }

  // Registration target: ring with a crosshair, centered over the art.
  const cx = artLeft + Math.round(artWidth / 2);
  const cy = artTop - Math.round(0.45 * ppi);
  const r = Math.round(0.18 * ppi);
  const arm = Math.round(r * 1.4);
  rects.push({ x0: cx - arm, x1: cx + arm, y0: cy - half, y1: cy - half + t });
  rects.push({ x0: cx - half, x1: cx - half + t, y0: cy - arm, y1: cy + arm });
  const rings = [{ cx, cy, r, t }];

  if (label) {
    const scale = Math.max(1, Math.round((layout.options.labelHeightIn * ppi) / CHAR_H));
    const margin = Math.round(layout.options.marginIn * ppi);
    const maxChars = Math.floor((width - 2 * margin) / (6 * scale));
    const text = String(label).slice(0, maxChars);
    const x = Math.max(margin, Math.round((width - textWidth(text, scale)) / 2));
    const y = Math.round(0.3 * ppi);
    rects.push(...textRects(text, x, y, scale));
  }
  return { rects, rings };
}

/**
 * Renders sheet rows [y0, y1): the halftoned art in place plus the marks.
 * halftoner: from createHalftoner(), sized artWidth x artHeight.
 * Returns Uint8Array(width * (y1 - y0)), 255 = ink.
 */
function renderSheetRows(layout, halftoner, marks, y0, y1) {
  const { width, artLeft, artTop, artHeight } = layout;
  const out = new Uint8Array(width * (y1 - y0));

  const a0 = Math.max(y0, artTop);
  const a1 = Math.min(y1, artTop + artHeight);
  if (a1 > a0) {
    const art = halftoner.renderRows(a0 - artTop, a1 - artTop);
    const w = halftoner.width;
    for (let y = a0; y < a1; y++) {
      out.set(art.subarray((y - a0) * w, (y - a0 + 1) * w), (y - y0) * width + artLeft);
    }
  }

  for (const rc of marks.rects) {
    const ry0 = Math.max(rc.y0, y0);
    const ry1 = Math.min(rc.y1, y1);
    const rx0 = Math.max(rc.x0, 0);
    const rx1 = Math.min(rc.x1, width);
    for (let y = ry0; y < ry1; y++) out.fill(255, (y - y0) * width + rx0, (y - y0) * width + rx1);
  }
  for (const { cx, cy, r, t } of marks.rings) {
    const outer = r + t / 2;
    const inner = r - t / 2;
    const ry0 = Math.max(Math.floor(cy - outer), y0);
    const ry1 = Math.min(Math.ceil(cy + outer) + 1, y1);
    for (let y = ry0; y < ry1; y++) {
      for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d >= inner && d <= outer && x >= 0 && x < width) out[(y - y0) * width + x] = 255;
      }
    }
  }
  return out;
}

/** Film label, e.g. "JOB | 2 OF 4 | COLOR 1 #FFD100 | 36 LPI 22.5 DEG ROUND". */
function screenLabel(job, screen, index, total, ht) {
  const what = screen.kind === 'base' ? 'BASE' : screen.name.toUpperCase();
  return [String(job).toUpperCase(), `${index + 1} OF ${total}`, what, `${ht.lpi} LPI ${ht.angle} DEG ${String(ht.dot).toUpperCase()}`].join(' | ');
}

module.exports = { planSheet, sheetMarks, renderSheetRows, screenLabel, SHEET_DEFAULTS };
