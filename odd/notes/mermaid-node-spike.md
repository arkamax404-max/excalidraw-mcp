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

## T4 addendum 2: native ER and subgraph conversion (id-prefix shim)

This addendum **supersedes residual risk 3 and the earlier "subgraphs must be
flattened" conclusion**.

Root cause, measured: mermaid 11 renders every DOM id **prefixed by the render
id** (e.g. a subgraph `zona` renders as an element whose id ends with
`-zona`; a probe ER render produced `probeER-entity-A-0`).
`@excalidraw/mermaid-to-excalidraw@2.2.2` looks ids up **unprefixed**, and
with two different quote styles that both miss:

- ER entities: `containerEl.querySelector('[id="${entity.id}"]')` —
  `dist/parser/er.js:185`, double quotes. The miss throws
  `ER entity … not found in rendered SVG`, which the library swallows into its
  single placeholder-image fallback — so every `erDiagram` failed.
- Subgraphs: `containerEl.querySelector("[id='${data.id}']")` —
  `dist/parser/flowchart.js:109`, single quotes. Same silent fallback.
- Edges: `containerEl.querySelector('path[id="${edge.id}"][data-edge="true"]')`
  — same shape plus attribute filters.

Fix, in `src/scene/dom-shim.ts`: `installDomShim()` now patches
`Element.prototype.querySelector`/`querySelectorAll` with a one-shot
selector-compatibility fallback — when the exact lookup returns nothing, every
`[id="X"]` / `[id='X']` in the selector is rewritten to the suffix match
`[id$="-X"]` and the lookup is retried once. An exact match always wins;
selectors without `[id=…]` are untouched; a failed rewrite returns the original
empty result. The patch is idempotent and installed once for every consumer.

Consequence for `src/scene/mermaid.ts`: the strict parse now handles **every**
subgraph fixture, so the `subgraph … end` flattening retry and its metadata
fields (`mode` / `removedSubgraphBlocks`) were **removed** — parsing is strict,
with no fallback path; metadata reports only `skeletonElementCount` and
`elementCount`.

New fixtures (`src/scene/fixtures.ts`) and measured numbers after the fix:

| Fixture | Skeleton elements | Scene elements | Element types | Placeholder image |
| --- | --- | --- | --- | --- |
| ER: attributes, keys, relationship + self-relationship | 41 | 47 | rectangle, line, arrow, text | no |
| flowchart with one subgraph | 9 | 14 | rectangle, arrow, text | no |
| flowchart with nested subgraphs | 10 | 16 | rectangle, arrow, text | no |

(Previously each of these collapsed into the single placeholder image and
erDiagram surfaced as `MermaidParseError`.)

The selector fallback itself is pinned by unit tests on a synthetic document
(`src/scene/dom-shim.test.ts`); the end-to-end conversions by
`src/scene/mermaid.test.ts`.

## T5 addendum: ER diagrams get their own layout (dependency ER path retired)

The id-prefix shim (T4 addendum 2) made `erDiagram` *parse* through the
dependency — and exposed that the dependency's ER geometry is unusable
server-side.

Root cause, measured: `dist/parser/er.js` derives every entity rectangle's
position and size from the **rendered SVG** (`getBBox` plus accumulated
transforms) and every relationship from rendered path points. Under this
project's DOM shim that geometry is fabricated — `getBBox` returns
`{x: 0, y: 0, approximate width}` for every node — so the ER scene came out
illegible (reproduced locally on the repo fixture set; the task's wider
reproduction measured 4 entity boxes of width 868/1332/604/608 with 3 of 6
pairs overlapping and 26 of 35 attribute texts overlapping):

| Metric (ER fixture: attributes, keys, rel + self-rel) | Dependency path (before) | Own layout (after) |
| --- | --- | --- |
| entity rectangles | 3 | 3 |
| rectangle overlaps | 0 | **0** |
| negative-coordinate elements | 35 | **0** |
| attribute texts fully inside their box | 0 of 6 | **6 of 6** |
| arrows | 3 | 3 |
| zero-size arrows | 2 | **0** |
| placeholder image elements | 0 | 0 |

(Red test evidence: with the tests in `src/scene/er.test.ts` written first,
all six ER fixtures failed on the dependency path — `negativeCoordinates`
12–35 per fixture, `attributeTextsInsideBoxes` 0 vs expected, and zero-size
arrows on every fixture with relationships.)

Flowcharts are unaffected because dagre's layout inside mermaid's flowchart db
supplies real coordinates; the ER db does not.

Fix: `src/scene/er.ts` reads the ER model straight from mermaid
(`mermaid.mermaidAPI.getDiagramFromText(text)` → `diagram.type === "er"` →
`db.getData()`, which joins entities, attributes, relationship endpoints,
cardinality arrow types and labels in one call) and computes the geometry
itself: entities on a row-major grid with `ceil(sqrt(n))` columns, boxes sized
from the text they contain using the same shim measurement the converter uses
(`canvasTextWidth`), attribute texts as free text elements inside their box,
one arrow per relationship with a deliberate ±12px spread so width and height
are both non-zero, self-relationships as a bulge out of the box's right edge,
and relationship labels as free text anchored near the arrow — never bound to
it (residual risk 4 above). `src/scene/mermaid.ts` routes on mermaid's own
diagram-type detection; a failed detection falls through to the generic path,
so genuinely invalid input still raises the typed parse error.

Deliberate simplifications (recorded, not hidden):

1. `direction LR/TB` (`db.getDirection()`) is not consumed — the grid is
   direction-agnostic.
2. An arrow between entities far apart in the grid is drawn as a straight line
   and may cross boxes it does not connect; only adjacency corridors are
   guaranteed clear (labels are clamped into their corridor).
3. Relationship labels are anchored near the arrow's start corridor rather
   than centered on the whole arrow, so multi-column spans keep the label in
   clear space.
