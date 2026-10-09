/**
 * Own layout for flowchart input (`flowchart` / `graph`) — no dependency on
 * rendered SVG geometry and no dependency on mermaid's layout engine.
 *
 * WHY THIS MODULE EXISTS (see `odd/notes/mermaid-node-spike.md`): mermaid's
 * flowchart layout (dagre) runs inside jsdom with no real text metrics, so it
 * reserves a CONSTANT ~74 px per node regardless of label length. Measured on
 * a real diagram: nodes inside one rank sat 74 px apart (x = -10, 64, 138,
 * 232) while their final Excalidraw boxes were 720–1040 px wide — 22
 * overlapping box pairs at 100 % overlap. The same constant appeared in a
 * minimal graph with 84–132 px boxes, and a terse-label variant of the same
 * diagram still overlapped in 18 pairs, so label length is not the cause.
 * Patching `getBoundingClientRect` changed nothing. Only pure chains came out
 * readable. Three measurements disagreed: mermaid's layout (effectively zero
 * real width), the SVG `getBBox` shim (12 px per glyph-unit) and Excalidraw's
 * own final measurement (~12.4 px per character). The ER path solved the same
 * root cause first (`src/scene/er.ts`); this module follows the same
 * architecture for flowcharts.
 *
 * MERMAID DB ACCESSORS (discovered at runtime against mermaid 11.15.0):
 * - `mermaid.mermaidAPI.getDiagramFromText(text)` returns a `Diagram` whose
 *   `type` is `"flowchart-v2"` for BOTH `flowchart ...` and `graph ...` input
 *   (mermaid routes the `graph` keyword to the same v2 parser).
 * - `db.getData()` is the primary accessor. It returns `{ nodes, edges }`:
 *   - `nodes[i] = { id, label, shape, isGroup, parentId, padding, domId, ... }`.
 *     Subgraphs appear as group pseudo-nodes (`isGroup: true`,
 *     `shape: "rect"`); real nodes carry `parentId` when they belong to a
 *     subgraph. Node ids are plain ("A", "B", ...) and `label` falls back to
 *     the node id when the input declares none, so a label is never empty.
 *   - `edges[j] = { id, start, end, label, type, pattern, thickness,
 *     arrowTypeStart, arrowTypeEnd }` where `start`/`end` reference the node
 *     `id`s directly (no name resolution needed) and `type` is the mermaid
 *     edge kind (`"arrow_point"`, `"arrow_open"`, `"arrow_circle"`,
 *     `"arrow_cross"`, `"double_arrow_point"`, ...).
 * - `db.getSubGraphs()` returns `[{ id, title, nodes: [...] }]` where
 *   `nodes` lists the DIRECT members (a nested subgraph id appears as a member
 *   of its parent), joined with the group pseudo-nodes for nesting info.
 * - `db.getDirection()` returns the normalized direction: `"TB"` (input `TD`),
 *   `"LR"`, `"BT"` or `"RL"`.
 *
 * LAYOUT:
 * - RANKS: longest-path layering computed by this module, tolerant of cycles.
 *   Self-edges never participate in ranking. Back edges (detected with a
 *   colored DFS over the remaining graph) are excluded from the ranking
 *   constraints, which leaves a DAG; ranks are then the longest path from any
 *   source. A back edge still becomes a real arrow (top border → bottom border
 *   in TD), so cycles render without degenerate geometry.
 * - DIRECTION: `TB` ranks stack top-to-bottom and order horizontally; `LR`
 *   ranks stack left-to-right and order vertically. `BT` is laid out as `TB`
 *   and `RL` as `LR` (arrowheads keep the true edge direction); this is a
 *   recorded simplification — no other directions exist in mermaid's model.
 * - SIZES: every node box is sized from its own label with `nodeLabelWidth`
 *   (the dom-shim getBBox emulation: 12 px per glyph-unit + constant slack,
 *   the calibration knob tuned for node sizing in T4). That dominates the
 *   converter's own canvas measurement (~2.8 px per glyph-unit) and exceeds
 *   Excalidraw's real metric (~12.4 px per character) for every realistic
 *   label, so Excalidraw's own text metrics cannot overflow the box. Diamonds
 *   get double width/height (the label must fit the rhombus' inscribed
 *   rectangle) and circles get the diagonal diameter, with padding.
 * - ORDER: one barycentre pass per rank over the previous rank's positions
 *   (nodes without predecessors keep their discovery position), then each rank
 *   is centred on the widest rank. Ranks are separated by fixed gaps, so box
 *   overlap is impossible by construction: boxes in a rank are placed
 *   side-by-side with a positive gap, ranks a positive gap apart.
 * - COORDINATES: the whole scene is offset to `FLOW_ORIGIN`, so no coordinate
 *   is negative.
 * - ARROWS: one arrow per edge between the two box borders, side chosen from
 *   the direction (bottom/top borders in TD, right/left in LR). Every arrow
 *   carries a deliberate ±FLOW_ARROW_SPREAD on the perpendicular axis so its
 *   width AND height are both non-zero, even between centres that align.
 *   Same-rank edges connect the facing side borders; upward (back) edges leave
 *   the top border. Self-edges bulge out of the right border with explicit
 *   path points and never degenerate. Edge labels are FREE text at the arrow
 *   midpoint — never bound to the arrow, because a vertical arrow's bounding
 *   box is near-zero wide and bound labels get clipped (spike note, residual
 *   risk 4).
 * - SUBGRAPHS: each subgraph is drawn as one container rectangle enclosing the
 *   bounding box of its member boxes (nested subgraphs included), parents
 *   first, with its title as FREE text in the top-left corner — a container
 *   has exactly one bound label slot and node boxes own theirs. Subgraph
 *   rectangles may contain their member boxes by definition and are therefore
 *   excluded from the node-overlap criterion; the geometric tests count them
 *   separately.
 *
 * The skeletons are the same flat shapes the dependency's flowchart converter
 * produces (`transformToExcalidrawContainerSkeleton` /
 * `transformToExcalidrawTextSkeleton` / `transformToExcalidrawArrowSkeleton`,
 * reusing the helpers exported by `src/scene/er.ts`), converted with the
 * bundled converter so element defaults and id regeneration stay consistent
 * with the ER path.
 *
 * INITIALIZATION NOTE: see the er.ts header — mermaid is initialized with a
 * copy of the dependency's own `MERMAID_CONFIG` so the config-hash cache
 * cannot poison a later parse.
 */

