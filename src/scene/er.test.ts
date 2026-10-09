import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MermaidParseError } from "./errors.ts";
import { mermaidToScene } from "./mermaid.ts";
import {
  ER_FIXTURE,
  ER_LONG_NAME_FIXTURE,
  ER_MANY_ATTRIBUTES_FIXTURE,
  ER_SELF_RELATIONSHIP_FIXTURE,
  ER_SINGLE_ENTITY_FIXTURE,
  ER_TWO_RELATIONSHIPS_FIXTURE,
  type ErFixture,
} from "./fixtures.ts";

/**
 * Geometric acceptance tests for ER diagrams.
 *
 * Element counts and types alone passed while ER scenes were illegible
 * (measured before this module existed: 35 negative-coordinate elements,
 * all attribute texts outside their boxes, zero-size arrows). The criteria
 * here are therefore measured, not counted:
 *
 * - one rectangle per entity;
 * - no two entity rectangles overlap;
 * - no coordinate is negative;
 * - every attribute text lies inside its own entity rectangle;
 * - every relationship arrow has non-zero width and height;
 * - no placeholder `image` element (the dependency's silent fallback).
 */

const ER_FIXTURES: ErFixture[] = [
  ER_FIXTURE,
  ER_SINGLE_ENTITY_FIXTURE,
  ER_TWO_RELATIONSHIPS_FIXTURE,
  ER_SELF_RELATIONSHIP_FIXTURE,
  ER_MANY_ATTRIBUTES_FIXTURE,
  ER_LONG_NAME_FIXTURE,
];

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

interface ErGeometryMetrics {
  rectangles: number;
  rectangleOverlaps: number;
  negativeCoordinates: number;
  attributeTextsOutsideTheirBox: number;
  attributeTextsInsideBoxes: number;
  arrows: number;
  zeroSizeArrows: number;
  imageElements: number;
}

function measureErGeometry(elements: AnyElement[]): ErGeometryMetrics {
  const rects = elements.filter((element) => element.type === "rectangle");
  const arrows = elements.filter((element) => element.type === "arrow");
  const images = elements.filter((element) => element.type === "image");

  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      const separated =
        a.x + (a.width ?? 0) <= b.x ||
        b.x + (b.width ?? 0) <= a.x ||
        a.y + (a.height ?? 0) <= b.y ||
        b.y + (b.height ?? 0) <= a.y;
      if (!separated) overlaps++;
    }
  }

  const negative = elements.filter((element) => {
    if (element.x < 0 || element.y < 0) return true;
    return (element.points ?? []).some((point) => {
      const px = point[0] ?? 0;
      const py = point[1] ?? 0;
      return element.x + px < 0 || element.y + py < 0;
    });
  }).length;

  // Free texts (no containerId) are attribute rows and relationship labels.
  // Attribute rows must sit fully inside exactly one entity rectangle; a text
  // that intersects a rectangle without being contained would be clipped.
  const texts = elements.filter((element) => element.type === "text" && !element.containerId);
  const contained = (text: AnyElement, rect: AnyElement): boolean =>
    text.x >= rect.x &&
    text.x + (text.width ?? 0) <= rect.x + (rect.width ?? 0) &&
    text.y >= rect.y &&
    text.y + (text.height ?? 0) <= rect.y + (rect.height ?? 0);
  const intersects = (text: AnyElement, rect: AnyElement): boolean =>
    text.x < rect.x + (rect.width ?? 0) &&
    rect.x < text.x + (text.width ?? 0) &&
    text.y < rect.y + (rect.height ?? 0) &&
    rect.y < text.y + (text.height ?? 0);
  let attributeTextsInsideBoxes = 0;
  let attributeTextsOutsideTheirBox = 0;
  for (const text of texts) {
    const containing = rects.filter((rect) => contained(text, rect));
    if (containing.length > 0) {
      attributeTextsInsideBoxes++;
      continue;
    }
    if (rects.some((rect) => intersects(text, rect))) {
      attributeTextsOutsideTheirBox++; // clipped by a box edge: illegible
    }
  }

  const zeroSizeArrows = arrows.filter(
    (arrow) => (arrow.width ?? 0) <= 0 || (arrow.height ?? 0) <= 0,
  ).length;

  return {
    rectangles: rects.length,
    rectangleOverlaps: overlaps,
    negativeCoordinates: negative,
    attributeTextsOutsideTheirBox,
    attributeTextsInsideBoxes,
    arrows: arrows.length,
    zeroSizeArrows,
    imageElements: images.length,
  };
}

