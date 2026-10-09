import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { before, describe, it } from "node:test";

import {
  ConverterError,
  InvalidMermaidError,
  MermaidLimitError,
  MermaidParseError,
  MermaidSceneError,
} from "./errors.ts";
import { convertSkeletons, mermaidToScene } from "./mermaid.ts";
import { FIXTURES } from "./fixtures.ts";

/**
 * The conversion pipeline loads the prebuilt converter bundle from
 * `dist/vendor/excalidraw-converter.mjs`. Build it lazily in test setup so
 * `npm test` stays self-sufficient; it is the project's own build script and
 * writes only its declared bundle output.
 */
before(() => {
  if (!existsSync("dist/vendor/excalidraw-converter.mjs")) {
    execFileSync("npm", ["run", "build:converter"], { stdio: "pipe" });
  }
});

/** Loose view of the Excalidraw elements the tests need to measure. */
interface AnyElement {
  id: string;
  type: string;
  text?: string;
  width?: number;
  containerId?: string;
  [key: string]: unknown;
}

interface LabelMetrics {
  elementCount: number;
  textCount: number;
  wrappedTextCount: number;
  overflowingTextCount: number;
  wrappedSamples: string[];
}

function measureLabels(elements: AnyElement[]): LabelMetrics {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const texts = elements.filter((element) => element.type === "text");
  const wrapped = texts.filter((element) => String(element.text ?? "").includes("\n"));
  const overflowing = texts.filter((element) => {
    if (!element.containerId) return false;
    const container = byId.get(element.containerId);
    return container ? (element.width ?? 0) > (container.width ?? 0) : false;
  });
  return {
    elementCount: elements.length,
    textCount: texts.length,
    wrappedTextCount: wrapped.length,
    overflowingTextCount: overflowing.length,
    wrappedSamples: wrapped.slice(0, 5).map((element) => JSON.stringify(element.text)),
  };
}

describe("mermaidToScene", () => {
  it("converts a real flowchart to non-empty elements with valid ids", async () => {
    const result = await mermaidToScene(FIXTURES[0]!.mermaid);
    const elements = result.scene.elements;
    assert.ok(elements.length > 0, "elements must not be empty");
    for (const element of elements) {
      assert.equal(typeof element.id, "string");
      assert.ok(element.id.length > 0);
    }
  });

  it("produces a scene that passes the elements-is-array contract check", async () => {
    const result = await mermaidToScene(FIXTURES[0]!.mermaid);
    assert.equal(Array.isArray(result.scene.elements), true);
    assert.equal(result.scene.type, "excalidraw");
    assert.equal(result.scene.version, 2);
    assert.equal(result.scene.source, "excalidraw-mcp");
    assert.deepEqual(result.scene.appState, {});
    assert.deepEqual(result.scene.files, {});
  });

  it("rejects empty Mermaid input with a typed error", async () => {
    await assert.rejects(() => mermaidToScene(""), InvalidMermaidError);
    await assert.rejects(() => mermaidToScene("   \n\t  "), InvalidMermaidError);
  });

  it("rejects unparseable Mermaid with a typed parse error", async () => {
    await assert.rejects(() => mermaidToScene("this is definitely not mermaid"), (error: unknown) => {
      assert.ok(error instanceof MermaidSceneError, "must be part of the typed hierarchy");
      assert.ok(error instanceof MermaidParseError);
      return true;
    });
  });

  it("detects the converter's graphImage fallback as an error instead of persisting it", async () => {
    // The dependency does not throw on a failed parse: it returns a single
    // placeholder `image` element. Feed exactly that skeleton shape through
    // the conversion step and require the typed error.
    await assert.rejects(
      () => convertSkeletons([{ type: "image", id: "fallback", width: 60, height: 20 }]),
      (error: unknown) => {
        assert.ok(error instanceof MermaidParseError);
        assert.match(error.message, /image/i);
        return true;
      },
    );
  });

  it("flattens subgraph blocks and reports the flattening", async () => {
    const withSubgraph = [
      "flowchart TD",
      "  A[Inicio] --> B[Proceso]",
      "  subgraph zona",
      "    B --> C[Fin]",
      "    C --> D[Archivo]",
      "  end",
      "  D --> A",
    ].join("\n");
    const result = await mermaidToScene(withSubgraph);
    assert.equal(result.metadata.mode, "subgraphs-flattened");
    assert.equal(result.metadata.removedSubgraphBlocks, 1);
    assert.ok(result.scene.elements.length > 0);
  });

  it("keeps mode direct when no flattening was needed", async () => {
    const result = await mermaidToScene(FIXTURES[0]!.mermaid);
    assert.equal(result.metadata.mode, "direct");
  });

  it("rejects input above the dependency's maxTextSize limit", async () => {
    const oversized = `flowchart TD\n  A[${"muito longo ".repeat(2000)}]`;
    assert.ok(oversized.length > 20000);
    await assert.rejects(() => mermaidToScene(oversized), (error: unknown) => {
      assert.ok(error instanceof MermaidLimitError);
      assert.match(error.message, /maxTextSize/);
      return true;
    });
  });

  it("rejects input above the dependency's maxEdges limit", async () => {
    const lines = ["flowchart TD"];
    for (let i = 0; i < 260; i++) {
      lines.push(`  A${i} --> A${i + 1}`);
    }
    await assert.rejects(() => mermaidToScene(lines.join("\n")), (error: unknown) => {
      assert.ok(error instanceof MermaidLimitError);
      assert.match(error.message, /maxEdges/);
      return true;
    });
  });

  it("reports a converter failure as a typed error", async () => {
    await assert.rejects(
      () => convertSkeletons([]),
      (error: unknown) => {
        assert.ok(error instanceof ConverterError);
        return true;
      },
    );
  });
});