import { MERMAID_CONFIG } from "@excalidraw/mermaid-to-excalidraw/dist/constants.js";

import { canvasTextWidth, nodeLabelWidth } from "./dom-shim.ts";
import { arrowSkeleton, textSkeleton } from "./er.ts";
import { MermaidLimitError, MermaidParseError } from "./errors.ts";
import type { ExcalidrawElement, MermaidSceneResult } from "./mermaid.ts";

/** Font size used for every flowchart label (the shim's default). */
export const FLOW_FONT_SIZE = 20;

/** Horizontal padding between a box edge and its label zone. */
export const FLOW_PAD_X = 24;
/** Vertical padding between a box edge and its label zone. */
export const FLOW_PAD_Y = 16;
/** Narrowest node box. */
export const FLOW_MIN_BOX_WIDTH = 120;
/** Scene origin: everything is placed at strictly positive coordinates. */
export const FLOW_ORIGIN = 80;
/** Vertical gap between ranks in TD (also fits edge labels). */
export const FLOW_RANK_GAP = 150;
/** Horizontal gap between boxes within a rank (TD) / columns (LR). */
export const FLOW_NODE_GAP = 90;
/** Half of the deliberate ±12px spread that keeps arrows non-degenerate. */
export const FLOW_ARROW_SPREAD = 12;
/** How far a self-edge bulges out of its box. */
export const FLOW_SELF_LOOP_BULGE = 40;
/** Text height the converter measures for a single-line text element. */
export const FLOW_TEXT_HEIGHT = FLOW_FONT_SIZE * 1.25;

/** Mermaid input directions this module understands. */
export const SUPPORTED_DIRECTIONS = ["TB", "LR", "BT", "RL"] as const;

