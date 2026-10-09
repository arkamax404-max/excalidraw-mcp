import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { before, describe, it } from "node:test";

import { UnsupportedDiagramError } from "./errors.ts";
import {
  FLOW_FONT_SIZE,
  FLOW_LABEL_SAFETY,
  FLOW_MAX_LABEL_WIDTH,
  FLOW_PAD_X,
  wrapFlowLabel,
} from "./flowchart.ts";
import { mermaidToScene } from "./mermaid.ts";
import { nodeLabelWidth } from "./dom-shim.ts";
import { FLOWCHART_FIXTURES, type FlowFixture } from "./fixtures.ts";

/**
 * Geometric acceptance tests for flowcharts.
 *
 * Flowcharts are laid out by this project's own flowchart module
 * (`src/scene/flowchart.ts`) — NOT by mermaid/dagre. Under jsdom mermaid
 * reserves a constant ~74 px per node regardless of label length, so boxes
 * 720–1040 px wide ended up stacked 74 px apart: 22 overlapping box pairs at
 * 100 % overlap on a real diagram (see `odd/notes/mermaid-node-spike.md`).
 * Element counts alone cannot catch that, so every criterion here is
 * measured from the produced scene's geometry:
 *
 * - one container per node (rectangle, ellipse or diamond with a bound label);
 * - no two node containers overlap;
 * - no coordinate is negative (including arrow points);
 * - every node label lies inside its own container;
 * - every arrow has non-zero width AND height;
 * - no text is bound to an arrow (vertical arrows have near-zero bounding
 *   boxes and clip bound labels);
 * - no placeholder `image` element;
 * - the declared rank count and direction are honoured.
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
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  containerId?: string;
  points?: number[][];
  [key: string]: unknown;
}

interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FlowGeometryMetrics {
  nodeContainers: number;
  nodeOverlaps: number;
  subgraphContainers: number;
  negativeCoordinates: number;
  labelsOutsideTheirBox: number;
  arrows: number;
  zeroSizeArrows: number;
  textsBoundToArrows: number;
  imageElements: number;
  distinctRankLevels: number;
}

/** Containers are the node/subgraph boxes: rectangle, ellipse or diamond. */
const isContainerType = (type: string): boolean =>
  type === "rectangle" || type === "ellipse" || type === "diamond";

function measureFlowGeometry(elements: AnyElement[], direction: "TB" | "LR" = "TB"): FlowGeometryMetrics {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const boundTexts = elements.filter(
    (element): element is AnyElement & { containerId: string } =>
      element.type === "text" && typeof element.containerId === "string",
  );
  const containers = elements.filter((element) => isContainerType(element.type));
  // A node container carries exactly one bound label; subgraph containers are
  // drawn without one (their title is free text) and are counted separately.
  const nodeBoxes: Box[] = [];
  let subgraphContainers = 0;
  for (const container of containers) {
    const hasBoundLabel = boundTexts.some((text) => text.containerId === container.id);
    if (hasBoundLabel) {
      nodeBoxes.push({
        id: container.id,
        x: container.x,
        y: container.y,
        width: container.width ?? 0,
        height: container.height ?? 0,
      });
    } else {
      subgraphContainers++;
    }
  }

  let overlaps = 0;
  for (let i = 0; i < nodeBoxes.length; i++) {
    for (let j = i + 1; j < nodeBoxes.length; j++) {
      const a = nodeBoxes[i]!;
      const b = nodeBoxes[j]!;
      const separated =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      if (!separated) overlaps++;
    }
  }

  const negativeCoordinates = elements.filter((element) => {
    if (element.x < 0 || element.y < 0) return true;
    return (element.points ?? []).some((point) => {
      const px = point[0] ?? 0;
      const py = point[1] ?? 0;
      return element.x + px < 0 || element.y + py < 0;
    });
  }).length;

  const inside = (text: AnyElement, box: Box): boolean =>
    text.x >= box.x &&
    text.x + (text.width ?? 0) <= box.x + box.width &&
    text.y >= box.y &&
    text.y + (text.height ?? 0) <= box.y + box.height;
  const boxesById = new Map(nodeBoxes.map((box) => [box.id, box]));
  const labelsOutsideTheirBox = boundTexts.filter((text) => {
    const box = boxesById.get(text.containerId);
    return box ? !inside(text, box) : false;
  }).length;

  const arrows = elements.filter((element) => element.type === "arrow");
  const zeroSizeArrows = arrows.filter(
    (arrow) => (arrow.width ?? 0) <= 0 || (arrow.height ?? 0) <= 0,
  ).length;
  const textsBoundToArrows = boundTexts.filter(
    (text) => byId.get(text.containerId)?.type === "arrow",
  ).length;

  const imageElements = elements.filter((element) => element.type === "image").length;

  // Ranks stack on the direction's cross axis: y-levels in TB, x-columns in LR.
  const rankAxisValues = nodeBoxes.map((box) => (direction === "LR" ? box.x : box.y));
  const distinctRankLevels = new Set(rankAxisValues.map((value) => Math.round(value))).size;

  return {
    nodeContainers: nodeBoxes.length,
    nodeOverlaps: overlaps,
    subgraphContainers,
    negativeCoordinates,
    labelsOutsideTheirBox,
    arrows: arrows.length,
    zeroSizeArrows,
    textsBoundToArrows,
    imageElements,
    distinctRankLevels,
  };
}

