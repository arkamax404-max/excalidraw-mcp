# Spike: Mermaid to Excalidraw scene under Node

Task: T1 of `odd/tasks/excalidraw-mcp.md`. Question: can the MCP turn Mermaid text
into an Excalidraw scene server-side, with no browser?

## Verdict

**Yes, with a DOM shim.** Variant (b) of the spike plan: jsdom plus three stubs, and
the Excalidraw converter supplied as a prebuilt esbuild bundle.

| Variant | Result |
| --- | --- |
| (a) plain Node, no DOM | Fails. `parseMermaidToExcalidraw` throws `TypeError: DOMPurify.addHook is not a function`, then `element.node(...).getBBox is not a function`. |
| (b) jsdom + shims | **Works.** 12 skeleton elements parsed, 21 Excalidraw elements converted, all with valid ids. |
| (c) give up | Not needed. |

## What each blocker was

1. **DOMPurify needs a window.** Mermaid sanitizes SVG through DOMPurify, which
   requires a real `window.document`. Fixed by installing jsdom globals before the
   dynamic `import()` of the mermaid packages.
2. **jsdom has no SVG layout.** Mermaid measures labels with
   `SVGGraphicsElement.getBBox()`, which jsdom does not implement. Stubbed in
   `scripts/lib/dom-shim.mjs`. This stub is also what drives **node sizing**, so its
   width model is a layout-fidelity knob, not a formality.
3. **jsdom has no canvas.** `HTMLCanvasElement.getContext("2d")` returns `null`, and
   the Excalidraw bundle evaluates
   `"filter" in document.createElement("canvas").getContext("2d")` at module load,
   which throws `TypeError: Cannot use 'in' operator to search for 'filter' in null`.
   Fixed with a Proxy-based 2D context stub.
4. **`@excalidraw/excalidraw` cannot be imported as ESM under Node.** Its dist imports
   `open-color/open-color.json` without the `type: "json"` attribute Node requires,
   and its `exports` map rejects every deep runtime path (`./element` is types-only).
   Bundling with esbuild inlines that JSON exactly as the Vite browser build does.
   `react` and `react-dom` must be bundled in as well: with them external, the bundle
   throws `Error: Dynamic require of "react" is not supported`.
5. **`react` is gone after `npm install` reconcile.** The dependency tree must keep
   `react`, `react-dom`, `esbuild` and `jsdom` declared, or the bundle build and the
   shim break.

## Working configuration

- Shim globals: `window`, `document`, `DOMParser`, `XMLSerializer`, `HTMLElement`,
  `Element`, `Node`, `NodeList`, `SVGElement`, `SVGSVGElement`, `getComputedStyle`,
  `MutationObserver`, `CustomEvent`, `Event`, `Image`, `HTMLCanvasElement`,
  `CSSStyleSheet`, `navigator`, `devicePixelRatio`, `requestAnimationFrame`,
  `matchMedia`, `FontFace`, `OffscreenCanvas`, `document.fonts`, plus the
  `SVGElement.prototype.getBBox` and `HTMLCanvasElement.prototype.getContext` stubs.
- Import paths: `@excalidraw/mermaid-to-excalidraw` (public entry) and the bundled
  `dist/vendor/excalidraw-converter.mjs` built from `scripts/converter-entry.mjs`.
- `mermaid` is pinned to **11.15.0** to match the fork. With 11.17.2 the DOM ids
  changed shape and the result was identical failure; pinning also keeps the generated
  elements aligned with what the fork renders.

## Evidence

```
$ npm run spike:mermaid
{
  "ok": true,
  "sceneShapeValid": true,
  "skeletonElementCount": 12,
  "elementCount": 21,
  "elementTypes": ["arrow", "diamond", "rectangle", "text"],
  "invalidIdCount": 0,
  "textCount": 9,
  "wrappedTextCount": 6,
  "overflowingTextCount": 2,
  "wrappedSamples": ["\"Clien\\nte\"", "\"A\\nP\\nI\"", "\"Va\\nli\\ndo\\n?\"", "\"Postgr\\nes\"", "\"Err\\nor\""]
}
```

`npm run build` is clean and `npm test` passes with zero tests at this stage.

