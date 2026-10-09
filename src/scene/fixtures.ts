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
 * Flowchart fixtures, laid out by this project's own flowchart module
 * (`src/scene/flowchart.ts`), not by mermaid/dagre. `nodes` counts real
 * (non-subgraph) nodes, `edges` the connections, `subgraphs` the subgraph
 * containers; the geometry tests in `flowchart.test.ts` assert them against
 * the produced scene. These fixtures deliberately include a fan-out and a
 * fan-in with long labels — the shapes that exposed mermaid's constant ~74 px
 * per-node layout under jsdom (see `odd/notes/mermaid-node-spike.md`).
 */
export interface FlowFixture {
  name: string;
  mermaid: string;
  nodes: number;
  edges: number;
  subgraphs: number;
  direction: "TB" | "LR";
  /** Distinct rank levels the layout must produce (TD: y-levels, LR: x-columns). */
  ranks: number;
}

export const FANOUT_FIXTURE: FlowFixture = {
  name: "flowchart fan-out with long labels",
  nodes: 5,
  edges: 4,
  subgraphs: 0,
  direction: "TB",
  ranks: 2,
  mermaid: [
    "flowchart TD",
    "  A[Usuario autenticado] --> B[Servicio de validacion de credenciales]",
    "  A --> C[Registro de auditoria de seguridad]",
    "  A --> D[Notificacion por correo electronico]",
    "  A --> E[Sesion de usuario persistente]",
  ].join("\n"),
};

export const FANIN_FIXTURE: FlowFixture = {
  name: "flowchart fan-in with long labels",
  nodes: 5,
  edges: 4,
  subgraphs: 0,
  direction: "TB",
  ranks: 2,
  mermaid: [
    "flowchart TD",
    "  A[Servicio de pagos] --> Z[Conciliacion contable central]",
    "  B[Servicio de facturas emitidas] --> Z",
    "  C[Servicio de notas de credito] --> Z",
    "  D[Ajustes manuales de inventario] --> Z",
  ].join("\n"),
};

export const DECISION_FIXTURE: FlowFixture = {
  name: "flowchart decision with two labelled branches",
  nodes: 4,
  edges: 3,
  subgraphs: 0,
  direction: "TB",
  ranks: 3,
  mermaid: [
    "flowchart TD",
    "  A[Solicitud recibida] --> B{Datos completos?}",
    "  B -->|si| C[Procesar solicitud]",
    "  B -->|no| D[Devolver al remitente]",
  ].join("\n"),
};

export const MULTIRANK_FIXTURE: FlowFixture = {
  name: "flowchart with several ranks and a shortcut edge",
  nodes: 5,
  edges: 5,
  subgraphs: 0,
  direction: "TB",
  ranks: 4,
  mermaid: [
    "flowchart TD",
    "  A[Inicio] --> B[Paso uno]",
    "  B --> C[Paso dos]",
    "  C --> D[Paso tres]",
    "  B --> E[Atajo alternativo]",
    "  E --> D",
  ].join("\n"),
};

export const SELF_EDGE_FIXTURE: FlowFixture = {
  name: "flowchart with a self-edge",
  nodes: 2,
  edges: 2,
  subgraphs: 0,
  direction: "TB",
  ranks: 2,
  mermaid: [
    "flowchart TD",
    "  A[Proceso con reintento] --> A",
    "  A --> B[Siguiente etapa]",
  ].join("\n"),
};

export const CYCLE_FIXTURE: FlowFixture = {
  name: "flowchart with a cycle",
  nodes: 3,
  edges: 3,
  subgraphs: 0,
  direction: "TB",
  ranks: 3,
  mermaid: [
    "flowchart TD",
    "  A[Estados] --> B[Transicion]",
    "  B --> C[Verificacion]",
    "  C --> A",
  ].join("\n"),
};

export const LR_FIXTURE: FlowFixture = {
  name: "flowchart with LR direction",
  nodes: 4,
  edges: 3,
  subgraphs: 0,
  direction: "LR",
  ranks: 3,
  mermaid: [
    "flowchart LR",
    "  A[Cliente] --> B[Balanceador]",
    "  B --> C[Nodo uno]",
    "  B --> D[Nodo dos]",
  ].join("\n"),
};

export const NESTED_SUBGRAPH_LAYOUT_FIXTURE: FlowFixture = {
  name: "flowchart with nested subgraphs laid out natively",
  nodes: 4,
  edges: 4,
  subgraphs: 2,
  direction: "TB",
  ranks: 4,
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

export const FLOWCHART_FIXTURES: FlowFixture[] = [
  FANOUT_FIXTURE,
  FANIN_FIXTURE,
  DECISION_FIXTURE,
  MULTIRANK_FIXTURE,
  SELF_EDGE_FIXTURE,
  CYCLE_FIXTURE,
  LR_FIXTURE,
  NESTED_SUBGRAPH_LAYOUT_FIXTURE,
];

/**
 * Flowchart fixtures, exercised by the native-conversion tests in
 * `mermaid.test.ts` (`subgraph` blocks resolve thanks to the dom-shim
 * id-prefix selector fallback). Flowcharts are laid out by this project's
 * own flowchart module (`src/scene/flowchart.ts`); see `FLOWCHART_FIXTURES`
 * for the geometric fixtures.
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
