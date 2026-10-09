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

/**
 * ER fixtures. `entities`, `relationships` and `attributes` are the expected
 * model counts; the geometry tests in `er.test.ts` assert them against the
 * produced scene (one rectangle per entity, one arrow per relationship, one
 * free attribute text per attribute row). ER diagrams are laid out by this
 * project's own ER module (`src/scene/er.ts`), not by the dependency.
 */
export interface ErFixture {
  name: string;
  mermaid: string;
  entities: number;
  relationships: number;
  attributes: number;
}

export const ER_FIXTURE: ErFixture = {
  name: "ER diagram with attributes, keys, a relationship and a self-relationship",
  entities: 3,
  relationships: 3,
  attributes: 6,
  mermaid: [
    "erDiagram",
    "  CUSTOMER {",
    "    string id PK",
    "    string name",
    "  }",
    "  ORDER {",
    "    string id PK",
    "    string customerId FK",
    "  }",
    "  ITEM {",
    "    string id PK",
    "    string orderId FK",
    "  }",
    "  CUSTOMER ||--o{ ORDER : places",
    "  ORDER ||--|{ ITEM : contains",
    "  ITEM ||--o| ITEM : related_to",
].join("\n"),
};

export const ER_SINGLE_ENTITY_FIXTURE: ErFixture = {
    name: "ER diagram with a single entity and no relationships",
    entities: 1,
    relationships: 0,
    attributes: 3,
    mermaid: [
        "erDiagram",
        "  PRODUCT {",
        "    string id PK",
        "    string name",
        "    int price",
        "  }",
    ].join("\n"),
};

export const ER_TWO_RELATIONSHIPS_FIXTURE: ErFixture = {
    name: "ER diagram with several entities and two relationships",
    entities: 3,
    relationships: 2,
    attributes: 7,
    mermaid: [
        "erDiagram",
        "  USER {",
        "    string id PK",
        "    string email",
        "  }",
        "  PROFILE {",
        "    string id PK",
        "    string userId FK",
        "  }",
        "  SETTING {",
        "    string id PK",
        "    string userId FK",
        "    string value",
        "  }",
        "  USER ||--o| PROFILE : has",
        "  USER ||--o{ SETTING : configures",
    ].join("\n"),
};

export const ER_SELF_RELATIONSHIP_FIXTURE: ErFixture = {
    name: "ER diagram with a single entity and a self-relationship",
    entities: 1,
    relationships: 1,
    attributes: 2,
    mermaid: [
        "erDiagram",
        "  EMPLOYEE {",
        "    string id PK",
        "    string managerId FK",
        "  }",
        "  EMPLOYEE ||--o{ EMPLOYEE : reports_to",
    ].join("\n"),
};

export const ER_MANY_ATTRIBUTES_FIXTURE: ErFixture = {
    name: "ER diagram with an entity holding many attributes",
    entities: 1,
    relationships: 0,
    attributes: 12,
    mermaid: [
        "erDiagram",
        "  INVOICE {",
        "    string id PK",
        "    string customerId FK",
        "    string number",
        "    date issuedAt",
        "    date dueAt",
        "    decimal total",
        "    decimal tax",
        "    string currency",
        "    string status",
        "    string notes",
        "    bool paid",
        "    datetime paidAt",
        "  }",
    ].join("\n"),
};

export const ER_LONG_NAME_FIXTURE: ErFixture = {
    name: "ER diagram with a long entity name",
    entities: 2,
    relationships: 1,
    attributes: 3,
    mermaid: [
        "erDiagram",
        "  CUSTOMER_SUBSCRIPTION_BILLING_CYCLE_AUDIT_TRAIL_ENTRY {",
        "    string id PK",
        "    string changedBy",
        "  }",
        "  AUDIT_ACTOR {",
        "    string id PK",
        "  }",
        "  CUSTOMER_SUBSCRIPTION_BILLING_CYCLE_AUDIT_TRAIL_ENTRY }o--|| AUDIT_ACTOR : recorded_by",
    ].join("\n"),
};

/**
 * Flowchart fixtures, exercised by the native-conversion tests in
 * `mermaid.test.ts` (`subgraph` blocks resolve thanks to the dom-shim
 * id-prefix selector fallback).
 */
export interface DiagramFixture {
  name: string;
  mermaid: string;
}

export const SUBGRAPH_FIXTURE: DiagramFixture = {
  name: "flowchart with one subgraph",
  mermaid: [
    "flowchart TD",
    "  A[Inicio] --> B[Proceso]",
    "  subgraph zona",
    "    B --> C[Fin]",
    "    C --> D[Archivo]",
    "  end",
    "  D --> A",
  ].join("\n"),
};

export const NESTED_SUBGRAPH_FIXTURE: DiagramFixture = {
  name: "flowchart with nested subgraphs",
  mermaid: [
    "flowchart TD",
    "  A[Inicio] --> B[Proceso]",
    "  subgraph externo",
    "    B --> C[Fin]",
    "    subgraph interno",
    "      C --> D[Archivo]",
    "    end",
    "  end",
    "  D --> A",
  ].join("\n"),
};

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