export interface FlowNode {
  id: string;
  label: string;
  shape: string;
}

export interface FlowEdge {
  id: string;
  startId: string;
  endId: string;
  label: string;
  /** Mermaid edge kind, e.g. "arrow_point", "arrow_open", "double_arrow_point". */
  type: string;
  /** "normal" | "dotted" | "dashed" */
  pattern: string;
}

export interface FlowSubgraph {
  id: string;
  title: string;
  nodeIds: string[];
}

export interface FlowModel {
  nodes: FlowNode[];
  edges: FlowEdge[];
  subgraphs: FlowSubgraph[];
  /** Normalized direction: "TB" | "LR" | "BT" | "RL". */
  direction: string;
}

/** Injected converter so this module stays free of the pipeline's imports. */
export interface FlowSceneDependencies {
  convert: (skeletons: unknown[]) => Promise<ExcalidrawElement[]>;
  maxEdges: number;
}

interface FlowRawNode {
  id?: unknown;
  label?: unknown;
  shape?: unknown;
  isGroup?: unknown;
}

interface FlowRawEdge {
  id?: unknown;
  start?: unknown;
  end?: unknown;
  label?: unknown;
  type?: unknown;
  pattern?: unknown;
}

interface FlowRawData {
  nodes?: unknown;
  edges?: unknown;
}

interface FlowRawSubgraph {
  id?: unknown;
  title?: unknown;
  nodes?: unknown;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/**
 * Reads the flowchart model out of mermaid's diagram db. Exported for tests;
 * the accessor discovery is documented in the module header.
 */
export function extractFlowModel(db: unknown): FlowModel {
  const getData = (db as { getData?: () => unknown } | null | undefined)?.getData;
  const getSubGraphs = (db as { getSubGraphs?: () => unknown } | null | undefined)?.getSubGraphs;
  const getDirection = (db as { getDirection?: () => unknown } | null | undefined)?.getDirection;
  if (typeof getData !== "function") {
    throw new MermaidParseError("mermaid's flowchart database exposes no getData() accessor");
  }
  let data: FlowRawData;
  try {
    data = (getData.call(db) ?? {}) as FlowRawData;
  } catch (error: unknown) {
    throw new MermaidParseError("reading the flowchart model from mermaid's database failed", { cause: error });
  }
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new MermaidParseError("mermaid's flowchart database returned no nodes or edges");
  }

  const nodes: FlowNode[] = data.nodes
    .map((raw: unknown): FlowRawNode => (raw ?? {}) as FlowRawNode)
    .filter((node) => node.isGroup !== true) // subgraph containers are handled via getSubGraphs()
    .map((node) => ({
      id: asString(node.id),
      label: asString(node.label),
      shape: asString(node.shape),
    }));
  if (nodes.length === 0) {
    throw new MermaidParseError("mermaid's flowchart database contains no nodes");
  }

  const edges: FlowEdge[] = data.edges.map((raw: unknown): FlowEdge => {
    const edge = (raw ?? {}) as FlowRawEdge;
    return {
      id: asString(edge.id),
      startId: asString(edge.start),
      endId: asString(edge.end),
      label: asString(edge.label),
      type: asString(edge.type) || "arrow_point",
      pattern: asString(edge.pattern) || "normal",
    };
  });

  let subgraphs: FlowSubgraph[] = [];
  if (typeof getSubGraphs === "function") {
    try {
      const raw = getSubGraphs.call(db);
      if (Array.isArray(raw)) {
        subgraphs = raw.map((entry: unknown): FlowSubgraph => {
          const subgraph = (entry ?? {}) as FlowRawSubgraph;
          return {
            id: asString(subgraph.id),
            title: asString(subgraph.title),
            nodeIds: asStringArray(subgraph.nodes),
          };
        });
      }
    } catch {
      // A missing or failing subgraph accessor degrades to no containers;
      // every node still renders with correct geometry.
      subgraphs = [];
    }
  }

