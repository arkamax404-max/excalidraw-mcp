# excalidraw-mcp

An MCP **stdio server** that lets any agent create, list, read and delete
Excalidraw diagrams on a self-hosted Excalidraw deployment, acting as one
configured user. Diagram scenes are produced either locally from Mermaid text
(no browser: a jsdom-based DOM shim plus a bundled Excalidraw converter) or via
the fork's own AI endpoint.

> [!IMPORTANT]
> This server works **only** with our self-hosted Excalidraw fork,
> <https://github.com/arkamax404-max/excalidraw>. It depends on HTTP endpoints
> that the fork adds — session login, per-user diagram storage and the
> prompt-to-Mermaid AI endpoint — so it does **not** work against upstream
> Excalidraw or excalidraw.com, which expose no such server API.

The server talks to that fork's HTTP API over a session login, so the
deployment must expose the authenticated endpoints (`/api/auth/login`,
`/api/files`, `/api/ai/diagram`).

## Requirements

- Node.js >= 20 (engine requirement; developed and tested on Node 24.15)
- A Chromium for the PNG renderer (`render_diagram`). The browser is only needed
  when that tool is called; everything else runs without it. Playwright's own
  browser is used, and `EXCALIDRAW_MCP_CHROMIUM` can point at an existing
  executable when the installed build does not match the Playwright version
  (`npx playwright install chromium` otherwise).
- A reachable Excalidraw server and an active user account on it — **not
  needed at startup**; the login happens lazily on the first tool call, so
  `tools/list` works with no Excalidraw server running
- `jsdom` and the bundled converter are **runtime** requirements of the
  shipped server (already declared in `package.json`; the converter bundle is
  produced by the build, see below)

## Install

```bash
npm install
```

Verified: exits 0 with no further changes on a prepared tree.

## Build

```bash
npm run build
```

Runs `clean` (removes `dist/`), then `build:converter` (esbuild bundles
`@excalidraw/excalidraw` into `dist/vendor/excalidraw-converter.mjs`), then
`tsc`. Verified: exit 0. The converter bundle under `dist/vendor/` is a runtime
requirement — do not ship without it.

## Configuration

The server reads its connection settings from the environment, optionally
filled from an environment file:

1. If `EXCALIDRAW_ENV_FILE` is set, that file is loaded; otherwise `.env` in
   the current working directory is used.
2. A missing file is **not an error** — plain environment variables are enough.
3. Real environment variables **win** over file values.

`.env` is git-ignored and owned by the human: the project never creates or
modifies it. **`env.example`** (at the repository root) is the template to
copy — there is no committed `.env.example`.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `EXCALIDRAW_BASE_URL` | no | `http://localhost:3030` | Base URL of the Excalidraw server; trailing slashes are trimmed |
| `EXCALIDRAW_USERNAME` | yes | — | User that owns every diagram this server creates; trimmed; empty counts as missing |
| `EXCALIDRAW_PASSWORD` | yes | — | Password of that user; not trimmed (whitespace can be meaningful); never logged |
| `EXCALIDRAW_TIMEOUT_MS` | no | `30000` | Per-request timeout in milliseconds; must be a positive integer |
| `EXCALIDRAW_ENV_FILE` | no | — | Explicit path to the environment file, overriding the default `.env` lookup |

## Running

```bash
npm run start
```

Verified: the server answers MCP over stdio and exits 0 when stdin closes.

**Important, measured:** `npm run start` prints npm's own banner lines
(`> excalidraw-mcp@0.1.0 start`, …) to **stdout**, which corrupts the JSON-RPC
stream. Use one of these instead:

```bash
node dist/server.js          # pure stdout (recommended for MCP hosts)
npm run start --silent       # verified: stdout is pure JSON-RPC
```

stdout is reserved for the JSON-RPC channel: the server installs a guard that
redirects any stray `console.log` / `console.info` / `console.debug` (its own
or from libraries) to stderr, so diagnostics stay visible without corrupting
the session.

