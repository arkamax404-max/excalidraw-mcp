/**
 * Own layout for `erDiagram` input — no dependency on rendered SVG geometry.
 *
 * WHY THIS MODULE EXISTS (see `odd/notes/mermaid-node-spike.md`, T5 addendum):
 * `@excalidraw/mermaid-to-excalidraw`'s ER parser (`dist/parser/er.js`) derives
 * every position and size from the rendered SVG (`getBBox` plus accumulated
 * transforms). Under this project's DOM shim that geometry is fabricated
 * (`{x: 0, y: 0, approximate width}` per node), so the dependency's ER output
 * came out illegible: measured before this module existed — overlapping entity
 * rectangles, every attribute text outside its box, zero-size (vertical) arrows
 * and negative coordinates. The id-prefix selector fallback in `dom-shim.ts`
 * made ER diagrams *parse* through the dependency, which only made the broken
 * geometry reachable. Flowcharts are unaffected because dagre's layout inside
 * mermaid's flowchart db supplies real coordinates — the ER db does not.
 *
 * MERMAID DB ACCESSORS (discovered at runtime against mermaid 11.15.0):
 * - `mermaid.mermaidAPI.getDiagramFromText(text)` returns a `Diagram` whose
 *   `type` is `"er"` for ER input and whose `db` is the ER database.
 * - `db.getData()` is the accessor this module uses. It returns
 *   `{ nodes, edges }` where
 *   - `nodes[i] = { id: "entity-<NAME>-<n>", label: "<NAME>", alias, attributes:
 *     [{ type, name, keys: ["PK", ...], comment }] }` — one entry per entity,
 *     including entities declared without an attribute block;
 *   - `edges[j] = { id, start, end, label, arrowTypeStart, arrowTypeEnd, pattern }`
 *     where `start`/`end` reference the node `id`s (so the mapping needs no name
 *     resolution) and the arrow types carry the cardinalities (`"only_one"`,
 *     `"zero_or_more"`, ...).
 * - `db.getEntities()` / `db.getRelationships()` also exist, but
 *   `getRelationships()` returns names that do not line up with
 *   `getEntities()` keys under mermaid 11, and neither exposes the arrow types
 *   or the ids consistently; `getData()` is the single accessor that joins
 *   entities, relationship endpoints, cardinalities and the label in one call.
 * - `db.getDirection()` exists (`direction LR/TB`); the grid layout below does
 *   not consume it — recorded as a known, deliberate simplification.
 *
 * LAYOUT: one rectangle per entity sized from the text it will contain,
 * measured with the same shim helpers the converter itself measures with
 * (`canvasTextWidth`), so what we size for is exactly what gets rendered.
 * Entities are placed on a row-major grid with `ceil(sqrt(n))` columns; gaps
 * are wide enough that relationship labels fit between columns without
 * touching a box. Attribute texts are free (unbound) text elements placed
 * inside their box with margin — deliberately NOT bound labels, because a box
 * has exactly one bound label slot and vertical arrows must not carry bound
 * labels at all (spike note, residual risk 4). Relationship arrows connect box
 * edges with a deliberate ±12px spread so every arrow has non-zero width AND
 * height; self-relationships bulge out of the box's right edge with explicit
 * path points so they never degenerate to a zero-size element. Cardinality and
 * relationship label are free text at a fixed anchor near the arrow, never
 * bound to the arrow.
 *
 * The skeletons are the same flat shapes the dependency's ER converter
 * produces (`transformToExcalidrawContainerSkeleton` /
 * `transformToExcalidrawTextSkeleton` / `transformToExcalidrawArrowSkeleton`),
 * converted with the bundled converter so element defaults and id
 * regeneration stay consistent with the flowchart path.
 *
 * INITIALIZATION NOTE: mermaid must be initialized before
 * `getDiagramFromText` works. We initialize with a copy of the dependency's
 * own `MERMAID_CONFIG` (deep import from the pinned 2.2.2 package) rather than
 * an arbitrary config, because the dependency caches its config hash across
 * parses: initializing with anything else could leave a flowchart parse
 * running against our config after a hash match. With the dependency's own
 * config, a hash match is equivalent to a re-initialize.
 */

import { MERMAID_CONFIG } from "@excalidraw/mermaid-to-excalidraw/dist/constants.js";

