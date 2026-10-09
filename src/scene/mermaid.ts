/**
 * Mermaid text → Excalidraw scene, server-side, with no browser.
 *
 * Pipeline (see `odd/notes/mermaid-node-spike.md` for the evidence):
 * 1. validate and enforce the dependency's own limits up front;
 * 2. strict-parse the Mermaid text with `parseMermaidToExcalidraw`;
 *    on failure retry once with `subgraph ... end` blocks flattened away
 *    (the dependency's subgraph lookup can never match mermaid 11.15's
 *    prefixed DOM ids) and report which path produced the result;
 * 3. convert the parsed skeletons with the bundled converter from
 *    `dist/vendor/excalidraw-converter.mjs`, detecting the dependency's
 *    silent "single placeholder image" parse fallback as a hard error;
 * 4. assemble the scene object the Excalidraw server expects.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ConverterError,
  InvalidMermaidError,
  MermaidLimitError,
  MermaidParseError,
  MermaidSceneError,
} from "./errors.ts";
import { installDomShim } from "./dom-shim.ts";

/** The dependency's own limits; input above them would be silently truncated. */
export const MAX_EDGES = 250;
export const MAX_TEXT_SIZE = 20000;

export interface MermaidSceneOptions {
  maxEdges?: number;
  maxTextSize?: number;
}

export interface ExcalidrawElement {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface ExcalidrawScene {
  type: "excalidraw";
  version: 2;
  source: "excalidraw-mcp";
  elements: ExcalidrawElement[];
  appState: Record<string, never>;
  files: Record<string, never>;
}

export interface MermaidSceneMetadata {
  /** "direct": strict parse succeeded; "subgraphs-flattened": recovered parse. */
  mode: "direct" | "subgraphs-flattened";
  removedSubgraphBlocks: number;
  skeletonElementCount: number;
  elementCount: number;
}

export interface MermaidSceneResult {
  scene: ExcalidrawScene;
  metadata: MermaidSceneMetadata;
}

const CONVERTER_BUNDLE = ["dist", "vendor", "excalidraw-converter.mjs"] as const;

/**
 * Converter bundle resolution rule: starting from this module's own real path,
 * walk upwards until a directory containing `dist/vendor/excalidraw-converter.mjs`
 * is found. Running from `src/scene/` (tests, type-stripped) the search
 * reaches the repository root; running from `dist/scene/` (shipped server) it
 * finds `dist/` itself one level up. The bundle is built by
 * `npm run build:converter` (part of `npm run build`).
 */
function resolveConverterBundle(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, ...CONVERTER_BUNDLE);
    if (existsSync(candidate)) {
      return pathToFileURL(candidate).href;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new ConverterError(
    `converter bundle not found; expected ${CONVERTER_BUNDLE.join("/")} above ${dirname(fileURLToPath(import.meta.url))}. Run "npm run build" first.`,
  );
}

interface ScenePipeline {
  parseMermaid: (text: string, options: { maxEdges: number; maxTextSize: number }) => Promise<{ elements: unknown[] }>;
  convertToExcalidrawElements: (skeletons: unknown[], options?: { regenerateIds?: boolean }) => ExcalidrawElement[];
}

let pipelinePromise: Promise<ScenePipeline> | undefined;

/**
 * Loads the conversion pipeline lazily.
 *
 * ORDERING CONSTRAINT (load-bearing, spike residual risk 5): the DOM shim MUST
 * be installed before the first dynamic import of the mermaid or Excalidraw
 * modules — DOMPurify and the converter bundle probe browser globals at module
 * load. Static imports of those modules are forbidden in this file because
 * they would be hoisted above `installDomShim()`.
 */
async function loadPipeline(): Promise<ScenePipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      installDomShim();
      const mermaidToExcalidraw = (await import("@excalidraw/mermaid-to-excalidraw")) as {
        parseMermaidToExcalidraw: ScenePipeline["parseMermaid"];
      };
      const converterUrl = resolveConverterBundle();
      const converter = (await import(converterUrl)) as {
        convertToExcalidrawElements: ScenePipeline["convertToExcalidrawElements"];
      };
      return {
        parseMermaid: mermaidToExcalidraw.parseMermaidToExcalidraw,
        convertToExcalidrawElements: converter.convertToExcalidrawElements,
      };
    })().catch((error: unknown) => {
      pipelinePromise = undefined;
      throw error instanceof ConverterError ? error : new ConverterError("failed to load the conversion pipeline", { cause: error });
    });
  }
  return pipelinePromise;
}

/** Heuristic edge count for the pre-flight maxEdges check. */
function countEdges(text: string): number {
  const matches = text.match(/-->|---|-\.->|==>|~~~|--o|--x|==o|==x/g);
  return matches ? matches.length : 0;
}

/**
 * Removes `subgraph` header lines and their matching `end` lines (plus any
 * `direction` lines inside the removed blocks). Nested subgraphs are handled
 * with a depth counter. Returns the flattened text and the number of removed
 * subgraph blocks.
 */