describe("er diagram geometry", () => {
  const table: Array<{ fixture: string; metrics: ErGeometryMetrics }> = [];

  for (const fixture of ER_FIXTURES) {
    it(`lays out "${fixture.name}" with readable geometry`, async () => {
      const result = await mermaidToScene(fixture.mermaid);
      const metrics = measureErGeometry(result.scene.elements as AnyElement[]);
      table.push({ fixture: fixture.name, metrics });

      const problems: string[] = [];
      if (metrics.rectangles !== fixture.entities) {
        problems.push(`expected ${fixture.entities} entity rectangles, got ${metrics.rectangles}`);
      }
      if (metrics.rectangleOverlaps !== 0) {
        problems.push(`${metrics.rectangleOverlaps} overlapping rectangle pairs`);
      }
      if (metrics.negativeCoordinates !== 0) {
        problems.push(`${metrics.negativeCoordinates} elements at negative coordinates`);
      }
      if (metrics.attributeTextsOutsideTheirBox !== 0) {
        problems.push(`${metrics.attributeTextsOutsideTheirBox} texts clipped by a box edge`);
      }
      if (metrics.attributeTextsInsideBoxes !== fixture.attributes) {
        problems.push(
          `expected ${fixture.attributes} attribute texts inside entity boxes, got ${metrics.attributeTextsInsideBoxes}`,
        );
      }
      if (metrics.arrows !== fixture.relationships) {
        problems.push(`expected ${fixture.relationships} relationship arrows, got ${metrics.arrows}`);
      }
      if (metrics.zeroSizeArrows !== 0) {
        problems.push(`${metrics.zeroSizeArrows} arrows with zero width or height`);
      }
      if (metrics.imageElements !== 0) {
        problems.push(`${metrics.imageElements} placeholder image elements`);
      }
      assert.deepEqual(problems, [], `fixture "${fixture.name}" geometry violations`);
    });
  }

  it("prints the ER geometry measurement table to stderr", () => {
    assert.ok(table.length >= 6, "all ER fixtures must have been measured");
    for (const row of table) {
      console.error(
        `[er-geometry] ${row.fixture}: rectangles=${row.metrics.rectangles} ` +
          `overlaps=${row.metrics.rectangleOverlaps} negative=${row.metrics.negativeCoordinates} ` +
          `textsInside=${row.metrics.attributeTextsInsideBoxes} ` +
          `textsClipped=${row.metrics.attributeTextsOutsideTheirBox} ` +
          `arrows=${row.metrics.arrows} zeroSizeArrows=${row.metrics.zeroSizeArrows} ` +
          `images=${row.metrics.imageElements}`,
      );
    }
  });
});

describe("er routing", () => {
  it("raises the typed parse error for an invalid erDiagram", async () => {
    await assert.rejects(() => mermaidToScene("erDiagram\n  BROKEN {"), (error: unknown) => {
      assert.ok(error instanceof MermaidParseError, "must be the typed parse error");
      return true;
    });
  });

  it("keeps scene metadata consistent on the ER path", async () => {
    const result = await mermaidToScene(ER_SINGLE_ENTITY_FIXTURE.mermaid);
    assert.equal(result.metadata.elementCount, result.scene.elements.length);
    assert.ok(result.metadata.skeletonElementCount > 0);
    assert.deepEqual(Object.keys(result.metadata).sort(), ["elementCount", "skeletonElementCount"]);
  });
});