describe("flowchart geometry", () => {
  const table: Array<{ fixture: string; metrics: FlowGeometryMetrics }> = [];

  for (const fixture of FLOWCHART_FIXTURES) {
    it(`lays out "${fixture.name}" with readable geometry`, async () => {
      const result = await mermaidToScene(fixture.mermaid);
      const elements = result.scene.elements as AnyElement[];
      const metrics = measureFlowGeometry(elements, fixture.direction);
      table.push({ fixture: fixture.name, metrics });

      const problems: string[] = [];
      if (metrics.nodeContainers !== fixture.nodes) {
        problems.push(`expected ${fixture.nodes} node containers, got ${metrics.nodeContainers}`);
      }
      if (metrics.nodeOverlaps !== 0) {
        problems.push(`${metrics.nodeOverlaps} overlapping node box pairs`);
      }
      if (metrics.subgraphContainers !== fixture.subgraphs) {
        problems.push(`expected ${fixture.subgraphs} subgraph containers, got ${metrics.subgraphContainers}`);
      }
      if (metrics.negativeCoordinates !== 0) {
        problems.push(`${metrics.negativeCoordinates} elements at negative coordinates`);
      }
      if (metrics.labelsOutsideTheirBox !== 0) {
        problems.push(`${metrics.labelsOutsideTheirBox} node labels outside their box`);
      }
      if (metrics.arrows !== fixture.edges) {
        problems.push(`expected ${fixture.edges} arrows, got ${metrics.arrows}`);
      }
      if (metrics.zeroSizeArrows !== 0) {
        problems.push(`${metrics.zeroSizeArrows} arrows with zero width or height`);
      }
      if (metrics.textsBoundToArrows !== 0) {
        problems.push(`${metrics.textsBoundToArrows} texts bound to arrows (clipped labels)`);
      }
      if (metrics.imageElements !== 0) {
        problems.push(`${metrics.imageElements} placeholder image elements`);
      }
      if (metrics.distinctRankLevels !== fixture.ranks) {
        problems.push(`expected ${fixture.ranks} distinct rank levels, got ${metrics.distinctRankLevels}`);
      }
      assert.deepEqual(problems, [], `fixture "${fixture.name}" geometry violations`);
    });
  }

  it("prints the flowchart geometry measurement table to stderr", () => {
    assert.ok(table.length >= FLOWCHART_FIXTURES.length, "all flowchart fixtures must have been measured");
    for (const row of table) {
      console.error(
        `[flow-geometry] ${row.fixture}: nodes=${row.metrics.nodeContainers} ` +
          `overlaps=${row.metrics.nodeOverlaps} subgraphs=${row.metrics.subgraphContainers} ` +
          `negative=${row.metrics.negativeCoordinates} labelsOutside=${row.metrics.labelsOutsideTheirBox} ` +
          `arrows=${row.metrics.arrows} zeroSizeArrows=${row.metrics.zeroSizeArrows} ` +
          `textsBoundToArrows=${row.metrics.textsBoundToArrows} images=${row.metrics.imageElements} ` +
          `ranks=${row.metrics.distinctRankLevels}`,
      );
    }
  });
});

describe("flowchart direction", () => {
  it("honours LR: every connected pair is laid out left-to-right", async () => {
    const fixture = FLOWCHART_FIXTURES.find((entry) => entry.direction === "LR")!;
    const result = await mermaidToScene(fixture.mermaid);
    const elements = result.scene.elements as AnyElement[];
    const boxes = elements.filter(
      (element) => isContainerType(element.type) && typeof element.width === "number",
    );
    assert.equal(boxes.length, fixture.nodes);
    // All three arrows are forward edges between adjacent ranks; in LR every
    // target box must start strictly right of where its source box ends.
    const arrows = elements.filter((element) => element.type === "arrow");
    assert.equal(arrows.length, fixture.edges);
    const rightwards = (arrow: AnyElement): boolean => {
      const endX = arrow.x + (arrow.points?.[arrow.points.length - 1]?.[0] ?? arrow.width ?? 0);
      // The arrow span must be horizontal and connect two distinct columns.
      const span = endX - arrow.x;
      return span > (arrow.height ?? 0);
    };
    for (const arrow of arrows) {
      assert.ok(rightwards(arrow), "every LR arrow must span horizontally left-to-right");
    }
    // And the columns must actually be distinct: 3 rank levels on x.
    const columns = new Set(boxes.map((box) => Math.round(box.x)));
    assert.ok(columns.size >= 3, `expected >=3 distinct x columns, got ${columns.size}`);
  });
});