describe("label layout calibration", () => {
  const table: Array<{ fixture: string; metrics: LabelMetrics; acceptance: string }> = [];

  for (const fixture of FIXTURES) {
    it(`measures "${fixture.name}"`, async () => {
      const result = await mermaidToScene(fixture.mermaid);
      const metrics = measureLabels(result.scene.elements as AnyElement[]);
      table.push({ fixture: fixture.name, metrics, acceptance: fixture.acceptance });

      if (fixture.acceptance === "zero-wrapped") {
        // Texts bound to rectangle or ellipse containers must fit exactly.
        const elements = result.scene.elements as AnyElement[];
        const byId = new Map(elements.map((element) => [element.id, element]));
        const containerBound = (elements as AnyElement[]).filter(
          (element) =>
            element.type === "text" &&
            element.containerId &&
            ["rectangle", "ellipse"].includes(byId.get(element.containerId)?.type ?? ""),
        );
        const wrapped = containerBound.filter((element) => String(element.text ?? "").includes("\n"));
        const overflowing = containerBound.filter((element) => {
          const container = byId.get(element.containerId!);
          return container ? (element.width ?? 0) > (container.width ?? 0) : false;
        });
        assert.deepEqual(
          { wrapped: wrapped.map((element) => element.text), overflowing: overflowing.map((element) => element.text) },
          { wrapped: [], overflowing: [] },
          `fixture "${fixture.name}" must have 0 wrapped and 0 overflowing rectangle/ellipse labels`,
        );
      }
      // "recorded" fixtures are measured and reported, never faked.
    });
  }

  it("prints the final calibration table to stderr", async () => {
    assert.ok(table.length >= 5, "all fixtures must have been measured");
    for (const row of table) {
      console.error(
        `[calibration] ${row.fixture}: elements=${row.metrics.elementCount} ` +
          `wrappedTextCount=${row.metrics.wrappedTextCount} ` +
          `overflowingTextCount=${row.metrics.overflowingTextCount} ` +
          `acceptance=${row.acceptance} ` +
          `samples=${JSON.stringify(row.metrics.wrappedSamples)}`,
      );
    }
  });
});
