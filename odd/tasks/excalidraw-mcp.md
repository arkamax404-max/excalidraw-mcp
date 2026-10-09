# Feature: excalidraw-mcp

MCP server (stdio) that lets any agent create, list, read, and delete Excalidraw
diagrams in the self-hosted fork living at `D:/Desarrollo/excalidraw`, acting as a
single configured user.

## Goal

Give agents a first-class way to persist diagrams into the Excalidraw fork:

1. the calling agent names the diagram;
2. the agent chooses who generates the content:
   - `agent` mode: the active LLM supplies `mermaid` or a raw Excalidraw `scene`;
   - `fork-ai` mode: the fork's existing AI endpoint produces Mermaid from a prompt
     and the MCP converts it to a scene;
3. the MCP authenticates as the user declared in its environment file and writes the
   diagram through the existing HTTP API.

## Approved decisions (user, this session)

| Decision | Choice |
| --- | --- |
| Location | Sibling repository `D:/Desarrollo/excalidraw-mcp`, independent from the fork |
| Stack | Node.js + TypeScript + official MCP SDK over stdio |
| Agent-supplied format | Agent chooses: `mermaid` (converted by the MCP) or raw `scene` |
| Tool scope | Full CRUD: create, list, get, delete |

## Contract of the target system (evidence from the fork)

- `POST /api/auth/login {username,password}` -> session cookie `excalidraw.sid`
  (`app/server.mjs:234`).
- `GET /api/files` -> `{files:[{name,fileName,updatedAt}]}` (`app/server.mjs:531`).
- `GET /api/files/:name` -> `{file, scene}` (`app/server.mjs:553`).
- `PUT /api/files/:name` with the raw scene body; requires `elements` to be an array
  (`isValidScene`, `app/server.mjs:110`), 25 MB JSON limit, name normalized by
  `sanitizeBaseName` (`app/server.mjs:44`: NFKC, non-word chars to `-`, lowercase,
  max 80 chars, fallback `diagrama-1`).
- `DELETE /api/files/:name` -> `{ok:true,file}` (`app/server.mjs:616`).
- `POST /api/ai/diagram {prompt}` -> `{mermaid, provider, model}`; OpenRouter with a
  Groq fallback chain, per-user rate limited, returns **Mermaid text only**
  (`app/server.mjs:502`, `app/openrouter.mjs`).
- Mermaid -> scene conversion exists today only in the browser
  (`app/src/ai/mermaidToScene.js`).

## Non-goals

- No changes to the fork repository. The MCP consumes its existing HTTP API only.
- No new UI, no embedding, no real-time collaboration.
- No multi-user credential switching: one configured user per MCP instance.
- No upload of binary files/assets beyond what the converter already produces.

## Known risk and contingency

Risk R1: `@excalidraw/mermaid-to-excalidraw` references `document`/`window` in its
dist build (`dist/parseMermaid.js`, `dist/parser/cssUtils.js`, `dist/utils.js`), so
headless conversion may need a DOM shim (jsdom) or may be blocked entirely.

- Task 1 is a spike that answers this before any dependent design is committed.
- If a shim is sufficient: proceed as planned.
- If Node conversion proves impossible: stop and ask the user to choose between a
  headless-browser renderer dependency and reducing `fork-ai` mode to prompt ->
  Mermaid passthrough for the agent to convert. No silent fallback.

## Tasks

Each task closes with one work-unit commit on the feature branch, carrying its tests
and docs. Checks listed per task are mandatory evidence.

- [x] **T1 Scaffold and spike headless Mermaid conversion**
  - `git init`, `.gitignore`, `package.json` (ESM, TypeScript, `node --test`),
    `tsconfig.json`, `env.example`, README stub.
  - Spike: prove `parseMermaidToExcalidraw` + `convertToExcalidrawElements` run under
    Node 24 with or without a DOM shim; record the finding in
    `odd/notes/mermaid-node-spike.md`.
  - Checks: `npm run build` clean (`exit 0`); `npm test` passes with zero tests;
    `npm run spike:mermaid` prints `ok: true`, 21 converted elements, 0 invalid ids,
    and a scene whose `elements` array is non-empty.
  - Verdict: variant (b) — jsdom plus `getBBox`/canvas stubs, converter supplied as an
    esbuild bundle, `mermaid` pinned to 11.15.0 for parity with the fork.
  - Commit: `chore: scaffold excalidraw-mcp and prove mermaid conversion in node`

