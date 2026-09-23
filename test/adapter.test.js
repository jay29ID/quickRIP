'use strict';

// Runs the Photoshop adapter against a fake `photoshop` module, to check the
// plumbing (reads, layer creation, strip writes) without Photoshop.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const F = require('./fixtures');

function fakePhotoshop(art, ppi) {
  const docs = [];
  const source = { id: 1, title: 'job.psd', width: art.width, height: art.height, resolution: ppi };
  const ps = {
    app: {
      activeDocument: source,
      documents: {
        async add(o) {
          const doc = { id: 100 + docs.length, ...o, layers: [] };
          doc.createPixelLayer = async (lo) => {
            const layer = { id: doc.layers.length + 1, ...lo, pixels: new Uint8Array(o.width * o.height * 4) };
            doc.layers.push(layer);
            return layer;
          };
          docs.push(doc);
          return doc;
        },
      },
    },
    core: {
      async executeAsModal(fn) {
        return fn({
          isCancelled: false,
          reportProgress() {},
          hostControl: { async suspendHistory() { return 7; }, async resumeHistory() {} },
        });
      },
    },
    constants: {
      NewDocumentMode: { RGB: 'RGBColorMode' },
      DocumentFill: { WHITE: 'white' },
      BlendMode: { NORMAL: 'normal' },
    },
    imaging: {
      async getPixels(o) {
        assert.equal(o.colorSpace, 'RGB');
        let img = art;
        if (o.targetSize) img = shrink(art, o.targetSize.width, o.targetSize.height);
        return {
          imageData: {
            width: img.width,
            height: img.height,
            components: 4,
            async getData() { return img.data; },
            dispose() {},
          },
        };
      },
      async createImageDataFromBuffer(buf, o) {
        assert.equal(buf.length, o.width * o.height * o.components);
        return { buf, ...o, dispose() {} };
      },
      async putPixels({ documentID, layerID, imageData, targetBounds }) {
        const doc = docs.find((d) => d.id === documentID);
        const layer = doc.layers.find((l) => l.id === layerID);
        const off = (targetBounds.top * doc.width + targetBounds.left) * 4;
        layer.pixels.set(imageData.buf, off);
      },
    },
  };
  return { ps, docs };
}

function shrink(img, w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.floor((x * img.width) / w);
      const sy = Math.floor((y * img.height) / h);
      data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data, channels: 4 };
}

function loadAdapter(ps) {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'photoshop') return ps;
    return orig.call(this, req, ...rest);
  };
  try {
    delete require.cache[require.resolve('../src/photoshop/adapter.js')];
    return require('../src/photoshop/adapter.js');
  } finally {
    Module._load = orig;
  }
}

test('Photoshop adapter builds a seps document with one layer per screen', async () => {
  const art = F.darkShirt();
  const { ps, docs } = fakePhotoshop(art, 150);
  const adapter = loadAdapter(ps);

  const analysis = await adapter.analyzeActiveDocument({ substrate: F.SHIRT_BLACK });
  assert.equal(analysis.suggestedCount, 2);

  const result = await adapter.separateActiveDocument({ substrate: F.SHIRT_BLACK, inkCount: 2, filmPpi: 300 });
  assert.equal(docs.length, 1);
  const doc = docs[0];
  assert.equal(doc.width, art.width * 2);
  assert.equal(doc.resolution, 300);
  assert.deepEqual(doc.layers.map((l) => l.name), ['Shirt', 'Base', 'Color 1 #FFD100', 'Color 2 #FFFFFF']);
  assert.equal(result.plan.screens.length, 3);

  // Center of the yellow circle: base and yellow screens both inked, white screen empty.
  const at = (layer, x, y) => layer.pixels[(y * doc.width + x) * 4 + 3];
  const [, base, yellow, white] = doc.layers;
  assert.equal(at(base, 500, 340), 255);
  assert.equal(at(yellow, 500, 340), 255);
  assert.equal(at(white, 500, 340), 0);
  // Every row of the film got written (strips cover the whole height).
  assert.equal(at(doc.layers[0], 0, doc.height - 1), 255);
});

test('Photoshop adapter can output black film layers', async () => {
  const { ps, docs } = fakePhotoshop(F.spot3(), 300);
  const adapter = loadAdapter(ps);
  await adapter.separateActiveDocument({ inkCount: 3, layerColor: 'black' });
  const layers = docs[0].layers.slice(1);
  assert.equal(layers.length, 3);
  for (const l of layers) {
    let inked = 0;
    for (let p = 0; p < l.pixels.length; p += 4) {
      if (l.pixels[p + 3]) {
        inked++;
        assert.equal(l.pixels[p] + l.pixels[p + 1] + l.pixels[p + 2], 0);
      }
    }
    assert.ok(inked > 0, `${l.name} is empty`);
  }
});
