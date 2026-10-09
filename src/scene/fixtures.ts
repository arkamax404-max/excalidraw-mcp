/**
 * Mermaid fixtures used by the label-layout calibration harness.
 *
 * The `acceptance` field drives the harness assertions:
 * - "zero-wrapped": every text bound to a rectangle or ellipse container must
 *   be neither wrapped (no newline) nor overflowing (wider than its
 *   container). This is the T4 acceptance target.
 * - "recorded": the dependency itself limits these shapes (diamonds; see
 *   `odd/notes/mermaid-node-spike.md`), so the numbers are reported and
 *   recorded instead of asserted.
 */

export type FixtureAcceptance = "zero-wrapped" | "recorded";

export interface MermaidFixture {
  name: string;
  mermaid: string;
  acceptance: FixtureAcceptance;
  note?: string;
}

export const FIXTURES: MermaidFixture[] = [
  {
    name: "chain of plain rectangles",
    acceptance: "zero-wrapped",
    mermaid: [
      "flowchart TD",
      "  A[Inicio] --> B[Proceso]",
      "  B --> C[Fin]",
    ].join("\n"),
  },
  {
    name: "rectangle with two-word label",
    acceptance: "zero-wrapped",
    mermaid: [
      "flowchart TD",
      '  A["Usuario registrado"] --> B["Panel principal"]',
    ].join("\n"),
  },
  {
    name: "ellipse (circle) nodes",
    acceptance: "zero-wrapped",
    mermaid: [
      "flowchart LR",
      "  A((Inicio del flujo)) --> B((Fin))",
    ].join("\n"),
  },
  {
    name: "decision diamond",
    acceptance: "recorded",
    note: "Diamonds are limited by the dependency itself (spike note, residual risk 4); numbers are reported, not asserted.",
    mermaid: [
      "flowchart TD",
      "  A{Es valido?} -->|si| B[Siguiente paso]",
      "  A -->|no| C[Reintentar]",
    ].join("\n"),
  },
  {
    name: "edge label on a horizontal arrow",
    acceptance: "zero-wrapped",
    note: "Node containers are rectangles. The edge label is bound to the arrow, which the spike calls out as a vertical-arrow limitation only; horizontal arrows must hold.",
    mermaid: [
      "flowchart LR",
      "  A[Cliente] -->|envia solicitud| B[Servidor]",
    ].join("\n"),
  },
];
