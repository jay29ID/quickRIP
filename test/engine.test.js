'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const F = require('./fixtures');

const hexes = (inks) => inks.map((i) => i.hex).sort();
const near = (hex, target, tol = 6) => E.deltaE(E.rgbToLab(...E.parseHex(hex)), E.rgbToLab(...E.parseHex(target))) < tol;

test('counts three spot colors on white', () => {
  const a = E.analyzeColors(F.spot3());
  assert.equal(a.suggestedCount, 3);
  assert.deepEqual(hexes(a.fits[3].inks), ['#111111', '#1B4F9C', '#D7263D']);
});

test('CMYK art gives the same three inks', () => {
  const a = E.analyzeColors(F.spot3Cmyk());
  assert.equal(a.suggestedCount, 3);
});

test('a white-to-red fade is one red screen, not several reds', () => {
  const a = E.analyzeColors(F.gradient());
  assert.equal(a.suggestedCount, 2);
  const inks = a.fits[2].inks.map((i) => i.hex);
  assert.ok(inks.some((h) => near(h, '#C8102E')), `expected the full-strength red, got ${inks}`);
});

test('user-chosen count keeps the most important colors', () => {
  const a = E.analyzeColors(F.sixColors());
  assert.equal(a.suggestedCount, 6);
  // Asked for 4 of 6: the two smallest (green 7%, purple 3%) are the ones to go.
  assert.deepEqual(hexes(E.pickInks(a, 4)), ['#111111', '#1B4F9C', '#D7263D', '#F4C20D']);
  assert.deepEqual(hexes(E.pickInks(a, 5)), ['#111111', '#1B4F9C', '#2E9E44', '#D7263D', '#F4C20D']);
  // Fit error only gets better as screens are added.
  for (let n = 2; n <= 6; n++) assert.ok(a.fits[n].meanDeltaE <= a.fits[n - 1].meanDeltaE);
});

test('never offers more than 7 color screens (one head kept for the base)', () => {
  const a = E.analyzeColors(F.photo());
  assert.equal(a.maxInks, 7);
  assert.equal(a.suggestedCount, 7);
  assert.equal(E.pickInks(a, 9).length, 7);
});

test('dark shirt: shirt color is not an ink, base screen is planned', () => {
  const img = F.darkShirt();
  const plan = E.planScreens(img, { substrate: F.SHIRT_BLACK });
  assert.equal(plan.analysis.suggestedCount, 2);
  assert.equal(plan.underbase, true);
  assert.deepEqual(plan.screens.map((s) => s.kind), ['base', 'color', 'color']);
  const [base] = E.screenDensities(img, plan, { chokePx: 1 });
  // Base sits under the art: center of the yellow circle is solid, shirt is empty.
  assert.equal(base[170 * img.width + 250], 255);
  assert.equal(base[10 * img.width + 10], 0);
});

test('separation reproduces the art', () => {
  for (const img of [F.spot3(), F.gradient()]) {
    const a = E.analyzeColors(img);
    const inks = E.pickInks(a, a.suggestedCount);
    const sep = E.separate(img, inks);
    const back = E.recomposite(sep, inks);
    let sum = 0;
    const n = img.width * img.height;
    for (let i = 0; i < n; i++) {
      const p = E.rgbToLab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
      const q = E.rgbToLab(back[i * 3], back[i * 3 + 1], back[i * 3 + 2]);
      sum += E.deltaE(p, q);
    }
    assert.ok(sum / n < 2, `mean delta E ${sum / n}`);
  }
});

test('separation puts each pixel on the right screen', () => {
  const img = F.spot3();
  const inks = E.pickInks(E.analyzeColors(img), 3);
  const sep = E.separate(img, inks);
  const at = (x, y) => sep.densities.map((d) => d[y * img.width + x]);
  const idx = (hex) => inks.findIndex((i) => i.hex === hex);
  assert.equal(at(150, 180)[idx('#D7263D')], 255); // red circle
  assert.equal(at(420, 200)[idx('#1B4F9C')], 255); // blue box
  assert.equal(at(300, 367)[idx('#111111')], 255); // black bar
  assert.deepEqual(at(5, 5), [0, 0, 0]); // white paper
});

test('halftone dot area matches density', () => {
  const w = 720;
  const h = 720;
  for (const dot of E.DOT_SHAPES) {
    for (const pct of [10, 25, 50, 75, 90]) {
      const d = Math.round((pct / 100) * 255);
      const ht = E.halftone(F.uniform(w, h, d), w, h, { inputPpi: 360, lpi: 36, angle: 22.5, dot });
      let on = 0;
      for (const v of ht.data) if (v) on++;
      const got = (100 * on) / (w * h);
      assert.ok(Math.abs(got - (100 * d) / 255) < 1.5, `${dot} ${pct}%: got ${got.toFixed(2)}%`);
    }
  }
});

