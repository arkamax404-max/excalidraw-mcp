import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Diagram, DiagramFile } from "../api/client.ts";
import { NotFoundError, RateLimitError } from "../api/errors.ts";
import {
  createDiagramTools,
  type DiagramToolDeps,
  type MermaidConverter,
} from "./diagram-tools.ts";
import { DiagramConflictError, ToolInputError } from "./errors.ts";
import { normalizeDiagramName } from "./normalize.ts";
import { toolResultForError } from "./register.ts";

const PASSWORD = "topsecret-value";
const COOKIE = "excalidraw.sid=leaked-cookie-value";

/** Records calls and returns canned answers; no HTTP anywhere. */
function makeFakeClient(options: {
  existing?: DiagramFile[];
  diagramFor?: Map<string, Diagram>;
  ai?: { mermaid: string; provider: string; model: string };
} = {}) {
  const calls = {
    generateMermaid: [] as string[],
    putDiagram: [] as Array<{ name: string; scene: unknown }>,
    getDiagram: [] as string[],
    listDiagrams: 0,
    deleteDiagram: [] as string[],
  };
  const client = {
    async login() {
      return {};
    },
    async generateMermaid(prompt: string) {
      calls.generateMermaid.push(prompt);
      return options.ai ?? { mermaid: "graph TD;\nA-->B", provider: "stub-ai", model: "stub-1" };
    },
    async session() {
      return { authenticated: true };
    },
    async listDiagrams() {
      calls.listDiagrams += 1;
      return options.existing ?? [];
    },
    async getDiagram(name: string) {
      calls.getDiagram.push(name);
      const diagram = options.diagramFor?.get(name);
      if (!diagram) {
        throw new NotFoundError("file not found");
      }
      return diagram;
    },
    async putDiagram(name: string, scene: unknown) {
      calls.putDiagram.push({ name, scene });
      return { name, fileName: `${name}.excalidraw` };
    },
    async deleteDiagram(name: string) {
      calls.deleteDiagram.push(name);
      if (!options.diagramFor?.has(name)) {
        throw new NotFoundError("file not found");
      }
      return { name, fileName: `${name}.excalidraw` };
    },
  };
  return { client: client as unknown as DiagramToolDeps["client"], calls };
}

/** Deterministic converter double: two elements per call, records its input. */
function makeFakeConverter() {
  const inputs: string[] = [];
  const converter: MermaidConverter = async (text: string) => {
    inputs.push(text);
    return {
      scene: {
        type: "excalidraw" as const,
        version: 2 as const,
        source: "excalidraw-mcp",
        elements: [
          { id: "e1", type: "rectangle" },
          { id: "e2", type: "text" },
        ],
        appState: {},
        files: {},
      },
      metadata: { mode: "direct" as const, removedSubgraphBlocks: 0, skeletonElementCount: 2, elementCount: 2 },
    };
  };
  return { converter, inputs };
}

function makeDeps(options?: Parameters<typeof makeFakeClient>[0]) {
  const fake = makeFakeClient(options);
  const converted = makeFakeConverter();
  const deps: DiagramToolDeps = { client: fake.client, mermaidToScene: converted.converter };
  return { ...fake, converted, deps };
}

describe("name normalization (mirror of the server algorithm)", () => {
  it("applies the full documented algorithm", () => {
    assert.equal(normalizeDiagramName("Mi Diagrama Genial!!"), "mi-diagrama-genial");
    assert.equal(normalizeDiagramName("--Mi--Diagrama--"), "mi-diagrama");
    assert.equal(normalizeDiagramName("name@#$%x"), "name-x");
  });

  it("NFKC-normalizes before the character rules", () => {
    // Full-width ＡＢ → ASCII AB; ﬁ ligature → fi; both before lowercasing.
    assert.equal(normalizeDiagramName("ＡＢ ﬁle"), "ab-file");
  });

  it("falls back to diagrama-1 when the result is empty", () => {
    assert.equal(normalizeDiagramName("   "), "diagrama-1");
    assert.equal(normalizeDiagramName("@#$%"), "diagrama-1");
    assert.equal(normalizeDiagramName("---___"), "diagrama-1");
  });

  it("truncates to 80 characters", () => {
    const long = "a".repeat(100);
    const normalized = normalizeDiagramName(long);
    assert.equal(normalized.length, 80);
    assert.equal(normalized, "a".repeat(80));
  });
});