## Residual risk carried into `src/scene/mermaid.ts` (T4)

1. **`jsdom` must be a runtime dependency,** not a devDependency: the MCP server
   installs the shim before loading the conversion pipeline. It costs roughly 340
   packages and a ~14 MB converter bundle in `dist/vendor/`.
2. **Label wrapping is uncalibrated.** 6 of 9 texts wrapped on the fixture, and the
   outcome did not move monotonically with the measurement constants tried
   (`getBBox` width is what mermaid uses for node sizing; the canvas stub is what the
   library uses for the text element). T4 owns this with a fixture harness and
   acceptance criteria, not guesswork.
3. **Subgraphs are broken in the dependency, not in the shim.** `parseSubGraph`
   looks up `containerEl.querySelector("[id='<subgraphId>']")`, while mermaid 11.15
   renders ids prefixed by the render id (`<renderId>-Almacen`), so the lookup can
   never match and the library falls back to a single placeholder image element. T4
   must flatten or reject `subgraph ... end` blocks before parsing, and report which
   path it took.
4. **Labels bound to vertical arrows overflow** (the arrow bounding box is 0 wide).
   Same class of library limitation; T4 decides between unbinding the label and
   reporting the limitation.
5. **`import()` order is load-bearing.** The shim must be installed before any dynamic
   import of the mermaid or Excalidraw modules; static imports would be hoisted too
   early.

## T4 addendum: production port and label calibration

The prototype became `src/scene/dom-shim.ts` + `src/scene/mermaid.ts` (this spike now
imports the production shim, so it keeps proving the real code path). The pipeline
strict-parses first; on failure — including the dependency's silent subgraph fallback,
which surfaces as a single placeholder `image` element at conversion time, not as a
thrown error — it retries once with `subgraph ... end` blocks flattened away and
reports the path via `metadata.mode`.

Final measurement constants (in `src/scene/dom-shim.ts`):

| Constant | Value | Role |
| --- | --- | --- |
| `NODE_GLYPH_FACTOR` | 0.6 | `getBBox` width per glyph-unit × font size (node sizing) |
| `NODE_SLACK` | 24 px | constant added to every node measurement |
| `TEXT_GLYPH_FACTOR` | 0.14 | canvas `measureText` width per glyph-unit × font size |
| `TEXT_SLACK` | 2 px | constant added to every text measurement |

The node factor must dominate the text factor by a wide margin: wrapping and overflow
are both triggered by a bound text measuring wider than its container.

Per-fixture calibration table (harness: `src/scene/mermaid.test.ts`, "label layout
calibration"):

| Fixture | Elements | wrappedTextCount | overflowingTextCount | Acceptance |
| --- | --- | --- | --- | --- |
| chain of plain rectangles | 8 | 0 | 0 | zero-wrapped — met |
| rectangle with two-word label | 5 | 0 | 0 | zero-wrapped — met |
| ellipse (circle) nodes | 5 | 0 | 0 | zero-wrapped — met |
| decision diamond | 10 | 0 | 0 | recorded — passes with these constants, not guaranteed |
| edge label on a horizontal arrow | 6 | 0 | 0 | zero-wrapped — met (44 px text in a 46 px arrow, tight) |

### Limitations that remain (measured, not fixed)

1. **Edge labels bound to vertical arrows overflow.** The spike fixture still reports
   `overflowingTextCount: 2` (label `"HTTP"` in a 0 px-wide vertical arrow, `"no"` in an
   8 px one). A vertical arrow's bounding box is ~0 px wide, so no text measurement can
   fit inside it; fixing this needs label unbinding in the converter output, which is a
   structural change the dependency does not offer. Horizontal arrows are fine with the
   calibrated constants.
2. **Diamonds and other non-rect/ellipse containers are not guaranteed.** The decision
   diamond fixture currently measures 0/0, but its usable width depends on the label
   itself; the harness records it instead of asserting it.
3. **The horizontal-arrow margin is thin** (44 px text vs 46 px arrow for
   `"envia solicitud"`). Longer edge labels on short arrows can still overflow; the
   pre-flight `maxEdges`/`maxTextSize` checks do not cover label length.
