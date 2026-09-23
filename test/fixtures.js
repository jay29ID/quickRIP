'use strict';

// Synthetic test art. Shapes are 4x4 supersampled so edges are anti-aliased
// like real artwork.

const { parseHex, cmykToRgb } = require('../src/engine/color');

function render(width, height, background, paint) {
  const data = new Uint8Array(width * height * 4);
  const SS = 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = paint(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS) || background;
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const i = (y * width + x) * 4;
      data[i] = Math.round(r / (SS * SS));
      data[i + 1] = Math.round(g / (SS * SS));
      data[i + 2] = Math.round(b / (SS * SS));
      data[i + 3] = 255;
    }
  }
  return { width, height, data, channels: 4 };
}

const RED = parseHex('#D7263D');
const BLUE = parseHex('#1B4F9C');
const BLACK = parseHex('#111111');
const WHITE = [255, 255, 255];

/** Three solid spot colors on white: red circle, blue box, black bar. */
function spot3() {
  return render(600, 400, WHITE, (x, y) => {
    if ((x - 150) ** 2 + (y - 180) ** 2 < 100 ** 2) return RED;
    if (x > 300 && x < 550 && y > 50 && y < 330) return BLUE;
    if (y > 355 && y < 380 && x > 40 && x < 560) return BLACK;
    return null;
  });
}

/** White-to-red fade over a solid black band: 2 inks, the red one needs halftones. */
function gradient() {
  const red = parseHex('#C8102E');
  return render(500, 300, WHITE, (x, y) => {
    if (y < 200) {
      const t = Math.min(1, x / 480);
      return WHITE.map((w, k) => w + (red[k] - w) * t);
    }
    if (y > 230 && y < 280) return BLACK;
    return null;
  });
}

/** Six spot colors with very different areas, for "pick the most important N". */
const SIX = [
  { hex: '#D7263D', area: 0.30 },
  { hex: '#1B4F9C', area: 0.22 },
  { hex: '#111111', area: 0.16 },
  { hex: '#F4C20D', area: 0.12 },
  { hex: '#2E9E44', area: 0.07 },
  { hex: '#8E44AD', area: 0.03 },
];
function sixColors() {
  const w = 800;
  const h = 200;
  const cols = [];
  let x0 = 0;
  for (const s of SIX) {
    const x1 = x0 + s.area * w;
    cols.push({ x0, x1, rgb: parseHex(s.hex) });
    x0 = x1;
  }
  return render(w, h, WHITE, (x, y) => {
    if (y < 20 || y > 180) return null;
    for (const c of cols) if (x >= c.x0 && x < c.x1) return c.rgb;
    return null;
  });
}

/** White and yellow art for a black shirt. */
const SHIRT_BLACK = [20, 20, 20];
function darkShirt() {
  const yellow = parseHex('#FFD100');
  return render(500, 400, SHIRT_BLACK, (x, y) => {
    if ((x - 250) ** 2 + (y - 170) ** 2 < 110 ** 2) return yellow;
    if (y > 310 && y < 360 && x > 60 && x < 440) return WHITE;
    return null;
  });
}

/** Continuous-tone "photo": many colors, should get capped at 7 screens. */
function photo() {
  return render(300, 300, WHITE, (x, y) => [
    128 + 127 * Math.sin(x / 23),
    128 + 127 * Math.sin(y / 31 + 1),
    128 + 127 * Math.sin((x + y) / 41 + 2),
  ]);
}

/** spot3 built from CMYK values, as it would come out of a CMYK document. */
function spot3Cmyk() {
  const inks = {
    red: [0, 230, 180, 20],
    blue: [230, 150, 0, 40],
    black: [0, 0, 0, 240],
  };
  return render(600, 400, WHITE, (x, y) => {
    if ((x - 150) ** 2 + (y - 180) ** 2 < 100 ** 2) return cmykToRgb(...inks.red);
    if (x > 300 && x < 550 && y > 50 && y < 330) return cmykToRgb(...inks.blue);
    if (y > 355 && y < 380 && x > 40 && x < 560) return cmykToRgb(...inks.black);
    return null;
  });
}

function uniform(width, height, value) {
  return new Uint8Array(width * height).fill(value);
}

module.exports = { spot3, gradient, sixColors, SIX, darkShirt, SHIRT_BLACK, photo, spot3Cmyk, uniform, RED, BLUE, BLACK };
