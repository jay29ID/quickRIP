# quickRIP

Screen-print color separations inside Photoshop. quickRIP looks at RGB or CMYK
artwork, works out how many ink colors it needs, lets you pick 1 to 7 color
screens (one press head stays free for the base), and builds a new document with
one halftoned layer per screen at 36 lpi.

## What it does

1. **Counts colors.** Clusters the art's colors, folds tints and gradients into
   the ink they come from (a red-to-white fade is one red screen), and ignores the
   shirt color. It suggests the fewest screens that match the art.
2. **Keeps the most important colors for your count.** Ask for 4 and it keeps the
   4 inks that reproduce the art best. It works this out by dropping, one at a
   time, the ink whose loss hurts the match least.
3. **Separates.** Every pixel is printed as a tint of one ink. On dark shirts a
   base screen is added under the art, choked 1 px.
4. **Halftones.** AM dots at 36 lpi, 22.5° by default (round, ellipse, square,
   diamond or line). Dots under 5% are dropped and dots over 95% print solid, so
   nothing is too fine to hold on the screen. Anti-aliased edges of solid shapes
   are cut clean instead of screened.

Your original document is never touched. The output is a new document named
"<art> seps" with a Shirt layer, then one layer per screen in print order: base
first, then light to dark, with highlight white last on dark shirts.

## Install for development

1. Install the **UXP Developer Tool** from Creative Cloud.
2. Click **Add Plugin** and choose this folder's `manifest.json`.
3. Click **Load**. In Photoshop, open **Plugins > quickRIP**.

Needs Photoshop 2023 (24.2) or newer.

## Try it without Photoshop

```
npm test                               # engine and plugin tests
npm run samples                        # writes sample art to samples/
node tools/cli.js samples/spot3.png    # films + preview + analysis.json
node tools/cli.js art.png --colors 4 --shirt 141414 --film-ppi 600
```

The CLI reads 8-bit PNGs. It writes one film per screen (black = ink), a
halftoned `preview.png`, and `analysis.json` with the suggested count and the best
inks for each count.

## Layout

- `src/engine/`: the separation engine, plain JavaScript with no Photoshop calls.
  - `analyze.js` counts colors and ranks them by importance
  - `separate.js` splits pixels into per-ink density maps
  - `halftone.js` handles AM screening: lpi, angle, dot shape, min/max dot
  - `underbase.js` builds the base screen
- `src/photoshop/adapter.js`: reads the document and writes the separations document.
- `index.html`, `index.js`: the panel.
- `tools/`: CLI and a dependency-free PNG reader/writer.
- `test/`: engine tests, and plugin tests against a fake Photoshop.

## Notes

- Film resolution defaults to the document's resolution, or 300 ppi if the
  document is lower. At 36 lpi, 300 ppi gives about 70 gray levels per dot. Use
  600 for smoother dots on film.
- Colors are read through Photoshop's own conversion to sRGB, so CMYK and 16-bit
  documents work.
