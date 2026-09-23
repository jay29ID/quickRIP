'use strict';

// quickRIP panel. Deliberately simple for now: the full shop panel comes next.

const E = require('./src/engine/index.js');
const { analyzeActiveDocument, separateActiveDocument } = require('./src/photoshop/adapter.js');

const $ = (id) => document.getElementById(id);
let analysis = null;

function shirtColor() {
  try {
    return E.parseHex($('shirt').value.trim());
  } catch (e) {
    throw new Error('Shirt color should be a hex code like FFFFFF or 141414.');
  }
}

function status(text) {
  $('status').textContent = text;
}

function showSwatches() {
  const box = $('swatches');
  box.innerHTML = '';
  if (!analysis || !analysis.fits.length) return;
  const n = Number($('count').value);
  const fit = analysis.fits[Math.min(n, analysis.maxInks)];
  for (const ink of fit.inks) {
    const row = document.createElement('div');
    row.className = 'swatch';
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.style.backgroundColor = ink.hex;
    const label = document.createElement('span');
    label.textContent = `${ink.hex}  ${(ink.share * 100).toFixed(1)}% of art`;
    row.append(chip, label);
    box.append(row);
  }
  const note = document.createElement('div');
  note.className = 'muted';
  note.textContent = `Color match at ${fit.count}: avg error ${fit.meanDeltaE} dE`;
  box.append(note);
}

$('analyze').addEventListener('click', async () => {
  try {
    status('Counting colors…');
    const substrate = shirtColor();
    analysis = await analyzeActiveDocument({ substrate });
    if (!analysis.fits.length) {
      $('suggest').textContent = 'No ink found: the art matches the shirt color.';
      return status('');
    }
    $('suggest').textContent = `Suggested: ${analysis.suggestedCount} color${analysis.suggestedCount === 1 ? '' : 's'}`;
    $('count').value = String(Math.max(1, analysis.suggestedCount));
    $('base').checked = analysis.darkSubstrate;
    showSwatches();
    status('');
  } catch (e) {
    status(e.message);
  }
});

$('count').addEventListener('change', showSwatches);

$('separate').addEventListener('click', async () => {
  try {
    const substrate = shirtColor();
    const settings = {
      substrate,
      inkCount: Number($('count').value),
      underbase: $('base').checked,
      analysis: analysis && analysis.substrate.hex === E.toHex(substrate) ? analysis : undefined,
      lpi: Number($('lpi').value) || 36,
      angle: Number($('angle').value),
      dot: $('dot').value,
      filmPpi: Number($('filmPpi').value) || undefined,
      layerColor: $('layerColor').value,
    };
    const result = await separateActiveDocument(settings, (v, text) => status(`${text}… ${Math.round(v * 100)}%`));
    status(`Done: ${result.plan.screens.length} screens at ${settings.lpi} lpi, ${result.filmPpi} ppi.`);
  } catch (e) {
    status(e.message);
  }
});
