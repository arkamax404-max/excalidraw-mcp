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