### MCP host configuration example

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["D:/Desarrollo/excalidraw-mcp/dist/server.js"],
      "env": {
        "EXCALIDRAW_BASE_URL": "http://localhost:3030",
        "EXCALIDRAW_USERNAME": "diagram-bot",
        "EXCALIDRAW_PASSWORD": "…",
        "EXCALIDRAW_ENV_FILE": "D:/Desarrollo/excalidraw-mcp/.env"
      }
    }
  }
}
```

The `.env` file is resolved from the **working directory** the host launches
with; hosts that do not run in the repository directory should set
`EXCALIDRAW_ENV_FILE` to an absolute path, or provide the variables directly
in `env`.

## Tools

All four tools are registered on the MCP server; names and inputs below are
taken from `src/tools/register.ts`.

### `create_diagram`

Input:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string, required | Normalized before use (see below); server echoes the canonical name |
| `mode` | `"agent"` \| `"fork-ai"`, required | How the scene is produced |
| `prompt` | string, optional | Required for `fork-ai`; empty or whitespace-only is rejected |
| `mermaid` | string, optional | Required for `agent` (Mermaid text) |
| `scene` | object, optional | Alternative for `agent`: a raw Excalidraw scene object with a **non-empty** `elements` array |
| `overwrite` | boolean, optional | Default `false`; `true` replaces an existing diagram with the same name |

Returns: the canonical `name`, the `file` object echoed by the server, the
`mode` used, the `elementCount`, and for `fork-ai` also `provider` and `model`.

With `overwrite: false`, an existing diagram with that name is **not**
clobbered: the error names the existing diagram and suggests `overwrite: true`.

### `list_diagrams`

No input. Returns `diagrams`: the user's diagrams with `name`, `fileName` and
`updatedAt`.

### `get_diagram`

Input: `name` (required), `format` (optional: `"summary"` or `"scene"`,
default `"summary"`).

- `"summary"` (default): `elementCount`, a count per element type, and the
  label texts **bounded** to at most 20 labels of at most 80 characters each
  (plus the unbounded `labels.total`), because a raw scene can be tens of
  thousands of tokens.
- `"scene"`: the full scene, for when the agent genuinely needs it.

Returns `name`, `fileName`, `format` plus the summary or the scene.

### `delete_diagram`

Input: `name` (required). Deletes the diagram and returns the canonical
`name` and `fileName`; a missing diagram is a typed not-found error.

### `render_diagram`

Renders a diagram to a PNG and returns **the image itself**, so an agent can
judge legibility instead of inferring it from element counts.

Input: exactly one source, plus two optional controls.

| Field | Notes |
| --- | --- |
| `name` | Render an existing diagram by name, without changing it |
| `mermaid` | Convert Mermaid text through this project's own pipeline and render it, **saving nothing** — the loop for checking a draft before `create_diagram` |
| `scene` | Render a raw Excalidraw scene object |
| `scale` | Raster scale between 0.2 and 4 (default 1). Applied as an explicit canvas resample, because Excalidraw's own `exportScale` is ignored by the version in use |
| `maxWidth` | Shrink the export so its longest side is at most this many pixels, keeping the aspect ratio |

Returns the PNG as an image content block plus a text summary: source, pixel
size, element count, elapsed time, the scale applied, whether `maxWidth`
reduced it, and the absolute path of the PNG written under the system temp
directory (`excalidraw-mcp-render/`).

Rendering is read-only: it never writes to Excalidraw and never writes inside
the repository.

## Generation modes

| | `mode: "agent"` | `mode: "fork-ai"` |
| --- | --- | --- |
| Input | `mermaid` **or** `scene` (exactly one) | `prompt` only |
| Conversion | Local: Mermaid → scene via the bundled converter, or the scene as-is | The fork's AI generates Mermaid from the prompt, then the local converter runs |
| Deterministic | Yes | No (depends on the fork's AI provider/model) |
| Result reports | `elementCount` | `elementCount`, `provider`, `model` |

Guidance: use `agent` + `mermaid` when the agent already knows the structure
it wants (fast, deterministic, no rate limits); use `agent` + `scene` when
editing an existing scene programmatically; use `fork-ai` only when the
structure must be invented from a loose description.

Mermaid limits enforced before parsing: at most **250 edges** and **20000
characters** — larger input is rejected instead of silently truncated. A
failed parse never produces a broken scene: the converter's silent
"single placeholder image" fallback is detected and returned as a typed error.

Diagram types and how they are rendered (tested against the fixtures in
`src/scene/fixtures.ts`):

- **Flowcharts** (`flowchart` and `graph` input, `TD`/`TB` and `LR` directions,
  shapes rectangle / rounded / stadium / diamond / circle, edge labels,
  self-edges, cycles, and `subgraph … end` blocks with nesting) are rendered
  by this project's **own layered layout** (`src/scene/flowchart.ts`), not by
  mermaid's dagre engine: under jsdom dagre gets no real text metrics and
  reserves a constant ~74 px per node, stacking boxes of 720–1040 px on top
  of each other (22 overlapping pairs on a measured real diagram). The own
  layout ranks nodes with a cycle-tolerant longest-path layering, orders each
  rank with a barycentre pass, sizes every box from its own label (generously
  enough that Excalidraw's own text metrics cannot overflow it), centres each
  rank, offsets the whole scene to non-negative coordinates, and draws one
  arrow per edge between the box borders with the edge label as free text at
  the midpoint (never bound to the arrow). Subgraphs render as dashed
  enclosing rectangles with their title. Guarantees, verified by the geometry
  tests in `src/scene/flowchart.test.ts`: no two node boxes overlap, no
  negative coordinates, every node label inside its box, every arrow with
  non-zero width AND height, no image elements. Recorded simplifications:
  `BT`/`RL` are laid out as `TB`/`LR` respectively, arrows between
  non-adjacent ranks are straight lines and may cross boxes they do not
  connect, and diamond/circle boxes are sized for the shape's inscribed label
  zone.
- **ER diagrams** (`erDiagram`, with entity attributes, keys, comments,
  relationships, cardinalities and self-relationships) are rendered by this
  project's **own layout** (`src/scene/er.ts`), not by the dependency: the
  dependency's ER parser derives every position and size from rendered SVG
  geometry, which does not exist server-side, and the result is illegible.
  The own layout reads the ER model from mermaid's diagram db, places entities
  on a grid, keeps attribute texts inside their boxes, and guarantees
  non-degenerate arrows (verified by the geometry tests in
  `src/scene/er.test.ts`: no overlapping boxes, no negative coordinates,
  non-zero arrows).

Any other Mermaid diagram type (sequence, class, state, pie, …) fails fast
with a typed `UnsupportedDiagramError` naming the detected type and the
supported list (flowchart, ER), instead of producing garbage or a placeholder
image. A failed detection (genuinely invalid input) still raises the typed
parse error.

Parse result metadata reports `skeletonElementCount` and `elementCount` on
both paths.

## Troubleshooting

- **Server exits with code 78 at startup.** Invalid configuration (sysexits
  `EX_CONFIG`, chosen deliberately so supervisors can distinguish "bad config,
  do not retry" from a generic crash). The stderr line names the offending
  variable, e.g. `invalid configuration: EXCALIDRAW_USERNAME is required…`.
  Fix the variable (see `env.example`) and restart. The password is never
  printed.
- **Authentication failures.** On a 401 the client re-logs in once and retries
  the call once; if credentials are genuinely wrong the tool result says
  `Authentication failed… Fix: check EXCALIDRAW_USERNAME and
  EXCALIDRAW_PASSWORD`.
- **Rate limiting.** The fork's AI endpoint answers 429 with a `Retry-After`
  header; the tool result includes the retry hint, e.g. `retry in 7 seconds`.
- **Name normalization surprises.** Names are canonicalized before use: NFKC
  normalize → runs of characters outside `[\w\- ]` become `-` → whitespace
  runs become `-` → `-` runs collapse → leading/trailing `[-_. ]` stripped →
  lowercased → empty results become `diagrama-1` → truncated to 80 characters.
  `create_diagram("Mi Diagrama!!")` creates `mi-diagrama`; the server's echoed
  canonical name is authoritative and is what `create_diagram` returns.
- **Measured layout limits** (from `odd/notes/mermaid-node-spike.md`; the
  calibration constants give 0 wrapped / 0 overflowing labels on the fixture
  set): labels bound to **vertical arrows** overflow because the arrow's
  bounding box is ~0 px wide (measured: `"HTTP"` in a 0 px arrow, `"no"` in an
  8 px one) — this needs label unbinding the dependency does not offer;
  **diamonds** pass with the calibrated constants but are recorded, not
  guaranteed; **long labels on short horizontal arrows** have thin margins
  (measured: 44 px text in a 46 px arrow for `"envia solicitud"`).

## Agent support skill

A support skill for agents with these tools available lives in
`skills/excalidraw-diagrams/SKILL.md`. To install it for all projects on this
machine, copy the `skills/excalidraw-diagrams/` directory (whole folder,
including `SKILL.md`) into the personal skills directory of this machine:
`C:\Users\slowf\.agents\skills\`. Agent tooling that reads that directory
picks the skill up from any project afterwards.

## Development

```bash
npm test               # node --test over all src/**/*.test.ts — verified: 136 tests, 136 pass
npm run build          # verified: exit 0
npm run spike:mermaid  # converts a fixture diagram end-to-end — verified: ok: true, 21 elements
```

### End-to-end verification

```bash
node scripts/e2e.mjs
```

Exercises the real stack — real config, real API client, real tool handlers,
real Mermaid conversion — against a real HTTP server, and prints a JSON report
with one entry per step (`name`, `ok`, `evidence`); exit code 0 when every step
passed. Against the built-in local server (the default) it also verifies
state transitions: overwrite protection, list reflection, stored scenes,
delete-then-404.

To run against a **real deployment** instead, export `EXCALIDRAW_BASE_URL`,
`EXCALIDRAW_USERNAME` and `EXCALIDRAW_PASSWORD` before running the script:
diagram names are then prefixed `mcp-e2e-` so the deployment is not polluted,
and everything the script creates is deleted afterwards. In real mode the
`fork-ai` step is actually validated: the reported provider and model must be
non-empty strings different from the local stub's canned values, and the
created diagram must contain at least one element. A skipped step is recorded
only when the deployment itself reports its AI endpoint as unusable — an HTTP
502/503/504 gateway-style failure or an error naming the provider
configuration — with the reason captured in the report; any other wrong answer
(unknown provider, empty model, failed conversion, empty diagram) fails the
run. The script never reads a `.env`; it requires `npm run build` to have
produced the converter bundle and builds it on demand if missing.

Note: the default local server is a stateful variant of the T3 stub contract
(the T3 stub in `src/api/stub-server.ts` is intentionally stateless — canned
responses — which cannot demonstrate persistence); see `startStatefulStub` in
`scripts/e2e.mjs`.