test('halftone is 36 lines per inch', () => {
  // At 0 degrees and 360 ppi a 36 lpi cell is exactly 10 px, so the pattern repeats every 10 px.
  const w = 360;
  const ht = E.halftone(F.uniform(w, w, 60), w, w, { inputPpi: 360, lpi: 36, angle: 0 });
  for (let y = 0; y < w; y++) {
    for (let x = 0; x + 10 < w; x++) assert.equal(ht.data[y * w + x], ht.data[y * w + x + 10]);
  }
  // At 22.5 degrees count the dots: one inch square should hold ~36 x 36 of them.
  const size = 1440; // 4 x 4 inches at 360 ppi
  const rot = E.halftone(F.uniform(size, size, 50), size, size, { inputPpi: 360, lpi: 36, angle: 22.5 });
  const dots = countBlobs(rot.data, size, size);
  const perSqIn = dots / 16;
  assert.ok(Math.abs(perSqIn - 36 * 36) / (36 * 36) < 0.03, `dots per sq in: ${perSqIn}`);
});

test('dots too small to hold are dropped, near-solids fill in', () => {
  const w = 200;
  const light = E.halftone(F.uniform(w, w, 8), w, w, { inputPpi: 360, minDot: 0.05 }); // 3%
  assert.ok(light.data.every((v) => v === 0));
  const dark = E.halftone(F.uniform(w, w, 247), w, w, { inputPpi: 360, maxDot: 0.95 }); // 97%
  assert.ok(dark.data.every((v) => v === 255));
});

test('halftone can render in strips and upsample for film', () => {
  const w = 300;
  const h = 200;
  const src = new Uint8Array(w * h).map((_, i) => (i % w) * 0.85);
  const whole = E.halftone(src, w, h, { inputPpi: 150, outputPpi: 300 });
  assert.equal(whole.width, 600);
  assert.equal(whole.height, 400);
  const top = E.halftone(src, w, h, { inputPpi: 150, outputPpi: 300, rows: [0, 123] });
  const rest = E.halftone(src, w, h, { inputPpi: 150, outputPpi: 300, rows: [123, 400] });
  assert.deepEqual(Buffer.concat([top.data, rest.data]), Buffer.from(whole.data));
});

function countBlobs(data, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = [];
  let count = 0;
  // Ignore blobs touching the border so partial dots aren't counted twice.
  for (let i = 0; i < w * h; i++) {
    if (!data[i] || seen[i]) continue;
    let edge = false;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h || seen[q] || !data[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    count += edge ? 0.5 : 1;
  }
  return count;
}

test('film sheet: art centered under the marks, label readable width', () => {
  const layout = E.planSheet(3000, 3600, 300);
  assert.equal(layout.width, 3900);
  assert.equal(layout.height, 5700);
  assert.equal(layout.artLeft, 450);
  assert.ok(layout.fits);
  assert.ok(!E.planSheet(3800, 3600, 300).fits); // wider than 12.5 in
  assert.ok(!E.planSheet(3000, 5400, 300).fits); // taller than 17.5 in

  const marks = E.sheetMarks(layout, 'JOB | 1 OF 3 | BASE | 36 LPI 22.5 DEG ROUND');
  // Every mark and every letter sits above the art.
  for (const r of marks.rects) assert.ok(r.y1 <= layout.artTop + 2, JSON.stringify(r));
  const solid = { width: 3000, height: 3600, renderRows: (a, b) => new Uint8Array(3000 * (b - a)).fill(255) };
  const rows = E.renderSheetRows(layout, solid, marks, 0, layout.artTop + 10);
  // Art starts exactly at artTop / artLeft.
  assert.equal(rows[layout.artTop * 3900 + 450], 255);
  assert.equal(rows[layout.artTop * 3900 + 449], 0);
  assert.equal(rows[(layout.artTop - 1) * 3900 + 1000], 0);
});

test('off-black art background on a black shirt prints nothing', () => {
  // Art mocked up on #141414 while the shirt is set to pure black.
  const img = F.darkShirt();
  const plan = E.planScreens(img, { substrate: [0, 0, 0] });
  assert.equal(plan.background.hex, '#141414');
  assert.deepEqual(hexes(plan.inks), ['#FFD100', '#FFFFFF']);
  const dens = E.screenDensities(img, plan);
  const corner = 10 * img.width + 10;
  for (const d of dens) assert.equal(d[corner], 0);
});