  let direction = "TB";
  if (typeof getDirection === "function") {
    try {
      const value = asString(getDirection.call(db));
      if (SUPPORTED_DIRECTIONS.includes(value as (typeof SUPPORTED_DIRECTIONS)[number])) {
        direction = value;
      }
    } catch {
      // Keep the TB default.
    }
  }

  return { nodes, edges, subgraphs, direction };
}

/**
 * Mermaid edge kind → Excalidraw arrowhead mapping, matching the dependency's
 * own `MERMAID_EDGE_TYPE_MAPPER` (dist/converter/helpers.js). Unknown kinds
 * get a plain arrow end.
 */
const edgeArrowheads = (edgeType: string): { start: string | null; end: string | null } => {
  switch (edgeType) {
    case "arrow_open":
      return { start: null, end: null };
    case "double_arrow_point":
      return { start: "arrow", end: "arrow" };
    case "double_arrow_circle":
      return { start: "circle", end: "circle" };
    case "double_arrow_cross":
      return { start: "bar", end: "bar" };
    case "arrow_circle":
      return { start: null, end: "circle" };
    case "arrow_cross":
      return { start: null, end: "bar" };
    default:
      return { start: null, end: "arrow" };
  }
};

interface NodeBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
}

interface Point {
  x: number;
  y: number;
}

/** Box geometry for one node, sized from its own label. */
const boxFor = (node: FlowNode): { width: number; height: number } => {
  const labelWidth = nodeLabelWidth(node.label, FLOW_FONT_SIZE);
  const labelHeight = FLOW_TEXT_HEIGHT;
  if (node.shape === "diamond") {
    // The label must fit the rhombus' inscribed rectangle.
    return { width: 2 * (labelWidth + FLOW_PAD_X), height: 2 * (labelHeight + FLOW_PAD_Y) };
  }
  if (node.shape === "circle" || node.shape === "doublecircle") {
    // The label must fit the circle: take the label's diagonal, plus padding.
    const diameter =
      Math.sqrt(labelWidth * labelWidth + labelHeight * labelHeight) + 2 * FLOW_PAD_X;
    return { width: diameter, height: diameter };
  }
  return {
    width: Math.max(FLOW_MIN_BOX_WIDTH, labelWidth + 2 * FLOW_PAD_X),
    height: labelHeight + 2 * FLOW_PAD_Y,
  };
};

/** Skeleton container type (and roundness) for a mermaid node shape. */
const containerFor = (node: FlowNode): { type: string; roundness?: { type: number } } => {
  switch (node.shape) {
    case "diamond":
      return { type: "diamond" };
    case "circle":
    case "doublecircle":
      return { type: "ellipse" };
    case "round":
    case "stadium":
      return { type: "rectangle", roundness: { type: 3 } };
    default:
      // squareRect and every shape the dependency itself degrades to a
      // rectangle (subroutine, cylinder, hexagon, ...) render as rectangles.
      return { type: "rectangle" };
  }
};

