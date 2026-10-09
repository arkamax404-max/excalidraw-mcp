---
name: excalidraw-diagrams
description: Guides an agent using the excalidraw-mcp tools to create, list, read and delete Excalidraw diagrams on a self-hosted server. Use when creating diagrams, generating a diagram, drawing a flowchart or architecture diagram, converting Mermaid to Excalidraw, or when an Excalidraw MCP tool call fails.
---

# excalidraw-mcp: working with diagrams

Four tools: `create_diagram`, `list_diagrams`, `get_diagram`, `delete_diagram`.
All diagrams belong to one preconfigured user; names are canonicalized by the
server before use.

## Mode selection

| Situation | Call |
| --- | --- |
| Structure is known; you have Mermaid text | `create_diagram` `mode:"agent"`, `mermaid:"…"` |
| You have a raw Excalidraw scene object (e.g. from `get_diagram format:"scene"`) | `create_diagram` `mode:"agent"`, `scene:{…}` (non-empty `elements` array required) |
| Structure must be invented from a loose description | `create_diagram` `mode:"fork-ai"`, `prompt:"…"` |

`mode:"agent"` accepts **exactly one** of `mermaid` / `scene` — both or
neither is an input error. `fork-ai` takes only `prompt` and is
non-deterministic and rate-limited; prefer `agent` whenever you can write the
Mermaid yourself.

## Naming and overwrite

- Names are canonicalized before use: NFKC → disallowed characters and
  whitespace runs become `-` → `-` runs collapse → edge `[-_. ]` stripped →
  lowercase → `diagrama-1` if empty → truncated to 80 characters.
  `"Mi Diagrama!!"` becomes `mi-diagrama`.
- The **canonical name echoed by the server** is the real name; use it in
  later `get_diagram` / `delete_diagram` calls.
- Existing diagrams are protected: without `overwrite: true` a conflicting
  create fails and names the existing diagram. List first, then decide:
  replace with `overwrite: true` only when that is clearly the intent.

## Mermaid authoring rules (from measured limits)

- Supported diagram types (tested end-to-end): **flowcharts** — including
  `subgraph … end` grouping, nested subgraphs included — and **ER diagrams**
  (`erDiagram`, with attributes, keys, comments, relationships, cardinalities
  and self-relationships). `subgraph` grouping is preserved in the result; you
  can rely on it. ER diagrams use the project's own grid layout, so they come
  out readable: boxes never overlap, attribute texts sit inside their entity
  box, and every relationship arrow is visible.
- ER readability guidance (what the layout rewards):
  - any number of entities works — they are placed on a roughly square grid;
    about `sqrt(n)` columns, so a dozen entities still lays out cleanly;
  - attribute rows are written as `type name KEYS "comment"` inside the box;
    dozens of attributes per entity are fine (tested with 12; the box grows to
    fit them), but very long rows widen the box and the grid with it — keep
    types, names, keys and comments concise;
  - long entity names are supported (tested with a 46-character name); the box
    widens to fit the header, so prefer shorter names when you can;
  - relationship labels (`: places`) plus cardinalities are written at the
    arrow; column gaps grow to fit the widest label, but a short label still
    reads better than a sentence;
  - self-relationships (`ITEM ||--o| ITEM`) render as a small loop out of the
    box's right edge with the label beside it — no special authoring needed.
- Keep flowchart labels short; long labels on short arrows overflow.
- Prefer **rectangles** (`A[Label]`) over diamonds for labelled nodes:
  diamonds are a known-weak shape (the rectangle/ellipse fixtures measure
  0 wrapped / 0 overflowing labels; diamonds are recorded, not guaranteed).
- Stay within **250 edges** and **20000 characters**; larger input is rejected
  up front (`MermaidLimitError`), never silently truncated.
- Edge labels on **vertical** arrows overflow (their arrow bounding box is
  ~0 px wide) — put labelled arrows horizontally (`flowchart LR`) or drop the
  label.
- A parse failure can never produce a broken scene: it surfaces as a typed
  error instead of a placeholder image. Retry with simpler Mermaid.

## Read before you fetch

`get_diagram` defaults to a bounded **summary**: element count, counts per
type, at most 20 label texts of at most 80 characters each, and the unbounded
total. A full scene can be tens of thousands of tokens. Read the summary
first; request `format:"scene"` only when you actually need the raw elements
(e.g. to hand-build a modified scene for `mode:"agent"`).

## Failure recovery

| Tool result says | Next action |
| --- | --- |
| `Invalid input: …` | Fix the named field (exactly one of mermaid/scene; non-empty name; non-empty prompt; scene with non-empty `elements`) and call again |
| `Diagram "x" already exists` | `list_diagrams`, then either use `overwrite: true` or pick another name |
| `Diagram not found` | `list_diagrams` to see the real (canonical) names |
| `Authentication failed` | The configured user/password is wrong; a human must fix `EXCALIDRAW_USERNAME` / `EXCALIDRAW_PASSWORD` — do not retry |
| `rate limit … retry in N seconds` | Wait N seconds, then call `fork-ai` again; switch to `mode:"agent"` if you can |
| `Mermaid could not be converted` | Simplify the Mermaid (fewer nodes/edges, shorter labels) and retry |
| `Diagram too large: … maxEdges / maxTextSize` | Split the diagram or trim labels; there is no override |
| `The Excalidraw server could not be reached / did not answer` | The deployment is down or `EXCALIDRAW_BASE_URL` is wrong; retry later — this is transient, not an input problem |