export function flattenSubgraphs(text: string): { text: string; removedBlocks: number } {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let depth = 0;
  let removedBlocks = 0;
  for (const line of lines) {
    if (/^\s*subgraph\b/i.test(line)) {
      depth += 1;
      removedBlocks += 1;
      continue;
    }
    if (depth > 0 && /^\s*end\s*(%%.*)?$/i.test(line)) {
      depth -= 1;
      continue;
    }
    if (depth > 0 && /^\s*direction\b/i.test(line)) {
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), removedBlocks };
}

/**
 * Converts parsed skeletons into Excalidraw elements.
 *
 * CRITICAL: the dependency does NOT throw on a failed parse — it returns a
 * single placeholder `image` element as a fallback. That fallback is detected
 * here and raised as `MermaidParseError` instead of being silently persisted.
 * Exported for tests because triggering the fallback end-to-end requires
 * exactly the broken-parse skeleton shape.
 */
export async function convertSkeletons(skeletons: unknown[]): Promise<ExcalidrawElement[]> {
  if (!Array.isArray(skeletons) || skeletons.length === 0) {
    throw new ConverterError("parse produced no skeleton elements to convert");
  }
  const { convertToExcalidrawElements } = await loadPipeline();
  const elements = convertToExcalidrawElements(skeletons, { regenerateIds: true });
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new ConverterError("converter produced no elements");
  }
  if (elements.length === 1 && elements[0]?.type === "image") {
    throw new MermaidParseError(
      "Mermaid parse failed: the converter returned its single placeholder image fallback",
    );
  }
  return elements;
}

/**
 * Converts Mermaid text into an Excalidraw scene. See module docs for the
 * pipeline; the returned `metadata.mode` reports which parse path won.
 */
export async function mermaidToScene(
  mermaidText: string,
  options: MermaidSceneOptions = {},
): Promise<MermaidSceneResult> {
  if (typeof mermaidText !== "string" || mermaidText.trim() === "") {
    throw new InvalidMermaidError();
  }
  const maxEdges = options.maxEdges ?? MAX_EDGES;
  const maxTextSize = options.maxTextSize ?? MAX_TEXT_SIZE;
  if (mermaidText.length > maxTextSize) {
    throw new MermaidLimitError(
      `Mermaid input exceeds maxTextSize ${maxTextSize} (${mermaidText.length} characters); the dependency would truncate it`,
    );
  }
  const edgeCount = countEdges(mermaidText);
  if (edgeCount > maxEdges) {
    throw new MermaidLimitError(
      `Mermaid input exceeds maxEdges ${maxEdges} (${edgeCount} edges detected); the dependency would truncate it`,
    );
  }

  const pipeline = await loadPipeline();
  const parseOptions = { maxEdges, maxTextSize };

  /**
   * IMPORTANT: the dependency's subgraph failure is silent — the strict parse
   * SUCCEEDS and `convertSkeletons` detects the placeholder-image fallback. So
   * the flattening retry wraps BOTH stages: parse/convert of the strict text,
   * and, if that fails and subgraphs are present, parse/convert of the
   * flattened text.
   */
  const parseAndConvert = async (
    text: string,
  ): Promise<{ elements: ExcalidrawElement[]; skeletonCount: number }> => {
    const parsed = await pipeline.parseMermaid(text, parseOptions);
    const elements = await convertSkeletons(parsed.elements);
    return { elements, skeletonCount: parsed.elements.length };
  };

  let elements: ExcalidrawElement[];
  let mode: MermaidSceneMetadata["mode"];
  let removedSubgraphBlocks = 0;
  let skeletonElementCount: number;
  try {
    const result = await parseAndConvert(mermaidText);
    elements = result.elements;
    skeletonElementCount = result.skeletonCount;
    mode = "direct";
  } catch (directError: unknown) {
    const flattened = flattenSubgraphs(mermaidText);
    if (flattened.removedBlocks === 0) {
      throw directError instanceof MermaidSceneError
        ? directError
        : new MermaidParseError("Mermaid could not be parsed and no subgraph flattening was possible", {
            cause: directError,
          });
    }
    try {
      const result = await parseAndConvert(flattened.text);
      elements = result.elements;
      skeletonElementCount = result.skeletonCount;
      mode = "subgraphs-flattened";
      removedSubgraphBlocks = flattened.removedBlocks;
    } catch (flattenedError: unknown) {
      throw new MermaidParseError("Mermaid could not be parsed even with subgraphs flattened", {
        cause: flattenedError,
      });
    }
  }

  const scene: ExcalidrawScene = {
    type: "excalidraw",
    version: 2,
    source: "excalidraw-mcp",
    elements,
    appState: {},
    files: {},
  };
  return {
    scene,
    metadata: {
      mode,
      removedSubgraphBlocks,
      skeletonElementCount,
      elementCount: elements.length,
    },
  };
}