- [x] **T2 Configuration from an environment file** (test-first)
  - `src/config.ts`: `loadConfig(env)` with required `EXCALIDRAW_USERNAME` and
    `EXCALIDRAW_PASSWORD`, `EXCALIDRAW_BASE_URL` defaulted to `http://localhost:3030`
    with trailing slashes trimmed, `EXCALIDRAW_TIMEOUT_MS` defaulted to `30000`,
    `ConfigError` naming the offending variable, and `describeConfig` that reports the
    password only as present or absent. `loadEnvFile` parses through `dotenv` and stays
    pure: it returns a record, never mutating `process.env`, and never throws when the
    file is absent.
  - Checks: `npm test` 15/15 green after an observed RED of 2 failing tests;
    `npm run build` exit 0 with no stale `dist/index.js`; `test-fixtures/` removed.
  - Commit: `feat(config): load excalidraw connection settings from env file`

- [x] **T3 Authenticated API client** (test-first, local stub server)
  - `src/api/client.ts`, `src/api/errors.ts`, `src/api/stub-server.ts`: login with an
    in-memory cookie, single re-login and single retry on 401, `listDiagrams`,
    `getDiagram`, `putDiagram`, `deleteDiagram`, `generateMermaid`; typed errors for
    400/401/404/429/5xx, timeout and unreachable host; names only URL-encoded because
    the server owns normalization; no credential or cookie value in any error.
  - Checks: `npm test` 28/28 green after an observed RED; `npm run build` exit 0;
    `authedRequest` is a single conditional retry, so no loop is possible.
  - Commit: `feat(api): authenticated excalidraw client with session reuse`

- [x] **T4 Mermaid to scene conversion** (test-first)
  - `src/scene/mermaid.ts`, `src/scene/dom-shim.ts`, `src/scene/errors.ts`,
    `src/scene/fixtures.ts`: the shim became runtime code (`jsdom` moved to
    `dependencies`), `mermaidToScene` validates input, pre-checks the dependency's own
    limits, parses strictly and retries once with `subgraph ... end` blocks flattened,
    converts through the bundled converter, and returns
    `{type, version, source, elements, appState, files}` plus metadata naming the parse
    path. The dependency's silent placeholder-image fallback is detected and turned
    into a typed error instead of being persisted.
  - The spike script now imports the production shim, so it proves the real code path.
  - Checks: `npm test` 44/44 green after an observed RED; `npm run build` exit 0; a
    post-build `node -e` import of `dist/scene/mermaid.js` converts a flowchart;
    `npm run spike:mermaid` still `ok: true`.
  - Calibration (constants `NODE_GLYPH_FACTOR=0.6`, `NODE_SLACK=24`,
    `TEXT_GLYPH_FACTOR=0.14`, `TEXT_SLACK=2`), measured per fixture:

    | fixture | elements | wrapped | overflowing |
    | --- | --- | --- | --- |
    | chain of rectangles | 8 | 0 | 0 |
    | two-word label | 5 | 0 | 0 |
    | ellipse nodes | 5 | 0 | 0 |
    | decision diamond | 10 | 0 | 0 |
    | horizontal edge label | 6 | 0 | 0 |

  - Recorded limitations, not hidden: labels bound to **vertical** arrows still
    overflow (`overflowingTextCount: 2` in the spike fixture) because a vertical
    arrow's bounding box is ~0 px wide; diamonds pass with these constants but are
    recorded rather than guaranteed; a long label on a short arrow can still overflow.
  - Commit: `feat(scene): convert mermaid to excalidraw scene in node`

- [ ] **T5 MCP tools** (test-first at handler level)
  - `src/tools/`: `create_diagram` (`name`, `mode: agent|fork-ai`, `prompt`,
    `mermaid`, `scene`, `overwrite`), `list_diagrams`, `get_diagram`
    (`format: scene|summary`), `delete_diagram`.
  - Mirror the server's name normalization and document that mirroring.
  - `overwrite: false` must not clobber an existing diagram.
  - Checks: `node --test` green with a fake client covering both modes, overwrite
    protection, and summary formatting.
  - Commit: `feat(tools): diagram crud tools with agent and fork-ai modes`

- [ ] **T6 stdio server entrypoint**
  - `src/server.ts` + `bin` mapping; stdout reserved for JSON-RPC, every log line on
    stderr; graceful shutdown.
  - Checks: a scripted stdio session (`initialize`, `tools/list`) lists the four
    tools and stdout stays pure JSON-RPC.
  - Commit: `feat(server): serve mcp over stdio with stderr-only logging`

- [ ] **T7 Documentation and support skill**
  - `README.md`: setup, environment file contract, client configuration, mode
    guidance, rate-limit note.
  - Support skill `excalidraw-diagrams` so agents pick the right mode and naming.
  - Checks: documented commands verified by running them.
  - Commit: `docs: document setup, env contract and agent skill`

- [ ] **T8 End-to-end verification against a running server**
  - `scripts/e2e.mjs` exercising create (both modes) -> list -> get -> delete against
    a stub or a real deployment, with evidence captured.
  - Checks: e2e run output recorded; failures reported, not hidden.
  - Commit: `test(e2e): verify diagram lifecycle against a running server`

## Verification summary

Filled in during Close: tasks completed, every failed or skipped check, and the next
step.
