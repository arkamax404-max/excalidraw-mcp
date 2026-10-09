/**
 * Diagram tool handlers, transport-free: factories take their dependencies
 * (API client, Mermaid converter) as arguments, so every handler is testable
 * with plain fakes and no MCP transport. `src/tools/register.ts` binds these
 * handlers onto the MCP server with schemas.
 */
import type { DiagramFile, ExcalidrawClient } from "../api/client.ts";
import type { ExcalidrawElement, ExcalidrawScene, MermaidSceneResult } from "../scene/mermaid.ts";
import { DiagramConflictError, ToolInputError } from "./errors.ts";
import { normalizeDiagramName } from "./normalize.ts";

/**
 * The Mermaid converter, injected for testability. In production this is
 * `mermaidToScene` from `src/scene/mermaid.ts`; tests pass a double.
 */
export type MermaidConverter = (text: string) => Promise<MermaidSceneResult>;

export interface DiagramToolDeps {
  client: ExcalidrawClient;
  mermaidToScene: MermaidConverter;
}

export interface CreateDiagramInput {
  name: string;
  mode: "agent" | "fork-ai";
  prompt?: string;
  mermaid?: string;
  scene?: unknown;
  overwrite?: boolean;
}

export interface CreateDiagramResult {
  /** Canonical name echoed by the server. */
  name: string;
  file: DiagramFile;
  mode: "agent" | "fork-ai";
  elementCount: number;
  /** Only for mode "fork-ai": which fork AI produced the Mermaid. */
  provider?: string;
  model?: string;
}

export interface ListDiagramsResult {
  diagrams: DiagramFile[];
}

export interface GetDiagramResult {
  name: string;
  fileName: string;
  format: "summary" | "scene";
  elementCount?: number;
  elementTypeCounts?: Record<string, number>;
  labels?: { total: number; shown: string[] };
  scene?: unknown;
}

export interface DeleteDiagramResult {
  deleted: true;
  name: string;
  fileName: string;
}

/**
 * Summary bounds. RATIONALE: `get_diagram` defaults to a summary because a raw
 * scene can be tens of thousands of tokens and would flood the agent's
 * context; 20 labels x 80 characters bounds the summary to roughly a screen
 * of text, while `labels.total` and the per-type counts still tell the agent
 * how much it did not see and `format: "scene"` remains available.
 */
const MAX_SUMMARY_LABELS = 20;
const MAX_SUMMARY_LABEL_LENGTH = 80;

function requireNonEmptyName(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new ToolInputError("name is required and cannot be empty");
  }
  return name;
}

function isNonEmptyElementArray(scene: unknown): scene is { elements: ExcalidrawElement[] } {
  return (
    typeof scene === "object" &&
    scene !== null &&
    Array.isArray((scene as { elements?: unknown }).elements) &&
    (scene as { elements: unknown[] }).elements.length > 0
  );
}

/** The single existence check for overwrite protection (server owns truth). */
async function findExisting(deps: DiagramToolDeps, canonicalName: string): Promise<DiagramFile | undefined> {
  const files = await deps.client.listDiagrams();
  return files.find((file) => file.name === canonicalName);
}

export function createDiagramTools(deps: DiagramToolDeps) {
  async function create_diagram(input: CreateDiagramInput): Promise<CreateDiagramResult> {
    const rawName = requireNonEmptyName(input.name);
    const overwrite = input.overwrite ?? false;
    let scene: ExcalidrawScene;
    let mode: "agent" | "fork-ai";
    let provider: string | undefined;
    let model: string | undefined;

    if (input.mode === "agent") {
      mode = "agent";
      const hasMermaid = typeof input.mermaid === "string";
      const hasScene = input.scene !== undefined;
      if (hasMermaid === hasScene) {
        throw new ToolInputError(
          "mode 'agent' needs exactly one of mermaid or scene; provide one, not both, not neither",
        );
      }
      if (hasScene) {
        if (!isNonEmptyElementArray(input.scene)) {
          throw new ToolInputError("scene must be an object with a non-empty elements array");
        }
        scene = input.scene as ExcalidrawScene;
      } else {
        const converted = await deps.mermaidToScene(input.mermaid as string);
        scene = converted.scene;
      }
    } else if (input.mode === "fork-ai") {
      mode = "fork-ai";
      if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
        throw new ToolInputError("mode 'fork-ai' needs a non-empty prompt");
      }
      if (input.mermaid !== undefined || input.scene !== undefined) {
        throw new ToolInputError("mode 'fork-ai' takes only a prompt; mermaid/scene belong to mode 'agent'");
      }
      const generated = await deps.client.generateMermaid(input.prompt);
      const converted = await deps.mermaidToScene(generated.mermaid);
      scene = converted.scene;
      provider = generated.provider;
      model = generated.model;
    } else {
      throw new ToolInputError(`unknown mode ${JSON.stringify(input.mode)}; use "agent" or "fork-ai"`);
    }

    // Mirrors the server's normalization (see src/tools/normalize.ts) so the
    // caller can be told the canonical name in advance; the server's echoed
    // name still wins.
    const canonicalName = normalizeDiagramName(rawName);
    if (!overwrite) {
      const existing = await findExisting(deps, canonicalName);
      if (existing) {
        throw new DiagramConflictError(existing.name);
      }
    }

    const file = await deps.client.putDiagram(canonicalName, scene);
    return {
      name: file.name,
      file,
      mode,
      elementCount: scene.elements.length,
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
    };
  }

  async function list_diagrams(): Promise<ListDiagramsResult> {
    return { diagrams: await deps.client.listDiagrams() };
  }

  async function get_diagram(input: { name: string; format?: "summary" | "scene" }): Promise<GetDiagramResult> {
    const rawName = requireNonEmptyName(input.name);
    const format = input.format ?? "summary";
    if (format !== "summary" && format !== "scene") {
      throw new ToolInputError(`unknown format ${JSON.stringify(input.format)}; use "summary" or "scene"`);
    }
    const diagram = await deps.client.getDiagram(rawName);
    if (format === "scene") {
      return {
        name: diagram.file.name,
        fileName: diagram.file.fileName,
        format: "scene",
        scene: diagram.scene,
      };
    }
    const elements = (diagram.scene as { elements?: ExcalidrawElement[] } | undefined)?.elements ?? [];
    const elementTypeCounts: Record<string, number> = {};
    const labels: string[] = [];
    for (const element of elements) {
      elementTypeCounts[element.type] = (elementTypeCounts[element.type] ?? 0) + 1;
      const text = (element as { text?: unknown }).text;
      if (element.type === "text" && typeof text === "string" && labels.length < MAX_SUMMARY_LABELS) {
        labels.push(text.length > MAX_SUMMARY_LABEL_LENGTH ? text.slice(0, MAX_SUMMARY_LABEL_LENGTH) : text);
      }
    }
    const totalLabels = elements.filter(
      (element) => element.type === "text" && typeof (element as { text?: unknown }).text === "string",
    ).length;
    return {
      name: diagram.file.name,
      fileName: diagram.file.fileName,
      format: "summary",
      elementCount: elements.length,
      elementTypeCounts,
      labels: { total: totalLabels, shown: labels },
    };
  }

  async function delete_diagram(input: { name: string }): Promise<DeleteDiagramResult> {
    const rawName = requireNonEmptyName(input.name);
    const file = await deps.client.deleteDiagram(rawName);
    return { deleted: true, name: file.name, fileName: file.fileName };
  }

  return { create_diagram, list_diagrams, get_diagram, delete_diagram };
}

export type DiagramTools = ReturnType<typeof createDiagramTools>;