describe("create_diagram handler", () => {
  it("mode agent + mermaid converts locally and stores under the canonical name", async () => {
    const { deps, calls, converted } = makeDeps();
    const tools = createDiagramTools(deps);
    const result = await tools.create_diagram({ name: "Mi Diagrama!!", mode: "agent", mermaid: "flowchart TD\n A-->B" });
    assert.deepEqual(converted.inputs, ["flowchart TD\n A-->B"]);
    assert.equal(calls.putDiagram.length, 1);
    assert.equal(calls.putDiagram[0]?.name, "mi-diagrama");
    assert.equal(result.name, "mi-diagrama");
    assert.equal(result.mode, "agent");
    assert.equal(result.elementCount, 2);
    assert.equal("provider" in result, false, "agent mode must not report AI provider");
  });

  it("mode agent + scene stores the scene as-is without calling the converter", async () => {
    const { deps, calls, converted } = makeDeps();
    const tools = createDiagramTools(deps);
    const scene = { type: "excalidraw", elements: [{ id: "x", type: "rectangle" }] };
    const result = await tools.create_diagram({ name: "directo", mode: "agent", scene });
    assert.deepEqual(converted.inputs, []);
    assert.deepEqual(calls.putDiagram[0]?.scene, scene);
    assert.equal(result.elementCount, 1);
    assert.equal(result.mode, "agent");
  });

  it("mode agent rejects providing both mermaid and scene", async () => {
    const { deps } = makeDeps();
    const tools = createDiagramTools(deps);
    await assert.rejects(
      () =>
        tools.create_diagram({
          name: "x",
          mode: "agent",
          mermaid: "flowchart TD\n A-->B",
          scene: { elements: [{ id: "x", type: "rectangle" }] },
        }),
      ToolInputError,
    );
  });

  it("mode agent rejects providing neither mermaid nor scene", async () => {
    const { deps } = makeDeps();
    const tools = createDiagramTools(deps);
    await assert.rejects(() => tools.create_diagram({ name: "x", mode: "agent" }), ToolInputError);
  });

  it("mode fork-ai generates mermaid, converts it and reports provider/model", async () => {
    const { deps, calls, converted } = makeDeps({
      ai: { mermaid: "graph TD;\nA-->B", provider: "stub-provider", model: "stub-model-7" },
    });
    const tools = createDiagramTools(deps);
    const result = await tools.create_diagram({ name: "con ia", mode: "fork-ai", prompt: "un flujo simple" });
    assert.deepEqual(calls.generateMermaid, ["un flujo simple"]);
    assert.deepEqual(converted.inputs, ["graph TD;\nA-->B"]);
    assert.equal(result.mode, "fork-ai");
    assert.equal(result.provider, "stub-provider");
    assert.equal(result.model, "stub-model-7");
    assert.equal(result.elementCount, 2);
  });

  it("mode fork-ai rejects an empty or whitespace-only prompt", async () => {
    const { deps } = makeDeps();
    const tools = createDiagramTools(deps);
    await assert.rejects(() => tools.create_diagram({ name: "x", mode: "fork-ai", prompt: "   " }), ToolInputError);
    await assert.rejects(
      () => tools.create_diagram({ name: "x", mode: "fork-ai", prompt: "" }),
      ToolInputError,
    );
  });

  it("rejects an unknown mode, an empty name, and a scene without a non-empty elements array", async () => {
    const { deps } = makeDeps();
    const tools = createDiagramTools(deps);
    await assert.rejects(
      () => tools.create_diagram({ name: "x", mode: "magic" } as never),
      ToolInputError,
    );
    await assert.rejects(() => tools.create_diagram({ name: "", mode: "agent", mermaid: "a" }), ToolInputError);
    await assert.rejects(() => tools.create_diagram({ name: "   ", mode: "agent", mermaid: "a" }), ToolInputError);
    await assert.rejects(
      () => tools.create_diagram({ name: "x", mode: "agent", scene: {} as never }),
      ToolInputError,
    );
    await assert.rejects(
      () => tools.create_diagram({ name: "x", mode: "agent", scene: { elements: [] } }),
      ToolInputError,
    );
  });

  it("protects an existing diagram when overwrite is false, names it in the error", async () => {
    const { deps, calls } = makeDeps({
      existing: [{ name: "mi-diagrama", fileName: "mi-diagrama.excalidraw", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });
    const tools = createDiagramTools(deps);
    await assert.rejects(
      () => tools.create_diagram({ name: "Mi Diagrama!!", mode: "agent", mermaid: "a" }),
      (error: unknown) => {
        assert.ok(error instanceof DiagramConflictError);
        assert.match(error.message, /mi-diagrama/);
        return true;
      },
    );
    assert.equal(calls.putDiagram.length, 0, "the existing diagram must not be clobbered");
  });

  it("replaces the diagram when overwrite is true", async () => {
    const { deps, calls } = makeDeps({
      existing: [{ name: "mi-diagrama", fileName: "mi-diagrama.excalidraw", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });
    const tools = createDiagramTools(deps);
    const result = await tools.create_diagram({ name: "mi-diagrama", mode: "agent", mermaid: "a", overwrite: true });
    assert.equal(calls.putDiagram.length, 1);
    assert.equal(result.name, "mi-diagrama");
  });

  it("creates without conflict when the name does not exist and overwrite is false", async () => {
    const { deps, calls } = makeDeps();
    const tools = createDiagramTools(deps);
    await tools.create_diagram({ name: "nuevo", mode: "agent", mermaid: "a" });
    assert.equal(calls.putDiagram.length, 1);
  });
});

describe("list/get/delete handlers", () => {
  it("list_diagrams returns the user's diagrams", async () => {
    const existing = [{ name: "a", fileName: "a.excalidraw", updatedAt: "2026-01-01T00:00:00.000Z" }];
    const { deps, calls } = makeDeps({ existing });
    const tools = createDiagramTools(deps);
    const result = await tools.list_diagrams();
    assert.deepEqual(result.diagrams, existing);
    assert.equal(calls.listDiagrams, 1);
  });

  it("get_diagram summary stays bounded for a huge scene", async () => {
    const manyTexts = Array.from({ length: 300 }, (_, i) => ({
      id: `t${i}`,
      type: "text",
      text: `label ${i} ${"palabra ".repeat(25)}`,
      containerId: `c${i}`,
    }));
    const manyRects = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, type: "rectangle", width: 100 }));
    const { deps } = makeDeps({
      diagramFor: new Map([
        [
          "grande",
          {
            file: { name: "grande", fileName: "grande.excalidraw", updatedAt: "2026-01-01T00:00:00.000Z" },
            scene: { elements: [...manyRects, ...manyTexts] },
          },
        ],
      ]),
    });
    const tools = createDiagramTools(deps);
    const result = await tools.get_diagram({ name: "grande" });
    assert.equal(result.format, "summary");
    assert.equal(result.elementCount, 500);
    const typeCounts = result.elementTypeCounts ?? {};
    assert.equal(typeCounts["rectangle"], 200);
    assert.equal(typeCounts["text"], 300);
    // The bound: at most 20 labels, each at most 80 characters, plus the
    // unbounded total so the agent knows what it did not see.
    const labels = result.labels ?? { total: -1, shown: [] };
    assert.ok(labels.total === 300);
    assert.ok(labels.shown.length <= 20, "label list must be bounded");
    for (const label of labels.shown) {
      assert.ok(label.length <= 80, "each label must be truncated");
    }
  });

  it("get_diagram format scene returns the full scene", async () => {
    const diagram: Diagram = {
      file: { name: "a", fileName: "a.excalidraw", updatedAt: "2026-01-01T00:00:00.000Z" },
      scene: { elements: [{ id: "e1", type: "rectangle" }] },
    };
    const { deps } = makeDeps({ diagramFor: new Map([["a", diagram]]) });
    const tools = createDiagramTools(deps);
    const result = await tools.get_diagram({ name: "a", format: "scene" });
    assert.equal(result.format, "scene");
    assert.deepEqual(result.scene, diagram.scene);
  });

  it("get_diagram rejects an unknown format", async () => {
    const { deps } = makeDeps();
    const tools = createDiagramTools(deps);
    await assert.rejects(() => tools.get_diagram({ name: "a", format: "raw" as never }), ToolInputError);
  });

  it("delete_diagram reports the canonical name and propagates not-found", async () => {
    const diagram: Diagram = {
      file: { name: "a", fileName: "a.excalidraw", updatedAt: "2026-01-01T00:00:00.000Z" },
      scene: { elements: [] },
    };
    const { deps, calls } = makeDeps({ diagramFor: new Map([["a", diagram]]) });
    const tools = createDiagramTools(deps);
    const result = await tools.delete_diagram({ name: "a" });
    assert.equal(result.deleted, true);
    assert.equal(result.name, "a");
    assert.deepEqual(calls.deleteDiagram, ["a"]);
    await assert.rejects(() => tools.delete_diagram({ name: "missing" }), NotFoundError);
  });
});

describe("error results at the registration boundary", () => {
  it("maps typed errors to readable, actionable tool results", () => {
    const notFound = toolResultForError(new NotFoundError("file not found"));
    assert.equal(notFound.isError, true);
    assert.match(resultText(notFound), /list_diagrams/);

    const conflict = toolResultForError(new DiagramConflictError("mi-diagrama"));
    assert.equal(conflict.isError, true);
    assert.match(resultText(conflict), /overwrite/);
    assert.match(resultText(conflict), /mi-diagrama/);

    const rateLimited = toolResultForError(new RateLimitError("7", "rate limited"));
    assert.equal(rateLimited.isError, true);
    assert.match(resultText(rateLimited), /7/);

    const invalid = toolResultErrorText(new ToolInputError("provide exactly one of mermaid or scene"));
    assert.match(invalid, /exactly one/);
  });

  it("never leaks the password or a cookie value into any tool result", () => {
    const results = [
      toolResultForError(new NotFoundError("file not found")),
      toolResultForError(new RateLimitError("7", "rate limited")),
      toolResultForError(new ToolInputError("bad input")),
      toolResultForError(new DiagramConflictError("x")),
      toolResultForError(new Error("generic failure")),
    ];
    for (const result of results) {
      const text = JSON.stringify(result);
      assert.ok(!text.includes(PASSWORD), "no tool result may contain the password");
      assert.ok(!text.includes(COOKIE), "no tool result may contain the cookie");
      assert.ok(!/at .+:\d+:\d+/.test(text), "no stack trace fragments in tool results");
    }
  });
});

/** Extracts the text of a tool result's content blocks (type-guarded). */
function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("\n");
}

/** Small helper so the ToolInputError assertion above stays readable. */
function toolResultErrorText(error: unknown): string {
  return resultText(toolResultForError(error));
}
