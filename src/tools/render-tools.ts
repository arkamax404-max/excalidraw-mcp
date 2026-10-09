/**
 * `render_diagram`: turn a diagram into a PNG an agent can actually look at.
 *
 * RATIONALE: element counts and element types are not legibility. An agent that
 * generates a diagram needs to see it, judge it, and fix it, so this handler
 * renders three kinds of source — a stored diagram by name, Mermaid text
 * converted through this project's own pipeline (without saving anything), or
 * a raw scene — and returns the pixels.
 *
 * The handler is transport-free like the other tool handlers: it returns the
 * PNG buffer plus a summary, and `src/tools/register.ts` turns that into the
 * MCP content blocks. The renderer is injected so the tests never need a
 * browser.
 */
import type { ExcalidrawClient } from "../api/client.ts";
import type { RenderSceneOptions, RenderSceneResult } from "../render/png.ts";
import { renderSceneToPng, writePngToTempDirectory } from "../render/png.ts";
import type { MermaidConverter } from "./diagram-tools.ts";
import { ToolInputError } from "./errors.ts";

export const MIN_RENDER_SCALE = 0.2;
export const MAX_RENDER_SCALE = 4;

export interface RenderToolDeps {
  client: ExcalidrawClient;
  mermaidToScene: MermaidConverter;
  /** Injected for tests; defaults to the real Chromium renderer. */
  renderScene?: (scene: { elements: unknown[]; files?: unknown }, options?: RenderSceneOptions) => Promise<RenderSceneResult>;
  /** Injected for tests; defaults to writing under the system temp directory. */
  writePng?: (fileName: string, png: Buffer) => Promise<string>;
}

export interface RenderDiagramInput {
  name?: string;
  mermaid?: string;
  scene?: unknown;
  scale?: number;
  maxWidth?: number;
}

export interface RenderDiagramResult {
  source: "name" | "mermaid" | "scene";
  /** Canonical name when the source was a stored diagram. */
  name?: string;
  width: number;
  height: number;
  bytes: number;
  elementCount: number;
  elapsedMs: number;
  scaleUsed: number;
  scaledDown: boolean;
  /** Absolute path of the PNG written for the human to open. */
  path: string;
  /** Consumed by the registration layer to build the image content block. */
  png: Buffer;
}

function isNonEmptyElements(value: unknown): value is { elements: unknown[]; files?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { elements?: unknown }).elements) &&
    (value as { elements: unknown[] }).elements.length > 0
  );
}

function validateScale(scale: unknown): number | undefined {
  if (scale === undefined) {
    return undefined;
  }
  if (typeof scale !== "number" || !Number.isFinite(scale)) {
    throw new ToolInputError("scale must be a number between 0.2 and 4");
  }
  if (scale < MIN_RENDER_SCALE || scale > MAX_RENDER_SCALE) {
    throw new ToolInputError(`scale must be between ${MIN_RENDER_SCALE} and ${MAX_RENDER_SCALE}, got ${scale}`);
  }
  return scale;
}

function validateMaxWidth(maxWidth: unknown): number | undefined {
  if (maxWidth === undefined) {
    return undefined;
  }
  if (typeof maxWidth !== "number" || !Number.isInteger(maxWidth) || maxWidth < 200) {
    throw new ToolInputError("maxWidth must be an integer of at least 200 pixels, or omitted");
  }
  return maxWidth;
}

export function createRenderTools(deps: RenderToolDeps) {
  const renderScene = deps.renderScene ?? renderSceneToPng;
  const writePng = deps.writePng ?? writePngToTempDirectory;

  async function render_diagram(input: RenderDiagramInput): Promise<RenderDiagramResult> {
    const hasName = typeof input.name === "string" && input.name.trim() !== "";
    const hasMermaid = typeof input.mermaid === "string" && input.mermaid.trim() !== "";
    const hasScene = input.scene !== undefined;
    const provided = [hasName, hasMermaid, hasScene].filter(Boolean).length;
    if (provided !== 1) {
      throw new ToolInputError(
        "provide exactly one source: name (a stored diagram), mermaid (text to convert without saving), or scene",
      );
    }
    if (typeof input.name === "string" && !hasName) {
      throw new ToolInputError("name cannot be empty");
    }
    if (typeof input.mermaid === "string" && !hasMermaid) {
      throw new ToolInputError("mermaid cannot be empty");
    }
    if (hasScene && !isNonEmptyElements(input.scene)) {
      throw new ToolInputError("scene must be an object with a non-empty elements array");
    }

    const scale = validateScale(input.scale);
    const maxWidth = validateMaxWidth(input.maxWidth);

    let scene: { elements: unknown[]; files?: unknown };
    let source: RenderDiagramResult["source"];
    let canonicalName: string | undefined;

    if (hasName) {
      const stored = await deps.client.getDiagram(input.name as string);
      if (!isNonEmptyElements(stored.scene)) {
        throw new ToolInputError(`the stored diagram "${stored.file.name}" has no elements to render`);
      }
      scene = stored.scene;
      source = "name";
      canonicalName = stored.file.name;
    } else if (hasMermaid) {
      const converted = await deps.mermaidToScene(input.mermaid as string);
      scene = converted.scene;
      source = "mermaid";
    } else {
      scene = input.scene as { elements: unknown[]; files?: unknown };
      source = "scene";
    }

    const options: RenderSceneOptions = {};
    if (scale !== undefined) {
      options.scale = scale;
    }
    if (maxWidth !== undefined) {
      options.maxWidth = maxWidth;
    }

    const rendered = await renderScene(scene, options);
    const fileName = canonicalName ?? `bosquejo-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const path = await writePng(fileName, rendered.png);

    return {
      source,
      ...(canonicalName !== undefined ? { name: canonicalName } : {}),
      width: rendered.width,
      height: rendered.height,
      bytes: rendered.png.byteLength,
      elementCount: scene.elements.length,
      elapsedMs: rendered.elapsedMs,
      scaleUsed: rendered.scaleUsed,
      scaledDown: rendered.scaledDown,
      path,
      png: rendered.png,
    };
  }

  return { render_diagram };
}

export type RenderTools = ReturnType<typeof createRenderTools>;