import { canvasTextWidth } from "./dom-shim.ts";
import { MermaidLimitError, MermaidParseError } from "./errors.ts";
import type { ExcalidrawElement, MermaidSceneResult } from "./mermaid.ts";

/** Font size used for every ER text (the dependency's ERD constant). */
export const ER_FONT_SIZE = 18;

/** Height of the header zone above the attribute rows. */
export const ER_HEADER_ZONE = 34;
/** Vertical space reserved for one attribute row. */
export const ER_ROW_HEIGHT = 26;
/** Horizontal padding between box edge and text. */
export const ER_PAD_X = 16;
/** Vertical padding between box edge and text. */
export const ER_PAD_Y = 14;
/** Narrowest entity box. */
export const ER_MIN_BOX_WIDTH = 120;
/** Grid origin: everything is placed at strictly positive coordinates. */
export const ER_ORIGIN = 80;
/** Minimum horizontal gap between grid columns (fits relationship labels). */
export const ER_MIN_COL_GAP = 120;
/** Extra corridor allowance per label width when sizing the column gap. */
export const ER_COL_GAP_LABEL_ALLOWANCE = 60;
/** Minimum vertical gap between grid rows. */
export const ER_ROW_GAP = 96;
/** How far a self-relationship bulges out of its box. */
export const ER_SELF_LOOP_BULGE = 40;
/** Half of the deliberate ±12px spread that keeps arrows non-degenerate. */
export const ER_ARROW_SPREAD = 12;

/** Text height the converter measures for a single-line text element. */
export const ER_TEXT_HEIGHT = ER_FONT_SIZE * 1.25;

export interface ErAttribute {
  type: string;
  name: string;
  keys: string[];
  comment: string;
}

export interface ErEntity {
  id: string;
  name: string;
  alias: string;
  attributes: ErAttribute[];
}

export interface ErRelationship {
  id: string;
  startId: string;
  endId: string;
  label: string;
  startCardinality: string;
  endCardinality: string;
}

export interface ErModel {
  entities: ErEntity[];
  relationships: ErRelationship[];
}

/** Injected converter so this module stays free of the pipeline's imports. */
export interface ErSceneDependencies {
  convert: (skeletons: unknown[]) => Promise<ExcalidrawElement[]>;
  maxEdges: number;
}

interface ErRawAttribute {
  type?: unknown;
  name?: unknown;
  keys?: unknown;
  comment?: unknown;
}

interface ErRawNode {
  id?: unknown;
  label?: unknown;
  alias?: unknown;
  attributes?: unknown;
}

interface ErRawEdge {
  id?: unknown;
  start?: unknown;
  end?: unknown;
  label?: unknown;
  arrowTypeStart?: unknown;
  arrowTypeEnd?: unknown;
}

interface ErRawData {
  nodes?: unknown;
  edges?: unknown;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/**
 * Reads the ER model out of mermaid's diagram db. Exported for tests; the
 * accessor discovery is documented in the module header.
 */
export function extractErModel(db: unknown): ErModel {
  const getData = (db as { getData?: () => unknown } | null | undefined)?.getData;
  if (typeof getData !== "function") {
    throw new MermaidParseError("mermaid's ER database exposes no getData() accessor");
  }
  let data: ErRawData;
  try {
    data = (getData.call(db) ?? {}) as ErRawData;
  } catch (error: unknown) {
    throw new MermaidParseError("reading the ER model from mermaid's database failed", { cause: error });
  }
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new MermaidParseError("mermaid's ER database returned no entities or relationships");
  }

  const entities: ErEntity[] = data.nodes.map((raw: unknown) => {
    const node = (raw ?? {}) as ErRawNode;
    const attributes = (Array.isArray(node.attributes) ? node.attributes : []).map(
      (attribute: unknown): ErAttribute => {
        const attr = (attribute ?? {}) as ErRawAttribute;
        return {
          type: asString(attr.type),
          name: asString(attr.name),
          keys: asStringArray(attr.keys),
          comment: asString(attr.comment),
        };
      },
    );
    return {
      id: asString(node.id),
      name: asString(node.label),
      alias: asString(node.alias),
      attributes,
    };
  });

  const relationships: ErRelationship[] = data.edges.map((raw: unknown) => {
    const edge = (raw ?? {}) as ErRawEdge;
    return {
      id: asString(edge.id),
      startId: asString(edge.start),
      endId: asString(edge.end),
      label: asString(edge.label),
      startCardinality: asString(edge.arrowTypeStart),
      endCardinality: asString(edge.arrowTypeEnd),
    };
  });

