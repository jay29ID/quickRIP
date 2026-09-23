#!/usr/bin/env node
'use strict';
// Writes the synthetic test art to samples/ as PNGs for trying the CLI.
const fs = require('fs');
const path = require('path');
const F = require('../test/fixtures');
const { encodePng } = require('./png');
const dir = path.join(__dirname, '..', 'samples');
fs.mkdirSync(dir, { recursive: true });
for (const name of ['spot3', 'gradient', 'sixColors', 'darkShirt', 'photo']) {
  const img = F[name]();
  fs.writeFileSync(path.join(dir, `${name}.png`), encodePng({ ...img, ppi: 150 }));
}
console.log(`wrote samples to ${dir}`);
