/**
 * Feasibility spike: convert Mermaid to an Excalidraw scene under Node, with no
 * browser. Evidence for `odd/notes/mermaid-node-spike.md`.
 *
 * Run with `npm run spike:mermaid` (builds the converter bundle first).
 * Prints one JSON summary to stdout and exits non-zero on failure.
 */

import { installDomShim } from "./lib/dom-shim.mjs";

const FIXTURE = `flowchart TD
  A[Cliente] -->|HTTP| B[API]
  B --> C{Valido?}
  C -->|si| D[(Postgres)]
  C -->|no| E[Error]
  B --> F[Cache]
  F --> D
`;

const summarize = (elements) => {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const texts = elements.filter((element) => element.type === "text");
  const wrapped = texts.filter((element) => String(element.text ?? "").includes("\n"));
  const overflowing = texts.filter((element) => {
    const container = element.containerId ? byId.get(element.containerId) : null;
    return container ? element.width > container.width : false;
  });

  return {
    elementCount: elements.length,
    elementTypes: [...new Set(elements.map((element) => element.type))].sort(),
    invalidIdCount: elements.filter((element) => typeof element.id !== "string" || !element.id)
      .length,
    textCount: texts.length,
    wrappedTextCount: wrapped.length,
    overflowingTextCount: overflowing.length,
    wrappedSamples: wrapped.slice(0, 5).map((element) => JSON.stringify(element.text)),
  };
};

const fail = (stage, error) => {
  console.log(
    JSON.stringify(
      {
        ok: false,
        stage,
        error: { name: error?.constructor?.name, message: String(error?.message) },
      },
      null,
      2,
    ),
  );
  process.exit(1);
};

installDomShim();

let mermaidToExcalidraw;
try {
  mermaidToExcalidraw = await import("@excalidraw/mermaid-to-excalidraw");
} catch (error) {
  fail("import-mermaid-to-excalidraw", error);
}

let converter;
try {
  converter = await import("../dist/vendor/excalidraw-converter.mjs");
} catch (error) {
  fail("import-converter-bundle", error);
}

let skeletonElements;
try {
  const parsed = await mermaidToExcalidraw.parseMermaidToExcalidraw(FIXTURE, {
    maxEdges: 250,
    maxTextSize: 20000,
  });
  skeletonElements = parsed.elements;
} catch (error) {
  fail("parse-mermaid", error);
}

let elements;
try {
  elements = converter.convertToExcalidrawElements(skeletonElements, { regenerateIds: true });
} catch (error) {
  fail("convert-to-excalidraw-elements", error);
}

const scene = {
  type: "excalidraw",
  version: 2,
  source: "excalidraw-mcp",
  elements,
  appState: {},
  files: {},
};

console.log(
  JSON.stringify(
    {
      ok: true,
      sceneShapeValid: Array.isArray(scene.elements) && scene.elements.length > 0,
      skeletonElementCount: skeletonElements.length,
      ...summarize(elements),
    },
    null,
    2,
  ),
);
