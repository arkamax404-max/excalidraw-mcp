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

- [x] **T5 MCP tools** (test-first at handler level)
  - `src/tools/normalize.ts`, `src/tools/errors.ts`, `src/tools/diagram-tools.ts`,
    `src/tools/register.ts`: `create_diagram` (`name`, `mode: agent|fork-ai`, `prompt`,
    `mermaid`, `scene`, `overwrite`), `list_diagrams`, `get_diagram`
    (`format: scene|summary`), `delete_diagram`. Handler logic is dependency-injected
    and transport-free; registration onto `McpServer` is a separate module.
  - The server's name normalization is mirrored locally and documented as a mirror,
    with the server's echoed name as the authority. `overwrite: false` refuses to
    clobber and names the existing diagram.
  - Context protection: `get_diagram` defaults to a summary bounded to 20 labels of
    80 characters, and reports how many labels it withheld.
  - Checks: `npm test` 65/65 green after an observed RED; `npm run build` exit 0;
    `registerDiagramTools` loaded without a transport and the four tool names
    confirmed.
  - Commit: `feat(tools): diagram crud tools with agent and fork-ai modes`

- [x] **T6 stdio server entrypoint**
  - `src/server.ts`: shebang entry, env-file resolution (`EXCALIDRAW_ENV_FILE`, then
    the working directory `.env`, with real environment variables winning), network-free
    startup so `tools/list` works with no Excalidraw server running, lazy login on the
    first tool call, exit code 78 (sysexits `EX_CONFIG`) on invalid configuration, and
    graceful shutdown on `SIGINT`, `SIGTERM` and stdin end.
  - stdout purity guard: `console.log`/`info`/`debug` are redirected to stderr, because
    a single stray stdout line corrupts the JSON-RPC session.
  - Checks: `npm test` 69/69 green after an observed RED; `npm run build` exit 0 with the
    shebang preserved in `dist/server.js`; a real piped session against the built server
    returned 2 stdout lines, all parsing as JSON-RPC, listing `create_diagram`,
    `list_diagrams`, `get_diagram`, `delete_diagram`, exit 0; an invalid configuration
    exited 78 naming the variable with the password absent from stderr.
  - Known limit: Windows cannot deliver `SIGTERM` to a handler, so the portable clean
    shutdown path there is stdin end, which is wired and tested.
  - Commit: `feat(server): serve mcp over stdio with stderr-only logging`

- [ ] **T7 Documentation and support skill**
  - `README.md`: setup, the environment file contract including that the human owns
    `.env`, client configuration for an MCP host, mode guidance (when the agent should
    convert locally versus delegate to the fork's AI), and the rate-limit note.
  - Support skill `skills/excalidraw-diagrams/SKILL.md`, versioned here and installed
    into the personal skills directory so agents in any project can find it. It teaches
    mode selection, naming, Mermaid limits, and the known layout limits from T4.
  - Checks: every documented command is actually run; the skill file has valid
    frontmatter and its triggers match the request wording.
  - Commit: `docs: document setup, env contract and agent skill`

- [x] **T8 End-to-end verification against a running server**
  - `scripts/e2e.mjs`: 12 steps over the real stack (real config, real API client, real
    tool handlers, real Mermaid conversion) against a real HTTP server on an ephemeral
    port, printing a per-step JSON report and continuing past a failure so the report is
    complete. It also runs against a real deployment when `EXCALIDRAW_BASE_URL`,
    `EXCALIDRAW_USERNAME` and `EXCALIDRAW_PASSWORD` are all set, prefixing names with
    `mcp-e2e-` and deleting everything it creates.
  - `src/e2e.test.ts` runs the script as a child process, asserting exit 0 and every step
    ok, so the lifecycle is covered by `npm test`.
  - Checks: `npm test` 70/70 green after an observed RED; `node scripts/e2e.mjs` exit 0
    with `passed: 12, failed: 0`; a deliberately broken assertion produced exit 1 and a
    complete report with one failure, then green again after restoring it;
    `npm run build` exit 0.
  - Real-deployment follow-up (initially unverified, executed later): the real mode
    was run against the live Excalidraw deployment and passed 12/12 with
    `mode="real deployment"`; cleanup was then verified independently — the account
    held only the pre-existing `ejemplo-camel`.
  - The `fork-ai` leg was validated by hand against the live deployment before the
    script could assert it: provider `openrouter`, model `openrouter/free`, 11
    elements, stored, read back and deleted. `scripts/e2e.mjs` now asserts that leg
    itself: in real-deployment mode the step requires non-empty provider/model
    different from the stub's canned values plus `elementCount > 0`, and records a
    skip (without failing the run) only when the deployment reports its AI endpoint
    as unusable (HTTP 502/503/504 or a provider-configuration error). The
    classification is unit-tested in `src/e2e-steps.test.ts` without a real provider.
  - Commit: `test(e2e): verify diagram lifecycle against a running server`

## Verification summary

All eight tasks completed, one work-unit commit each, on `feat/excalidraw-mcp`:

| Task | Commit |
| --- | --- |
| T1 scaffold and headless Mermaid spike | `55c450e` |
| T2 configuration from the env file | `8b0d0e4` |
| T3 authenticated API client | `0ec0231` |
| T4 Mermaid to scene conversion | `8275cff` |
| T5 diagram CRUD tools | `9835560` |
| T6 stdio server entrypoint | `d85b25f` |
| T7 documentation and agent skill | `7b50eb3` |
| T8 end-to-end verification | see the commit for this task |

Final state: `npm test` 70/70 green, `npm run build` exit 0, `node scripts/e2e.mjs`
12/12 steps ok, and a real stdio session listing the four tools with pure JSON-RPC on
stdout.

Follow-up: the real-deployment mode was later executed against the live deployment
and passed 12/12 (`mode="real deployment"`, cleanup verified independently — only the
pre-existing `ejemplo-camel` remained), the `fork-ai` leg was validated by hand
(provider `openrouter`, model `openrouter/free`, 11 elements stored, read back and
deleted), and `scripts/e2e.mjs` was extended to assert that leg itself, with the
classification unit-tested in `src/e2e-steps.test.ts`.

### Checks that did not pass, and were not hidden

- Labels bound to **vertical** arrows still overflow (`overflowingTextCount: 2`). A
  vertical arrow's bounding box is about 0 px wide, so no measurement constant can fix
  it. The skill tells agents to put labelled arrows horizontally.
- **Diamonds** measure 0 wrapped and 0 overflowing on the fixture, but the usable text
  width depends on the label, so they are recorded rather than guaranteed.
- **`SIGTERM` cannot reach a handler on Windows**, so the portable clean-shutdown path
  there is stdin end. That path is wired and tested.
- `npm run start` pollutes stdout with npm banners, which would corrupt JSON-RPC. The
  documented launch commands are `node dist/server.js` and `npm run start --silent`.
- The agent tooling forbids writing `.env`-prefixed paths, so the committed template is
  `env.example` and the human creates `.env`.

### Next steps

- The end-to-end script embeds a stateful stub because the shared T3 stub is stateless.
  Consolidating both into one stateful stub removes a contract-drift risk.
- Native review of a work-unit commit is the user's decision, and delivery (push, pull
  request, merge) stays with the human.
