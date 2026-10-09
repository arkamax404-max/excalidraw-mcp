/**
 * Minimal DOM shim that lets `@excalidraw/mermaid-to-excalidraw` and the
 * Excalidraw element converter run under Node without a browser.
 *
 * TypeScript port of the original `scripts/lib/dom-shim.mjs` spike shim; the
 * spike (`scripts/spike-mermaid.mjs`) now imports this module so the spike
 * keeps proving the real production code path.
 *
 * jsdom provides the DOM tree, but it implements neither SVG layout nor canvas.
 * The two stubs below are therefore load-bearing:
 *
 * 1. `SVGElement.getBBox()` drives mermaid's node sizing. jsdom always returns
 *    zeroes, which collapses every node to its minimum size and wraps labels.
 * 2. `HTMLCanvasElement.getContext("2d")` returns `null` in jsdom, and the
 *    Excalidraw bundle probes `"filter" in ctx` at module load.
 *
 * ORDERING CONSTRAINT (load-bearing): this shim must be installed BEFORE any
 * dynamic `import()` of the mermaid or Excalidraw modules. Static imports
 * would be hoisted above the installation and load the libraries against an
 * incomplete DOM (spike note, residual risk 5). `src/scene/mermaid.ts` calls
 * `installDomShim()` first and only then imports the libraries dynamically.
 *
 * The numeric constants below are the label-layout calibration knobs from T4,
 * tuned against `src/scene/fixtures.ts` (see the calibration table in
 * `odd/notes/mermaid-node-spike.md`).
 */

import { JSDOM } from "jsdom";

/** Font size mermaid lays out with when the caller does not override it. */
export const DEFAULT_FONT_SIZE = 20;

/** Glyphs that are visibly wider than average in hand-drawn Excalifont. */
const WIDE_GLYPHS = "mwMW@%";

/**
 * Baseline advance width per glyph, as a fraction of the font size.
 *
 * Calibration (T4): `NODE_GLYPH_FACTOR` sizes mermaid's nodes from their
 * labels (getBBox); `TEXT_GLYPH_FACTOR` sizes the text element itself
 * (canvas measureText). The node factor must stay comfortably above the text
 * factor — plus enough combined slack to absorb the library's own padding —
 * so that no bound label measures wider than its container, which is what
 * triggers both wrapping and overflow.
 */
export const NODE_GLYPH_FACTOR = 0.6;
export const TEXT_GLYPH_FACTOR = 0.14;

/** Constant slack added to every measurement, in px. */
export const NODE_SLACK = 24;
export const TEXT_SLACK = 2;

const collapse = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();

const glyphUnits = (text: unknown): number => {
  let units = 0;
  for (const glyph of String(text ?? "")) {
    if (glyph === "\n") continue;
    units += WIDE_GLYPHS.includes(glyph) ? 1.35 : 1;
  }
  return units;
};

/** Width mermaid sees when it sizes a node from its label. */
export const nodeLabelWidth = (text: unknown, fontSize: number = DEFAULT_FONT_SIZE): number =>
  glyphUnits(text) * fontSize * NODE_GLYPH_FACTOR + NODE_SLACK;

/** Width the canvas stub reports for the text element itself. */
export const canvasTextWidth = (text: unknown, fontSize: number = DEFAULT_FONT_SIZE): number =>
  glyphUnits(text) * fontSize * TEXT_GLYPH_FACTOR + TEXT_SLACK;

const exposeGlobal = (name: string, value: unknown): void => {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    // A read-only global (navigator) that jsdom cannot replace is not fatal.
  }
};

const makeContext2d = (): Record<string | symbol, unknown> => {
  const noop = (): void => {};
  const target: Record<string | symbol, unknown> = {
    measureText: (text: unknown) => {
      const width = canvasTextWidth(text);
      return {
        width,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
      };
    },
    getImageData: (_x: number, _y: number, width = 1, height = 1) => ({
      data: new Uint8ClampedArray(Math.max(4, width * height * 4)),
      width,
      height,
    }),
    createImageData: (width = 1, height = 1) => ({
      data: new Uint8ClampedArray(Math.max(4, width * height * 4)),
      width,
      height,
    }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getLineDash: () => [],
    setLineDash: noop,
    isPointInPath: () => false,
    save: noop, restore: noop, scale: noop, rotate: noop, translate: noop,
    transform: noop, setTransform: noop, resetTransform: noop, clip: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    bezierCurveTo: noop, quadraticCurveTo: noop, arc: noop, arcTo: noop,
    ellipse: noop, rect: noop, roundRect: noop, fill: noop, stroke: noop,
    fillRect: noop, strokeRect: noop, clearRect: noop,
    fillText: noop, strokeText: noop, drawImage: noop, putImageData: noop,
  };
  return new Proxy(target, {
    get: (source, property) => (property in source ? source[property] : undefined),
    set: (source, property, value) => {
      source[property] = value;
      return true;
    },
  });
};

let installedDom: JSDOM | undefined;

/**
 * Installs the browser globals the conversion pipeline expects.
 * Idempotent: repeated calls return the already-installed DOM instead of
 * piling a second jsdom over the first.
 * Returns the jsdom instance so callers can tear it down.
 */
export const installDomShim = ({ html = "<!doctype html><html><body></body></html>" } = {}): JSDOM => {
  if (installedDom) {
    return installedDom;
  }
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const { window } = dom;

  const passThrough = [
    "window", "document", "DOMParser", "XMLSerializer", "HTMLElement", "Element",
    "Node", "NodeList", "SVGElement", "SVGSVGElement", "getComputedStyle",
    "MutationObserver", "CustomEvent", "Event", "Image", "HTMLCanvasElement",
    "CSSStyleSheet",
  ];
  for (const name of passThrough) {
    exposeGlobal(name, window[name]);
  }

  exposeGlobal("navigator", window.navigator);
  exposeGlobal("devicePixelRatio", window.devicePixelRatio || 1);
  exposeGlobal(
    "requestAnimationFrame",
    window.requestAnimationFrame || ((callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0)),
  );
  exposeGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
  exposeGlobal(
    "FontFace",
    class FontFace {
      family: string;
      source: string;
      constructor(family: string, source: string) {
        this.family = family;
        this.source = source;
      }
      load(): Promise<this> {
        return Promise.resolve(this);
      }
    },
  );
  exposeGlobal(
    "OffscreenCanvas",
    class OffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext(): null {
        return null;
      }
    },
  );

  Object.defineProperty(window.document, "fonts", {
    value: {
      ready: Promise.resolve(),
      add() {},
      delete() {},
      forEach() {},
      check: () => true,
      size: 0,
    },
    configurable: true,
  });

  const svgPrototype = window.SVGElement.prototype;
  svgPrototype.getBBox = function getBBox() {
    return {
      x: 0,
      y: 0,
      width: Math.max(2, nodeLabelWidth(collapse(this.textContent))),
      height: DEFAULT_FONT_SIZE * 1.25,
    };
  };
  svgPrototype.getComputedTextLength = function getComputedTextLength() {
    return this.getBBox().width;
  };

  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    const context = makeContext2d();
    context.canvas = this;
    return context;
  };

  installedDom = dom;
  return dom;
};