describe("flowchart routing", () => {
  it("raises the typed unsupported error for a sequence diagram, naming the type and the supported list", async () => {
    await assert.rejects(
      () => mermaidToScene("sequenceDiagram\n  Alice->>Bob: Hola\n  Bob-->>Alice: Hola"),
      (error: unknown) => {
        assert.ok(error instanceof UnsupportedDiagramError);
        assert.match(error.message, /sequence/);
        assert.match(error.message, /flowchart/);
        assert.match(error.message, /ER/);
        return true;
      },
    );
  });

  it("raises the typed unsupported error for a pie chart", async () => {
    await assert.rejects(
      () => mermaidToScene('pie\n  "manzanas": 40\n  "naranjas": 60'),
      (error: unknown) => {
        assert.ok(error instanceof UnsupportedDiagramError);
        assert.match(error.message, /pie/);
        return true;
      },
    );
  });

  it("keeps scene metadata consistent on the flowchart path", async () => {
    const result = await mermaidToScene(FLOWCHART_FIXTURES[0]!.mermaid);
    assert.equal(result.metadata.elementCount, result.scene.elements.length);
    assert.ok(result.metadata.skeletonElementCount > 0);
    assert.deepEqual(Object.keys(result.metadata).sort(), ["elementCount", "skeletonElementCount"]);
  });

  it("raises the typed parse error for an unparseable flowchart", async () => {
    await assert.rejects(() => mermaidToScene("flowchart TD\n  A[Inicio] --> {broken"));
    // The rejection type is asserted by mermaid.test.ts; here we only guard
    // that the flowchart routing does not swallow it into a scene.
  });
});

/**
 * Label wrapping and box sizing.
 *
 * Narrow boxes with two or three lines of text read better than one long line
 * spanning the diagram, and every line has to fit inside its own box: a first
 * attempt sized boxes with the shim's estimate alone and the rendered PNG
 * showed labels spilling over the border, which is why sizing and wrapping now
 * share one measurement and a safety factor.
 */
describe("flowchart label wrapping", () => {
  it("keeps a short label on one line", () => {
    assert.deepEqual(wrapFlowLabel("Usuario registrado"), ["Usuario registrado"]);
  });

  it("wraps a long label at the width limit", () => {
    const lines = wrapFlowLabel(
      "maintenanceorder_header1: orden, tipo y centro de responsabilidad",
    );
    assert.ok(lines.length > 1, "a long label must wrap");
    for (const line of lines) {
      // A line made of a single long word is deliberately left whole: breaking
      // a word reads worse than a wide box.
      if (!line.includes(" ")) {
        continue;
      }
      assert.ok(
        nodeLabelWidth(line, FLOW_FONT_SIZE) * FLOW_LABEL_SAFETY <= FLOW_MAX_LABEL_WIDTH + 1,
        `line "${line}" should fit the limit`,
      );
    }
    assert.equal(lines.join(" ").replace(/\s+/g, " "), "maintenanceorder_header1: orden, tipo y centro de responsabilidad");
  });

  it("leaves a single word longer than the limit whole", () => {
    const word = "x".repeat(120);
    assert.deepEqual(wrapFlowLabel(word), [word]);
  });

  it("never produces a box wider than the limit plus padding", async () => {
    const scene = await mermaidToScene(
      "flowchart TD\n  A[Un rotulo bastante largo que deberia partirse en varias lineas] --> B[Corto]\n",
    );
    const elements = scene.scene.elements as unknown as {
      type?: string;
      width?: number;
      text?: string;
    }[];
    const boxes = elements.filter((element) => element.type === "rectangle");
    assert.ok(boxes.length >= 2);
    for (const box of boxes) {
      const width = box.width ?? 0;
      assert.ok(
        width <= FLOW_MAX_LABEL_WIDTH + 2 * FLOW_PAD_X + 1,
        `box width ${width} should stay within the limit`,
      );
    }
    const labels = elements.filter((element) => element.type === "text").map((element) => String(element.text ?? ""));
    assert.ok(
      labels.some((label) => label.includes("\n")),
      "the long label must be wrapped onto more than one line",
    );
  });
});