  return { entities, relationships };
}

/** Cardinality glyph mermaid draws for an arrow type, as written in text. */
const cardinalityGlyph = (arrowType: string): string => {
  switch (arrowType) {
    case "only_one":
      return "1";
    case "zero_or_one":
      return "0..1";
    case "one_or_more":
      return "1..*";
    case "zero_or_more":
      return "0..*";
    case "many":
      return "*";
    default:
      return "";
  }
};

/** Arrowhead type the converter expects for a mermaid arrow type. */
const cardinalityArrowhead = (arrowType: string): string | null => {
  switch (arrowType) {
    case "one":
      return "cardinality_one";
    case "many":
      return "cardinality_many";
    case "only_one":
      return "cardinality_exactly_one";
    case "one_or_more":
      return "cardinality_one_or_many";
    case "zero_or_one":
      return "cardinality_zero_or_one";
    case "zero_or_more":
      return "cardinality_zero_or_many";
    default:
      return null;
  }
};

/** The header line written into an entity box (name plus alias when present). */
export const erHeaderText = (entity: ErEntity): string =>
  entity.alias ? `${entity.name} [${entity.alias}]` : entity.name;

/** One attribute row as written inside the box: `type name KEYS "comment"`. */
export const erAttributeText = (attribute: ErAttribute): string =>
  [attribute.type, attribute.name, ...attribute.keys]
    .filter((part) => part !== "")
    .join(" ") + (attribute.comment ? ` "${attribute.comment}"` : "");

/** The label written at a relationship arrow: `cardinality label cardinality`. */
export const erRelationshipText = (relationship: ErRelationship): string =>
  [
    cardinalityGlyph(relationship.startCardinality),
    relationship.label,
    cardinalityGlyph(relationship.endCardinality),
  ]
    .filter((part) => part !== "")
    .join(" ");