/** Ranks the nodes with a longest-path layering that tolerates cycles. */
export const rankNodes = (
  nodeIds: string[],
  edges: FlowEdge[],
): Map<string, number> => {
  const ids = new Set(nodeIds);
  const adjacency = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  // Self-edges never participate in ranking.
  const candidates = edges.filter(
    (edge) => edge.startId !== edge.endId && ids.has(edge.startId) && ids.has(edge.endId),
  );
  for (const edge of candidates) {
    adjacency.get(edge.startId)!.push(edge.endId);
  }

  // Colored DFS to find back edges; excluding them leaves a DAG.
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(nodeIds.map((id) => [id, WHITE]));
  const backEdges = new Set<string>(); // "start\u0000end"
  const visit = (root: string): void => {
    const stack: Array<{ id: string; index: number }> = [{ id: root, index: 0 }];
    color.set(root, GREY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const targets = adjacency.get(frame.id)!;
      if (frame.index < targets.length) {
        const target = targets[frame.index]!;
        frame.index += 1;
        const targetColor = color.get(target) ?? WHITE;
        if (targetColor === GREY) {
          backEdges.add(`${frame.id}\u0000${target}`);
        } else if (targetColor === WHITE) {
          color.set(target, GREY);
          stack.push({ id: target, index: 0 });
        }
      } else {
        color.set(frame.id, BLACK);
        stack.pop();
      }
    }
  };
  for (const id of nodeIds) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      visit(id);
    }
  }

  // Longest-path layering over the DAG in topological order (iterative DFS
  // finish order of the back-edge-free graph).
  const forward = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of candidates) {
    if (!backEdges.has(`${edge.startId}\u0000${edge.endId}`)) {
      forward.get(edge.startId)!.push(edge.endId);
    }
  }
  const finish: string[] = [];
  const state = new Map<string, number>(nodeIds.map((id) => [id, WHITE]));
  for (const root of nodeIds) {
    if ((state.get(root) ?? WHITE) !== WHITE) continue;
    state.set(root, GREY);
    const stack: Array<{ id: string; index: number }> = [{ id: root, index: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const targets = forward.get(frame.id)!;
      if (frame.index < targets.length) {
        const target = targets[frame.index]!;
        frame.index += 1;
        if ((state.get(target) ?? WHITE) === WHITE) {
          state.set(target, GREY);
          stack.push({ id: target, index: 0 });
        }
      } else {
        state.set(frame.id, BLACK);
        finish.push(frame.id);
        stack.pop();
      }
    }
  }

  const rank = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (const id of [...finish].reverse()) {
    for (const target of forward.get(id)!) {
      const candidate = rank.get(id)! + 1;
      if (candidate > rank.get(target)!) {
        rank.set(target, candidate);
      }
    }
  }
  return rank;
};

interface FlowLayout {
  boxes: Map<string, NodeBox>;
  /** Grid extent, used to centre ranks and offset the scene. */
  width: number;
  height: number;
}

/**
 * Places the boxes: rank-major, barycentre-ordered within each rank, every
 * rank centred, all coordinates shifted to `FLOW_ORIGIN`.
 */
