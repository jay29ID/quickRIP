#!/usr/bin/env node
'use strict';

// Runs the quickRIP engine on a PNG outside Photoshop.
//
//   node tools/cli.js art.png [--colors 4] [--shirt 141414] [--base] [--lpi 36]
//                     [--angle 22.5] [--dot round] [--ppi 300] [--film-ppi 360] [--out dir]
//
// Writes one film positive per screen (black = ink), a halftoned preview of
// the print, and analysis.json with the color count and fit per screen count.

const fs = require('fs');
const path = require('path');
const E = require('../src/engine');
const { decodePng, encodePng } = require('./png');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) args._.push(a);
    else if (a === '--base') args.base = true;
    else if (a === '--no-base') args.base = false;
    else args[a.slice(2)] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args._[0];
  if (!input) {
    console.error('usage: node tools/cli.js art.png [--colors N] [--shirt RRGGBB] [--base] [--lpi 36] [--out dir]');
    process.exit(1);
  }
  const image = decodePng(fs.readFileSync(input));
  const ppi = Number(args.ppi || image.ppi || 300);
  const filmPpi = Number(args['film-ppi'] || ppi);
  const substrate = args.shirt ? E.parseHex(args.shirt) : [255, 255, 255];
  const outDir = args.out || path.join(path.dirname(input), path.basename(input, '.png') + '-seps');
  fs.mkdirSync(outDir, { recursive: true });

  const t0 = Date.now();
  const plan = E.planScreens(image, {
    substrate,
    inkCount: args.colors ? Number(args.colors) : undefined,
    underbase: args.base,
  });
  const { analysis } = plan;
  console.log(`${image.width}x${image.height} px at ${ppi} ppi`);
  console.log(`suggested colors: ${analysis.suggestedCount} (max ${analysis.maxInks})`);
  for (const f of analysis.fits) {
    if (f) console.log(`  ${f.count} colors: avg error dE ${f.meanDeltaE}  ${f.inks.map((i) => i.hex).join(' ')}`);
  }

  const densities = E.screenDensities(image, plan);
  const htOpts = {
    lpi: Number(args.lpi || 36),
    angle: Number(args.angle ?? 22.5),
    dot: args.dot || 'round',
    inputPpi: ppi,
    outputPpi: filmPpi,
  };
  const films = plan.screens.map((screen, i) => {
    const ht = E.halftone(densities[i], image.width, image.height, htOpts);
    const film = new Uint8Array(ht.data.length);
    for (let p = 0; p < film.length; p++) film[p] = 255 - ht.data[p];
    const file = `${String(i + 1).padStart(2, '0')}-${screen.kind === 'base' ? 'base' : screen.hex.slice(1)}.png`;
    fs.writeFileSync(path.join(outDir, file), encodePng({ width: ht.width, height: ht.height, data: film, channels: 1, ppi: filmPpi }));
    return { screen, ht, file };
  });

  // Print preview: lay each halftoned screen down in print order on the shirt color.
  const { width, height } = films[0].ht;
  const preview = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) preview.set(substrate, p * 3);
  for (const { screen, ht } of films) {
    for (let p = 0; p < width * height; p++) if (ht.data[p]) preview.set(screen.rgb, p * 3);
  }
  fs.writeFileSync(path.join(outDir, 'preview.png'), encodePng({ width, height, data: preview, channels: 3, ppi: filmPpi }));

  fs.writeFileSync(
    path.join(outDir, 'analysis.json'),
    JSON.stringify({ ...analysis, screens: plan.screens, films: films.map((f) => f.file), halftone: htOpts }, null, 2)
  );
  console.log(`screens: ${plan.screens.map((s) => s.name).join(', ')}`);
  console.log(`wrote ${films.length} films + preview to ${outDir} in ${Date.now() - t0} ms`);
}

main();
