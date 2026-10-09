/**
 * Mermaid text → Excalidraw scene, server-side, with no browser.
 *
 * Pipeline (see `odd/notes/mermaid-node-spike.md` for the evidence):
 * 1. validate and enforce the dependency's own limits up front;
 * 2. detect the diagram type with mermaid itself
 *    (`mermaid.mermaidAPI.getDiagramFromText(...).type`): `erDiagram` input is
 *    routed to this project's own ER layout (`src/scene/er.ts`), because the
 *    dependency's ER parser derives all geometry from the rendered SVG, which
 *    the DOM shim fabricates, producing illegible scenes. Detection failures
 *    are not errors: they just leave the input on the generic path, which
 *    raises the typed parse error for genuinely invalid input;
 * 3. strict-parse the remaining Mermaid text with `parseMermaidToExcalidraw`.
 *    The DOM shim's id-prefix selector fallback (mermaid 11 renders ids
 *    prefixed by the render id; the dependency looks them up unprefixed with
 *    `[id="..."]` / `[id='...']`) makes flowcharts with `subgraph ... end`
 *    blocks resolve natively, so no flattening retry is needed;
 * 4. convert the parsed skeletons with the bundled converter from
 *    `dist/vendor/excalidraw-converter.mjs`, detecting the dependency's
 *    silent "single placeholder image" parse fallback as a hard error;
 * 5. assemble the scene object the Excalidraw server expects.
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
  /** mermaid's own diagram-type detection ("er", "flowchart-v2", ...). */
  getDiagramType: (text: string) => Promise<string | null>;
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
      // The dependency's own config: initializing mermaid with anything else
      // would poison the dependency's config-hash tracking (see er.ts header).
      const { MERMAID_CONFIG } = await import("@excalidraw/mermaid-to-excalidraw/dist/constants.js");
      const mermaid = ((await import("mermaid")) as {
        default: {
          mermaidAPI: {
            initialize: (config: unknown) => void;
            getDiagramFromText: (text: string) => Promise<{ type?: unknown; db?: unknown }>;
          };
        };
      }).default;
      mermaid.mermaidAPI.initialize({ ...MERMAID_CONFIG });
      const converterUrl = resolveConverterBundle();
      const converter = (await import(converterUrl)) as {
        convertToExcalidrawElements: ScenePipeline["convertToExcalidrawElements"];
      };
      return {
        parseMermaid: mermaidToExcalidraw.parseMermaidToExcalidraw,
        convertToExcalidrawElements: converter.convertToExcalidrawElements,
        getDiagramType: async (text: string) => {
          const diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
          return typeof diagram?.type === "string" ? diagram.type : null;
        },
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
 * pipeline; parsing is strict — there is no flattening fallback path.
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

  // Route by mermaid's own diagram type: ER input goes to the project's own
  // layout module (the dependency's ER geometry is unusable under the shim).
  // A failed detection is not an error — the generic path below raises the
  // typed parse error for genuinely invalid input.
  let diagramType: string | null = null;
  try {
    diagramType = await pipeline.getDiagramType(mermaidText);
  } catch {
    diagramType = null;
  }

  let elements: ExcalidrawElement[];
  let skeletonElementCount: number;
  try {
    if (diagramType === "er") {
      const { erDiagramToScene } = await import("./er.ts");
      return await erDiagramToScene(mermaidText, { convert: convertSkeletons, maxEdges });
    }
    const parsed = await pipeline.parseMermaid(mermaidText, parseOptions);
    elements = await convertSkeletons(parsed.elements);
    skeletonElementCount = parsed.elements.length;
  } catch (error: unknown) {
    throw error instanceof MermaidSceneError
      ? error
      : new MermaidParseError("Mermaid could not be parsed", { cause: error });
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
      skeletonElementCount,
      elementCount: elements.length,
    },
  };
}