export const layoutNodes = (
  nodes: FlowNode[],
  edges: FlowEdge[],
  direction: string,
): FlowLayout => {
  const vertical = direction !== "LR"; // TB and BT stack ranks vertically
  const rank = rankNodes(
    nodes.map((node) => node.id),
    edges,
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const maxRank = Math.max(0, ...[...rank.values()]);
  const ranks: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  // Discovery order (input order) is the initial within-rank order.
  for (const node of nodes) {
    ranks[rank.get(node.id)!]!.push(node.id);
  }

  // One barycentre pass over the previous rank. Nodes without predecessors in
  // the previous rank keep their current position (stable sort on a fallback
  // of their own index).
  const position = new Map<string, number>();
  ranks.forEach((members) => members.forEach((id, index) => position.set(id, index)));
  for (let r = 1; r < ranks.length; r++) {
    const members = ranks[r]!;
    const barycentre = new Map<string, number>();
    for (const id of members) {
      const previous = edges
        .filter(
          (edge) =>
            edge.startId !== edge.endId &&
            edge.endId === id &&
            rank.get(edge.startId) === r - 1,
        )
        .map((edge) => position.get(edge.startId)!)
        .filter((value) => value !== undefined);
      barycentre.set(
        id,
        previous.length > 0
          ? previous.reduce((sum, value) => sum + value, 0) / previous.length
          : position.get(id)!,
      );
    }
    members.sort((a, b) => barycentre.get(a)! - barycentre.get(b)!);
    members.forEach((id, index) => position.set(id, index));
  }

  const boxesFor = (rankMembers: string[]): NodeBox[] =>
    rankMembers
      .map((id) => byId.get(id)!)
      .filter((node) => node !== undefined)
      .map((node) => {
        const size = boxFor(node);
        return {
          id: node.id,
          x: 0,
          y: 0,
          width: size.width,
          height: size.height,
          cx: 0,
          cy: 0,
        };
      });

  const boxes = new Map<string, NodeBox>();
  if (vertical) {
    // Rows of boxes: rank r at height y[r], boxes side-by-side, each row
    // centred on the widest row.
    const rows = ranks.map(boxesFor);
    const rowWidths = rows.map((row) =>
      row.reduce((sum, box) => sum + box.width, 0) + Math.max(0, row.length - 1) * FLOW_NODE_GAP,
    );
    const rowHeights = rows.map((row) => Math.max(0, ...row.map((box) => box.height)));
    const sceneWidth = Math.max(0, ...rowWidths);
    const ys: number[] = [];
    for (let r = 0; r < rows.length; r++) {
      ys.push(r === 0 ? 0 : ys[r - 1]! + rowHeights[r - 1]! + FLOW_RANK_GAP);
    }
    const sceneHeight = rows.length > 0 ? ys[rows.length - 1]! + rowHeights[rows.length - 1]! : 0;
    rows.forEach((row, r) => {
      let x = FLOW_ORIGIN + (sceneWidth - rowWidths[r]!) / 2;
      const y = FLOW_ORIGIN + ys[r]!;
      for (const box of row) {
        box.x = x;
        box.y = y;
        box.cx = x + box.width / 2;
        box.cy = y + box.height / 2;
        boxes.set(box.id, box);
        x += box.width + FLOW_NODE_GAP;
      }
    });
    return { boxes, width: sceneWidth + 2 * FLOW_ORIGIN, height: sceneHeight + 2 * FLOW_ORIGIN };
  }

  // LR: columns of boxes, rank r at x[r], each column centred on the tallest.
  const columns = ranks.map(boxesFor);
  const colHeights = columns.map((column) =>
    column.reduce((sum, box) => sum + box.height, 0) + Math.max(0, column.length - 1) * FLOW_NODE_GAP,
  );
  const colWidths = columns.map((column) => Math.max(0, ...column.map((box) => box.width)));
  const sceneHeight = Math.max(0, ...colHeights);
  const xs: number[] = [];
  for (let c = 0; c < columns.length; c++) {
    xs.push(c === 0 ? 0 : xs[c - 1]! + colWidths[c - 1]! + FLOW_RANK_GAP);
  }
  const sceneWidth = columns.length > 0 ? xs[columns.length - 1]! + colWidths[columns.length - 1]! : 0;
  columns.forEach((column, c) => {
    let y = FLOW_ORIGIN + (sceneHeight - colHeights[c]!) / 2;
    const x = FLOW_ORIGIN + xs[c]!;
    for (const box of column) {
      box.x = x;
      box.y = y;
      box.cx = x + box.width / 2;
      box.cy = y + box.height / 2;
      boxes.set(box.id, box);
      y += box.height + FLOW_NODE_GAP;
    }
  });
  return { boxes, width: sceneWidth + 2 * FLOW_ORIGIN, height: sceneHeight + 2 * FLOW_ORIGIN };
};

/**
 * Width the converter's canvas metric reports for a free edge-label text; the
 * same shim measurement the ER module uses for its free texts.
 */
const labelWidth = (text: string): number => canvasTextWidth(text, FLOW_FONT_SIZE);

/**
 * Builds the flat Excalidraw skeletons for a flowchart model with this
 * project's own layered layout. Pure: no mermaid, no DOM, no converter.
 */
export function buildFlowSkeletons(model: FlowModel): unknown[] {
  const vertical = model.direction !== "LR";
  const layout = layoutNodes(model.nodes, model.edges, model.direction);
  const boxes = layout.boxes;

  const skeletons: unknown[] = [];

  // Node containers with their bound label. Drawn first so arrows and
  // subgraph containers layer above/below predictably.
  for (const node of model.nodes) {
    const box = boxes.get(node.id)!;
    const container = containerFor(node);
    skeletons.push({
      type: container.type,
      id: node.id,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      strokeWidth: 2,
      ...(container.roundness ? { roundness: container.roundness } : {}),
      label: {
        text: node.label,
        fontSize: FLOW_FONT_SIZE,
      },
    });
  }

  // Subgraph containers: enclosing rectangle per subgraph, parents first
  // (largest member set first so nested ones render on top), title as free
  // text in the top-left corner.
  const subRects = new Map<string, { x: number; y: number; width: number; height: number }>();
  const rectOf = (id: string): { x: number; y: number; width: number; height: number } | undefined => {
    if (subRects.has(id)) return subRects.get(id);
    const box = boxes.get(id);
    if (box) return { x: box.x, y: box.y, width: box.width, height: box.height };
    return undefined;
  };
  // Leaf-first: process subgraphs whose members are all resolved.
  const pending = [...model.subgraphs];
  let guard = 0;
  while (pending.length > 0 && guard++ <= pending.length + 1) {
    let progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const subgraph = pending[i]!;
      const memberRects = subgraph.nodeIds.map(rectOf);
      if (memberRects.some((rect) => rect === undefined)) continue;
      pending.splice(i, 1);
      progressed = true;
      const rects = memberRects.filter((rect) => rect !== undefined) as Array<{
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
      const x1 = Math.min(...rects.map((rect) => rect.x)) - FLOW_PAD_X;
      const y1 = Math.min(...rects.map((rect) => rect.y)) - FLOW_PAD_Y - FLOW_TEXT_HEIGHT;
      const x2 = Math.max(...rects.map((rect) => rect.x + rect.width)) + FLOW_PAD_X;
      const y2 = Math.max(...rects.map((rect) => rect.y + rect.height)) + FLOW_PAD_Y;
      subRects.set(subgraph.id, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
    }
    if (!progressed) break; // cyclic membership: draw what resolved
  }
  const drawn = [...subRects.entries()].sort((a, b) => b[1].width * b[1].height - a[1].width * a[1].height);
  for (const [id, rect] of drawn) {
    const subgraph = model.subgraphs.find((entry) => entry.id === id)!;
    skeletons.push({
      type: "rectangle",
      id: `subgraph-${id}`,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      strokeWidth: 1,
      strokeStyle: "dashed",
    });
    const title = subgraph.title !== "" ? subgraph.title : id;
    skeletons.push(
      textSkeleton(title, {
        x: rect.x + 10,
        y: rect.y + 8,
      }),
    );
  }

  // One arrow per edge, side chosen from the direction, with a deliberate
  // perpendicular spread so width AND height are both non-zero; the edge
  // label is free text at the arrow midpoint, never bound to the arrow.
  for (const edge of model.edges) {
    const startBox = boxes.get(edge.startId);
    const endBox = boxes.get(edge.endId);
    if (!startBox || !endBox) {
      continue; // a dangling endpoint cannot be drawn; mermaid would skip it too
    }
    const arrowheads = edgeArrowheads(edge.type);
    const spread = FLOW_ARROW_SPREAD;

    let from: Point;
    let points: number[][];
    let labelPosition: Point;

    if (startBox.id === endBox.id) {
      // Self-edge: bulge out of the right border with explicit points so the
      // arrow never collapses to a zero-size element.
      const x = startBox.x + startBox.width;
      const y = startBox.cy;
      from = { x, y: y - 2 * spread };
      points = [
        [0, 0],
        [FLOW_SELF_LOOP_BULGE, 0],
        [FLOW_SELF_LOOP_BULGE, 4 * spread],
        [0, 4 * spread],
      ];
      labelPosition = { x: x + FLOW_SELF_LOOP_BULGE + 6, y: y - 2 * spread };
    } else if (vertical) {
      const forward = endBox.y > startBox.y;
      const sameRank = Math.round(endBox.y) === Math.round(startBox.y);
      if (sameRank) {
        // Same rank: connect the facing side borders horizontally.
        const leftwards = endBox.x < startBox.x;
        const left = leftwards ? endBox : startBox;
        const right = leftwards ? startBox : endBox;
        from = leftwards
          ? { x: startBox.x, y: startBox.cy - spread }
          : { x: startBox.x + startBox.width, y: startBox.cy - spread };
        points = [
          [0, 0],
          [(leftwards ? left.x : right.x + right.width) - from.x, 2 * spread],
        ];
        labelPosition = {
          x: (from.x + from.x + points[1]![0]!) / 2 - labelWidth(edge.label),
          y: startBox.cy - spread - FLOW_TEXT_HEIGHT,
        };
      } else if (forward) {
        from = { x: startBox.cx - spread, y: startBox.y + startBox.height };
        points = [
          [0, 0],
          [endBox.cx + spread - from.x, endBox.y - from.y],
        ];
        labelPosition = {
          x: (from.x + endBox.cx + spread) / 2 - labelWidth(edge.label),
          y: (from.y + endBox.y) / 2 - FLOW_TEXT_HEIGHT / 2,
        };
      } else {
        // Back edge (cycle): leave the top border, arrive at the bottom border.
        from = { x: startBox.cx - spread, y: startBox.y };
        points = [
          [0, 0],
          [endBox.cx + spread - from.x, endBox.y + endBox.height - from.y],
        ];
        labelPosition = {
          x: (from.x + endBox.cx + spread) / 2 - labelWidth(edge.label),
          y: (from.y + endBox.y + endBox.height) / 2 - FLOW_TEXT_HEIGHT / 2,
        };
      }
    } else {
      // LR: horizontal arrows between side borders.
      const forward = endBox.x > startBox.x + startBox.width;
      const sameColumn = Math.round(endBox.x) === Math.round(startBox.x);
      if (sameColumn) {
        const upwards = endBox.y < startBox.y;
        from = upwards
          ? { x: startBox.cx - spread, y: startBox.y }
          : { x: startBox.cx - spread, y: startBox.y + startBox.height };
        points = [
          [0, 0],
          [2 * spread, (upwards ? endBox.y + endBox.height : endBox.y) - from.y],
        ];
        labelPosition = {
          x: startBox.cx - spread - labelWidth(edge.label),
          y: (from.y + (upwards ? endBox.y + endBox.height : endBox.y)) / 2 - FLOW_TEXT_HEIGHT / 2,
        };
      } else if (forward) {
        from = { x: startBox.x + startBox.width, y: startBox.cy - spread };
        points = [
          [0, 0],
          [endBox.x - from.x, endBox.cy + spread - from.y],
        ];
        labelPosition = {
          x: (from.x + endBox.x) / 2 - labelWidth(edge.label),
          y: (from.y + endBox.cy + spread) / 2 - FLOW_TEXT_HEIGHT / 2,
        };
      } else {
        // Back edge in LR: leave the left border, arrive at the right border.
        from = { x: startBox.x, y: startBox.cy - spread };
        points = [
          [0, 0],
          [endBox.x + endBox.width - from.x, endBox.cy + spread - from.y],
        ];
        labelPosition = {
          x: (from.x + endBox.x + endBox.width) / 2 - labelWidth(edge.label),
          y: (from.y + endBox.cy + spread) / 2 - FLOW_TEXT_HEIGHT / 2,
        };
      }
    }

    skeletons.push(
      arrowSkeleton({
        from,
        points,
        startId: edge.startId,
        endId: edge.endId,
        startArrowhead: arrowheads.start,
        endArrowhead: arrowheads.end,
      }),
    );
    if (edge.label !== "") {
      skeletons.push(textSkeleton(edge.label, labelPosition));
    }
  }

  return skeletons;
}

/**
 * Converts Mermaid flowchart text (`flowchart` / `graph`) into an Excalidraw
 * scene using this project's own layered layout. Must be called after the DOM
 * shim is installed (the pipeline routes before this); mermaid is initialized
 * here with the dependency's own config so `getDiagramFromText` works
 * standalone too.
 */
export async function flowchartToScene(
  mermaidText: string,
  deps: FlowSceneDependencies,
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
  // `graph` and `flowchart` input both detect as "flowchart-v2".
  if (diagram?.type !== "flowchart-v2") {
    throw new MermaidParseError(
      `expected a flowchart diagram, got ${String(diagram?.type ?? "unknown")}`,
    );
  }
  const model = extractFlowModel(diagram.db);
  if (model.edges.length > deps.maxEdges) {
    throw new MermaidLimitError(
      `Mermaid input exceeds maxEdges ${deps.maxEdges} (${model.edges.length} flowchart edges); the dependency would truncate it`,
    );
  }

  const skeletons = buildFlowSkeletons(model);
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
