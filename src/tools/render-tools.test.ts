/**
 * Tests for the `render_diagram` handler. The renderer is injected, so these
 * run without a browser and stay fast; the real rendering is covered by
 * `src/render/png.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NotFoundError } from "../api/errors.ts";
import type { DiagramToolDeps } from "./diagram-tools.ts";
import { ToolInputError } from "./errors.ts";
import { createRenderTools, type RenderToolDeps } from "./render-tools.ts";
import { renderToolResult } from "./register.ts";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SCENE = { elements: [{ id: "a", type: "rectangle" }] };

function makeDeps(options: {
  stored?: { file: { name: string; fileName: string }; scene: unknown };
  failRender?: Error;
} = {}) {
  const calls = { getDiagram: [] as string[], rendered: [] as unknown[], written: [] as string[] };
  const client = {
    async getDiagram(name: string) {
      calls.getDiagram.push(name);
      if (!options.stored) {
        throw new NotFoundError("file not found");
      }
      return options.stored;
    },
  } as unknown as DiagramToolDeps["client"];

  const deps: RenderToolDeps = {
    client,
    mermaidToScene: async () => ({ scene: SCENE } as never),
    renderScene: async (scene, renderOptions) => {
      calls.rendered.push([scene, renderOptions]);
      if (options.failRender) {
        throw options.failRender;
      }
      return { png: PNG_BYTES, width: 800, height: 600, elapsedMs: 1234, scaledDown: false, scaleUsed: 1 };
    },
    writePng: async (fileName) => {
      calls.written.push(fileName);
      return `C:/tmp/${fileName}.png`;
    },
  };
  return { tools: createRenderTools(deps), calls };
}

describe("render_diagram input validation", () => {
  it("requires exactly one source", async () => {
    const { tools } = makeDeps();
    await assert.rejects(() => tools.render_diagram({}), ToolInputError);
    await assert.rejects(() => tools.render_diagram({ name: "a", mermaid: "flowchart TD\n A-->B" }), ToolInputError);
    await assert.rejects(() => tools.render_diagram({ name: "a", scene: SCENE }), ToolInputError);
    await assert.rejects(() => tools.render_diagram({ mermaid: "x", scene: SCENE }), ToolInputError);
  });

  it("rejects an empty name or empty mermaid", async () => {
    const { tools } = makeDeps();
    await assert.rejects(() => tools.render_diagram({ name: "   " }), ToolInputError);
    await assert.rejects(() => tools.render_diagram({ mermaid: "  \n " }), ToolInputError);
  });

  it("rejects a scene without elements", async () => {
    const { tools } = makeDeps();
    await assert.rejects(() => tools.render_diagram({ scene: { elements: [] } }), ToolInputError);
    await assert.rejects(() => tools.render_diagram({ scene: { nope: true } }), ToolInputError);
  });

  it("rejects an out-of-range scale and a tiny maxWidth", async () => {
    const { tools } = makeDeps();
    await assert.rejects(() => tools.render_diagram({ mermaid: "a", scale: 0.1 }), ToolInputError);
    await assert.rejects(() => tools.render_diagram({ mermaid: "a", scale: 9 }), ToolInputError);
    await assert.rejects(() => tools.render_diagram({ mermaid: "a", scale: Number.NaN }), ToolInputError);
    await assert.rejects(() => tools.render_diagram({ mermaid: "a", maxWidth: 100 }), ToolInputError);
  });
});

describe("render_diagram sources", () => {
  it("converts Mermaid locally and does not touch the server", async () => {
    const { tools, calls } = makeDeps();
    const result = await tools.render_diagram({ mermaid: "flowchart TD\n A-->B" });
    assert.equal(result.source, "mermaid");
    assert.equal(calls.getDiagram.length, 0, "a Mermaid draft must not be fetched from the server");
    assert.equal(result.elementCount, 1);
    assert.equal(result.bytes, PNG_BYTES.byteLength);
    assert.match(result.path, /bosquejo-/);
  });

  it("renders a stored diagram and reports the canonical name", async () => {
    const { tools, calls } = makeDeps({
      stored: { file: { name: "mi-diagrama", fileName: "mi-diagrama.excalidraw.json" }, scene: SCENE },
    });
    const result = await tools.render_diagram({ name: "Mi Diagrama!!" });
    assert.equal(result.source, "name");
    assert.equal(result.name, "mi-diagrama");
    assert.deepEqual(calls.getDiagram, ["Mi Diagrama!!"]);
    assert.equal(calls.written[0], "mi-diagrama");
  });

  it("renders a raw scene without contacting the server", async () => {
    const { tools, calls } = makeDeps();
    const result = await tools.render_diagram({ scene: SCENE });
    assert.equal(result.source, "scene");
    assert.equal(calls.getDiagram.length, 0);
  });

  it("passes scale and maxWidth down to the renderer", async () => {
    const { tools, calls } = makeDeps();
    await tools.render_diagram({ mermaid: "a", scale: 2, maxWidth: 400 });
    assert.deepEqual(calls.rendered[0], [SCENE, { scale: 2, maxWidth: 400 }]);
  });

  it("propagates a not-found error from the server", async () => {
    const { tools } = makeDeps();
    await assert.rejects(() => tools.render_diagram({ name: "no-existe" }), NotFoundError);
  });

  it("propagates a renderer failure", async () => {
    const { tools } = makeDeps({ failRender: new Error("no browser") });
    await assert.rejects(() => tools.render_diagram({ mermaid: "a" }), /no browser/);
  });
});

describe("render_diagram tool result", () => {
  it("carries the image block and a summary without the raw buffer", () => {
    const result = renderToolResult({
      source: "mermaid",
      width: 800,
      height: 600,
      bytes: PNG_BYTES.byteLength,
      elementCount: 12,
      elapsedMs: 1234,
      scaleUsed: 1,
      scaledDown: false,
      path: "C:/tmp/bosquejo.png",
      png: PNG_BYTES,
    });

    assert.equal(result.content.length, 2);
    const image = result.content[0] as { type: string; data: string; mimeType: string };
    assert.equal(image.type, "image");
    assert.equal(image.mimeType, "image/png");
    assert.equal(Buffer.from(image.data, "base64").byteLength, PNG_BYTES.byteLength);

    const text = result.content[1] as { type: string; text: string };
    assert.equal(text.type, "text");
    const summary = JSON.parse(text.text);
    assert.equal(summary.width, 800);
    assert.equal(summary.elementCount, 12);
    assert.equal(summary.path, "C:/tmp/bosquejo.png");
    assert.equal(summary.png, undefined, "the raw buffer must not be duplicated into the summary");
  });
});
