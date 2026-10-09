/**
 * Minimal DOM shim that lets `@excalidraw/mermaid-to-excalidraw` and the
 * Excalidraw element converter run under Node without a browser.
 *
 * jsdom provides the DOM tree, but it implements neither SVG layout nor canvas.
 * The two stubs below are therefore load-bearing:
 *
 * 1. `SVGElement.getBBox()` drives mermaid's node sizing. jsdom always returns
 *    zeroes, which collapses every node to its minimum size and wraps labels.
 * 2. `HTMLCanvasElement.getContext("2d")` returns `null` in jsdom, and the
 *    Excalidraw bundle probes `"filter" in ctx` at module load.
 *
 * Every numeric constant here is a fidelity knob, not a verified measurement.
 * Calibration against fixture diagrams is owned by the `mermaid to scene`
 * task (T4) of `odd/tasks/excalidraw-mcp.md`.
 */

import { JSDOM } from "jsdom";

/** Font size mermaid lays out with when the caller does not override it. */
export const DEFAULT_FONT_SIZE = 20;

/** Glyphs that are visibly wider than average in hand-drawn Excalifont. */
const WIDE_GLYPHS = "mwMW@%";

/** Baseline advance width per glyph, as a fraction of the font size. */
const NODE_GLYPH_FACTOR = 0.465;
const TEXT_GLYPH_FACTOR = 0.4275;

/** Constant slack added to every measurement, in px. */
const NODE_SLACK = 0;
const TEXT_SLACK = 2;

const collapse = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const glyphUnits = (text) => {
  let units = 0;
  for (const glyph of String(text ?? "")) {
    if (glyph === "\n") continue;
    units += WIDE_GLYPHS.includes(glyph) ? 1.35 : 1;
  }
  return units;
};

/** Width mermaid sees when it sizes a node from its label. */
export const nodeLabelWidth = (text, fontSize = DEFAULT_FONT_SIZE) =>
  glyphUnits(text) * fontSize * NODE_GLYPH_FACTOR + NODE_SLACK;

/** Width the canvas stub reports for the text element itself. */
export const canvasTextWidth = (text, fontSize = DEFAULT_FONT_SIZE) =>
  glyphUnits(text) * fontSize * TEXT_GLYPH_FACTOR + TEXT_SLACK;

const exposeGlobal = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    // A read-only global (navigator) that jsdom cannot replace is not fatal.
  }
};

const makeContext2d = () => {
  const noop = () => {};
  const target = {
    measureText: (text) => {
      const width = canvasTextWidth(text);
      return {
        width,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
      };
    },
    getImageData: (_x, _y, width = 1, height = 1) => ({
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

/**
 * Installs the browser globals the conversion pipeline expects.
 * Returns the jsdom instance so callers can tear it down.
 */
export const installDomShim = ({ html = "<!doctype html><html><body></body></html>" } = {}) => {
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
    window.requestAnimationFrame || ((callback) => setTimeout(() => callback(Date.now()), 0)),
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
      constructor(family, source) {
        this.family = family;
        this.source = source;
      }
      load() {
        return Promise.resolve(this);
      }
    },
  );
  exposeGlobal(
    "OffscreenCanvas",
    class OffscreenCanvas {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
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

  return dom;
};