interface EntityBox {
  id: string;
  col: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

const textWidth = (text: string): number => canvasTextWidth(text);

/**
 * Builds a free (unbound) text skeleton. Shared with the flowchart layout
 * module, which places edge labels the same way.
 */
export const textSkeleton = (text: string, position: Point): Record<string, unknown> => ({
  type: "text",
  x: position.x,
  y: position.y,
  width: textWidth(text),
  height: ER_TEXT_HEIGHT,
  text,
  fontSize: ER_FONT_SIZE,
});

/**
 * Builds an arrow skeleton with a start/end binding and an empty (skipped)
 * label slot. Shared with the flowchart layout module; see the er.ts header
 * for why the label slot stays empty and unbound.
 */
export const arrowSkeleton = (options: {
  from: Point;
  points: number[][];
  startId: string;
  endId: string;
  startArrowhead: string | null;
  endArrowhead: string | null;
}): Record<string, unknown> => {
  const xs = options.points.map((point) => point[0] ?? 0);
  const ys = options.points.map((point) => point[1] ?? 0);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return {
    type: "arrow",
    x: options.from.x,
    y: options.from.y,
    // The empty label matches the dependency's arrow skeletons: the converter
    // skips it instead of binding a stray empty text to the arrow.
    label: { text: "", fontSize: 16 },
    width,
    height,
    points: options.points,
    strokeStyle: "solid",
    startArrowhead: options.startArrowhead,
    endArrowhead: options.endArrowhead,
    start: { type: "rectangle", id: options.startId },
    end: { type: "rectangle", id: options.endId },
  };
};

/**
 * Builds the flat Excalidraw skeletons for an ER model with the project's own
 * grid layout. Pure: no mermaid, no DOM, no converter — all geometry decisions
 * are visible here and testable without the pipeline.
 */
export function buildErSkeletons(model: ErModel): unknown[] {
  const entities = model.entities;
  const count = entities.length;

  const header = (entity: ErEntity): string => erHeaderText(entity);
  const rows = (entity: ErEntity): string[] => entity.attributes.map(erAttributeText);

  const relationshipLabel = (relationship: ErRelationship): string =>
    erRelationshipText(relationship);
  const maxRelationshipLabelWidth = model.relationships.reduce(
    (max, relationship) => Math.max(max, textWidth(relationshipLabel(relationship))),
    0,
  );
  const colGap = Math.max(ER_MIN_COL_GAP, maxRelationshipLabelWidth + ER_COL_GAP_LABEL_ALLOWANCE);
  const rowGap = ER_ROW_GAP;

  const boxWidth = (entity: ErEntity): number =>
    Math.max(
      ER_MIN_BOX_WIDTH,
      textWidth(header(entity)),
      ...rows(entity).map((row) => textWidth(row)),
    ) + 2 * ER_PAD_X;
  const boxHeight = (entity: ErEntity): number =>
    ER_PAD_Y + ER_HEADER_ZONE + entity.attributes.length * ER_ROW_HEIGHT + ER_PAD_Y;

  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const colWidths = new Array<number>(cols).fill(0);
  const rowHeights = new Array<number>(Math.max(1, Math.ceil(count / cols))).fill(0);
  entities.forEach((entity, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    colWidths[col] = Math.max(colWidths[col]!, boxWidth(entity));
    rowHeights[row] = Math.max(rowHeights[row]!, boxHeight(entity));
  });
  const colX = new Array<number>(cols).fill(ER_ORIGIN);
  for (let c = 1; c < cols; c++) {
    colX[c] = colX[c - 1]! + colWidths[c - 1]! + colGap;
  }
  const rowY = new Array<number>(rowHeights.length).fill(ER_ORIGIN);
  for (let r = 1; r < rowHeights.length; r++) {
    rowY[r] = rowY[r - 1]! + rowHeights[r - 1]! + rowGap;
  }

  const boxes = new Map<string, EntityBox>();
  entities.forEach((entity, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    boxes.set(entity.id, {
      id: entity.id,
      col,
      row,
      x: colX[col]!,
      y: rowY[row]!,
      width: boxWidth(entity),
      height: boxHeight(entity),
    });
  });

  const skeletons: unknown[] = [];

  // Entity rectangles with their bound header label and free attribute rows.
  for (const entity of entities) {
    const box = boxes.get(entity.id)!;
    skeletons.push({
      type: "rectangle",
      id: box.id,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      label: {
        text: header(entity),
        fontSize: ER_FONT_SIZE,
        textAlign: "center",
        verticalAlign: "top",
      },
    });
    rows(entity).forEach((row, index) => {
      skeletons.push(
        textSkeleton(row, {
          x: box.x + ER_PAD_X,
          y: box.y + ER_PAD_Y + ER_HEADER_ZONE + index * ER_ROW_HEIGHT,
        }),
      );
    });
  }

  // One arrow per relationship, plus its free cardinality/label text.
  for (const relationship of model.relationships) {
    const startBox = boxes.get(relationship.startId);
    const endBox = boxes.get(relationship.endId);
    if (!startBox || !endBox) {
      continue; // a dangling endpoint cannot be drawn; mermaid would not render it either
    }
    const startArrowhead = cardinalityArrowhead(relationship.startCardinality);
    const endArrowhead = cardinalityArrowhead(relationship.endCardinality);
    const label = relationshipLabel(relationship);
    const labelWidth = textWidth(label);

    let labelPosition: Point;
    if (startBox.id === endBox.id) {
      // Self-relationship: bulge out of the right edge with explicit points so
      // the arrow never collapses to a zero-size element.
      const x = startBox.x + startBox.width;
      const y = startBox.y + startBox.height / 2;
      const from = { x, y: y - 2 * ER_ARROW_SPREAD };
      skeletons.push(
        arrowSkeleton({
          from,
          points: [
            [0, 0],
            [ER_SELF_LOOP_BULGE, 0],
            [ER_SELF_LOOP_BULGE, 4 * ER_ARROW_SPREAD],
            [0, 4 * ER_ARROW_SPREAD],
          ],
          startId: relationship.startId,
          endId: relationship.endId,
          startArrowhead,
          endArrowhead,
        }),
      );
      labelPosition = {
        x: x + ER_SELF_LOOP_BULGE + 6,
        y: y - 2 * ER_ARROW_SPREAD,
      };
    } else if (startBox.col !== endBox.col) {
      // Different columns: horizontal arrow along the column corridor, with a
      // deliberate vertical spread so the arrow has non-zero height.
      const rightwards = endBox.x >= startBox.x + startBox.width;
      const leftBox = rightwards ? startBox : endBox;
      const rightBox = rightwards ? endBox : startBox;
      const y1 = leftBox.y + leftBox.height / 2 - ER_ARROW_SPREAD;
      const y2 = rightBox.y + rightBox.height / 2 + ER_ARROW_SPREAD;
      const from = rightwards
        ? { x: startBox.x + startBox.width, y: startBox.y + startBox.height / 2 - ER_ARROW_SPREAD }
        : { x: startBox.x, y: startBox.y + startBox.height / 2 - ER_ARROW_SPREAD };
      const to = rightwards
        ? { x: endBox.x, y: endBox.y + endBox.height / 2 + ER_ARROW_SPREAD }
        : { x: endBox.x + endBox.width, y: endBox.y + endBox.height / 2 + ER_ARROW_SPREAD };
      skeletons.push(
        arrowSkeleton({
          from,
          points: [
            [0, 0],
            [to.x - from.x, to.y - from.y],
          ],
          startId: relationship.startId,
          endId: relationship.endId,
          startArrowhead,
          endArrowhead,
        }),
      );
      // Label anchored in the corridor right of the left box; the column gap
      // is sized from the widest label, so it never reaches the next column.
      labelPosition = {
        x: leftBox.x + leftBox.width + 10,
        y: Math.min(y1, y2) - 2.5 * ER_TEXT_HEIGHT,
      };
      void labelWidth;
    } else {
      // Same column, different rows: vertical arrow down the row corridor,
      // with a deliberate horizontal spread so the arrow has non-zero width.
      const downwards = endBox.y > startBox.y;
      const from = downwards
        ? { x: startBox.x + startBox.width / 2 - ER_ARROW_SPREAD, y: startBox.y + startBox.height }
        : { x: startBox.x + startBox.width / 2 - ER_ARROW_SPREAD, y: startBox.y };
      const to = downwards
        ? { x: endBox.x + endBox.width / 2 + ER_ARROW_SPREAD, y: endBox.y }
        : { x: endBox.x + endBox.width / 2 + ER_ARROW_SPREAD, y: endBox.y + endBox.height };
      skeletons.push(
        arrowSkeleton({
          from,
          points: [
            [0, 0],
            [to.x - from.x, to.y - from.y],
          ],
          startId: relationship.startId,
          endId: relationship.endId,
          startArrowhead,
          endArrowhead,
        }),
      );
      // Label centered on the arrow inside the empty row corridor.
      labelPosition = {
        x: (from.x + to.x) / 2 - labelWidth / 2,
        y: downwards ? startBox.y + startBox.height + 8 : endBox.y + endBox.height + 8,
      };
    }
    if (label !== "") {
      skeletons.push(textSkeleton(label, labelPosition));
    }
  }

  return skeletons;
}

/**
 * Converts Mermaid `erDiagram` text into an Excalidraw scene using this
 * project's own ER layout. Must be called after the DOM shim is installed
 * (the pipeline does this before routing); mermaid is initialized here with
 * the dependency's own config so `getDiagramFromText` works standalone too.
 */
export async function erDiagramToScene(
  mermaidText: string,
  deps: ErSceneDependencies,
): Promise<MermaidSceneResult> {
  const { installDomShim } = await import("./dom-shim.ts");
  installDomShim();
  const mermaid = ((await import("mermaid")) as { default: { mermaidAPI: { initialize: (config: unknown) => void; getDiagramFromText: (text: string) => Promise<{ type?: unknown; db?: unknown }> } } }).default;
  mermaid.mermaidAPI.initialize({ ...MERMAID_CONFIG });

  let diagram: { type?: unknown; db?: unknown };
  try {
    diagram = await mermaid.mermaidAPI.getDiagramFromText(mermaidText);
  } catch (error: unknown) {
    throw new MermaidParseError("Mermaid could not be parsed", { cause: error });
  }
  if (diagram?.type !== "er") {
    throw new MermaidParseError(`expected an er diagram, got ${String(diagram?.type ?? "unknown")}`);
  }
  const model = extractErModel(diagram.db);
  if (model.relationships.length > deps.maxEdges) {
    throw new MermaidLimitError(
      `Mermaid input exceeds maxEdges ${deps.maxEdges} (${model.relationships.length} ER relationships); the dependency would truncate it`,
    );
  }

  const skeletons = buildErSkeletons(model);
  const elements = await deps.convert(skeletons);

  const scene = {
    type: "excalidraw",
    version: 2,
    source: "excalidraw-mcp",
    elements,
    appState: {},
    files: {},
  } as const;
  return {
    scene,
    metadata: {
      skeletonElementCount: skeletons.length,
      elementCount: elements.length,
    },
  };
}
