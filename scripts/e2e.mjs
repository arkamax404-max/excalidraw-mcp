/**
 * End-to-end verification of the whole excalidraw-mcp stack.
 *
 * Exercises the REAL components — real config, real API client, real tool
 * handlers, real Mermaid conversion — against a real HTTP server:
 *
 * - Default: the local stub Excalidraw server (`src/api/stub-server.ts`) on an
 *   ephemeral port, with its canned `POST /api/ai/diagram` response so
 *   `fork-ai` mode is deterministic.
 * - If EXCALIDRAW_BASE_URL, EXCALIDRAW_USERNAME and EXCALIDRAW_PASSWORD are
 *   ALL set in the environment, it runs against that real deployment instead:
 *   diagram names are prefixed `mcp-e2e-` so the deployment is not polluted,
 *   and everything the script creates is deleted afterwards.
 *
 * The script never reads or writes a `.env`; it builds its own config record.
 *
 * Output: one JSON report on stdout with an entry per step ({name, ok,
 * evidence}), plus a summary. The JSON report is the ONLY thing this script
 * writes to stdout; the stub and the libraries may write diagnostics to
 * stderr. Exit code 1 if any step failed. The `create-fork-ai` step is
 * validated according to the mode: stub mode asserts the canned
 * provider/model; real-deployment mode asserts a real, non-stub provider and
 * model plus a non-empty diagram. A skipped fork-ai step (never failing the
 * run) is recorded ONLY in real-deployment mode, and only when the deployment
 * itself reports its AI endpoint as unusable — an HTTP 502/503/504
 * gateway-style failure or a typed error naming the provider configuration.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createExcalidrawClient } from "../src/api/client.ts";
import { ApiError, HttpApiError, NotFoundError } from "../src/api/errors.ts";
import { loadConfig } from "../src/config.ts";
import { MermaidParseError, MermaidSceneError } from "../src/scene/errors.ts";
import { mermaidToScene } from "../src/scene/mermaid.ts";
import { createDiagramTools } from "../src/tools/diagram-tools.ts";
import { normalizeDiagramName } from "../src/tools/normalize.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// The converter bundle is a runtime requirement of the Mermaid pipeline; build
// it on demand so the script only needs the sources and node_modules.
const bundlePath = join(repoRoot, "dist", "vendor", "excalidraw-converter.mjs");
if (!existsSync(bundlePath)) {
  execFileSync("npm", ["run", "build:converter"], { stdio: "pipe", cwd: repoRoot });
}

/**
 * Stateful Excalidraw stub for the e2e run.
 *
 * WHY NOT src/api/stub-server.ts: it faithfully mirrors the fork's HTTP
 * contract but is STATELESS (canned responses, no storage) — by design it
 * cannot demonstrate the state transitions this verification needs (list
 * reflection, conflict on an existing name, a stored scene surviving a
 * round-trip, delete-then-404). The stub file must not be modified, so this
 * script embeds a stateful variant of the SAME fixed contract: same
 * credentials (alice/secret), same cookie name, same canned AI response
 * (provider "stub", model "stub-1"), same error shapes. The client, the tool
 * handlers, the Mermaid pipeline and the config are all the real ones.
 */
async function startStatefulStub() {
  const SESSION_COOKIE = "excalidraw.sid=e2e-session; Path=/; HttpOnly";
  const VALID_USER = { username: "alice", password: "secret" };
  const CANNED_AI = { mermaid: "graph TD;\nA-->B", provider: "stub", model: "stub-1" };
  /** name -> { file: {name, fileName, updatedAt}, scene } */
  const store = new Map();

  const hasSession = (req) => (req.headers.cookie ?? "").includes("excalidraw.sid=e2e-session");
  const readBody = (req) =>
    new Promise((resolveBody) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        try {
          resolveBody(raw === "" ? undefined : JSON.parse(raw));
        } catch {
          resolveBody(undefined);
        }
      });
    });
  const sendJson = (res, status, body, headers) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const url = req.url ?? "/";

      if (url === "/api/auth/login" && req.method === "POST") {
        if (body?.username !== VALID_USER.username || body?.password !== VALID_USER.password) {
          sendJson(res, 401, { error: "invalid credentials" });
          return;
        }
        sendJson(res, 200, { ok: true, user: { username: VALID_USER.username } }, { "Set-Cookie": SESSION_COOKIE });
        return;
      }
      if (url === "/api/auth/session") {
        sendJson(
          res,
          200,
          hasSession(req) ? { authenticated: true, user: { username: VALID_USER.username } } : { authenticated: false },
        );
        return;
      }
      if (url === "/api/ai/diagram" && req.method === "POST") {
        if (body?.prompt === "limited") {
          sendJson(res, 429, { error: "rate limited" }, { "Retry-After": "7" });
          return;
        }
        sendJson(res, 200, CANNED_AI);
        return;
      }

      if (!hasSession(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (url === "/api/files" && req.method === "GET") {
        sendJson(res, 200, { files: [...store.values()].map((entry) => entry.file) });
        return;
      }
      if (url.startsWith("/api/files/")) {
        const name = decodeURIComponent(url.slice("/api/files/".length));
        if (req.method === "GET") {
          const entry = store.get(name);
          if (!entry) {
            sendJson(res, 404, { error: "file not found" });
            return;
          }
          sendJson(res, 200, { file: entry.file, scene: entry.scene });
          return;
        }
        if (req.method === "PUT") {
          if (!body || !Array.isArray(body.elements)) {
            sendJson(res, 400, { error: "body must contain an elements array" });
            return;
          }
          const file = { name, fileName: `${name}.excalidraw`, updatedAt: new Date().toISOString() };
          store.set(name, { file, scene: body });
          sendJson(res, 200, { ok: true, file });
          return;
        }
        if (req.method === "DELETE") {
          const entry = store.get(name);
          if (!entry) {
            sendJson(res, 404, { error: "file not found" });
            return;
          }
          store.delete(name);
          sendJson(res, 200, { ok: true, file: { name: entry.file.name, fileName: entry.file.fileName } });
          return;
        }
      }
      sendJson(res, 404, { error: "no such route" });
    })().catch((error) => {
      console.error("[e2e-stub] handler failed:", error);
      sendJson(res, 500, { error: "stub failure" });
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
    server.on("error", rejectListen);
  });
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}

function describeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}

// The canned fork-ai answer of the embedded stateful stub.
const STUB_PROVIDER = "stub";
const STUB_MODEL = "stub-1";
/** Gateway-style statuses under which the fork's AI endpoint reports it cannot serve. */
const UNAVAILABLE_STATUSES = [502, 503, 504];

/**
 * Validates a successful `create-fork-ai` result according to the run mode.
 *
 * Stub mode keeps the hard canned assertion (provider "stub", model "stub-1").
 * Real-deployment mode asserts that provider and model are non-empty strings
 * that are NOT the stub values, and that the conversion produced at least one
 * element. Returns `{ok: true}` or `{ok: false, reason}`.
 */
export function classifyForkAiResult(result, { realDeployment }) {
  const provider = result?.provider;
  const model = result?.model;
  const elementCount = result?.elementCount;
  if (!realDeployment) {
    return provider === STUB_PROVIDER && model === STUB_MODEL
      ? { ok: true }
      : { ok: false, reason: `expected canned provider/model, got ${JSON.stringify(provider)}/${JSON.stringify(model)}` };
  }
  const problems = [];
  if (typeof provider !== "string" || provider.length === 0) {
    problems.push(`provider must be a non-empty string, got ${JSON.stringify(provider ?? null)}`);
  }
  if (typeof model !== "string" || model.length === 0) {
    problems.push(`model must be a non-empty string, got ${JSON.stringify(model ?? null)}`);
  }
  if (provider === STUB_PROVIDER || model === STUB_MODEL) {
    problems.push(`the stub provider/model (${STUB_PROVIDER}/${STUB_MODEL}) cannot be a real deployment's answer`);
  }
  if (typeof elementCount !== "number" || !Number.isInteger(elementCount) || elementCount <= 0) {
    problems.push(`elementCount must be a positive integer, got ${JSON.stringify(elementCount ?? null)}`);
  }
  return problems.length > 0 ? { ok: false, reason: problems.join("; ") } : { ok: true };
}

/**
 * Classifies a failed `create-fork-ai` call in real-deployment mode.
 *
 * A recorded skip is allowed ONLY when the deployment itself reports its AI
 * endpoint as unusable: an HTTP 502/503/504 gateway-style failure, or a typed
 * error whose message names the provider configuration (the fork reports a
 * missing provider configuration as 503 "AI generation is not configured").
 * Every other error — wrong answer, conversion failure, rate limit, transport
 * failure — must fail the step. Returns `{skipped: true, reason}` or
 * `{skipped: false}`.
 */
export function classifyForkAiError(error) {
  const description = describeError(error);
  if (error instanceof HttpApiError && UNAVAILABLE_STATUSES.includes(error.status)) {
    return { skipped: true, reason: { ...description, status: error.status } };
  }
  if (error instanceof ApiError && /not configured/i.test(description.message ?? "")) {
    return { skipped: true, reason: description };
  }
  return { skipped: false };
}

/** Runs `fn` expecting a rejection; returns the error, or throws if none. */
async function expectRejection(fn, label) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error(`expected ${label} to be rejected, but it succeeded`);
}

async function main() {
  const steps = [];
  async function step(name, fn) {
    try {
      const evidence = (await fn()) ?? "ok";
      steps.push({ name, ok: true, evidence });
    } catch (error) {
      steps.push({ name, ok: false, evidence: describeError(error) });
    }
  }

  const realDeployment =
    process.env.EXCALIDRAW_BASE_URL !== undefined &&
    process.env.EXCALIDRAW_USERNAME !== undefined &&
    process.env.EXCALIDRAW_PASSWORD !== undefined;

  let stub;
  let config;
  if (realDeployment) {
    config = loadConfig(process.env);
  } else {
    stub = await startStatefulStub();
    // The stub's canned valid user is alice/secret (fixed contract, documented
    // on startStatefulStub above).
    config = loadConfig({
      EXCALIDRAW_BASE_URL: `http://127.0.0.1:${stub.port}`,
      EXCALIDRAW_USERNAME: "alice",
      EXCALIDRAW_PASSWORD: "secret",
    });
  }
  const mode = realDeployment ? "real deployment" : "stub";
  const prefix = realDeployment ? "mcp-e2e-" : "";
  const nm = (text) => prefix + text;
  const expected = (text) => normalizeDiagramName(nm(text));

  const client = createExcalidrawClient(config);
  const tools = createDiagramTools({ client, mermaidToScene });
  const created = [];

  try {
    await step("login", async () => {
      await client.login();
      return { authenticated: true };
    });

    await step("create-agent-mermaid", async () => {
      const result = await tools.create_diagram({
        name: nm("Flujo E2E"),
        mode: "agent",
        mermaid: "flowchart TD\n  A[Inicio] --> B[Fin]",
      });
      created.push(result.name);
      if (result.name !== expected("Flujo E2E")) {
        throw new Error(`canonical name mismatch: ${result.name}`);
      }
      if (result.mode !== "agent" || !(result.elementCount >= 3)) {
        throw new Error(`unexpected result: ${JSON.stringify(result)}`);
      }
      return { canonicalName: result.name, elementCount: result.elementCount };
    });

    await step("create-agent-scene", async () => {
      const scene = {
        type: "excalidraw",
        version: 2,
        source: "e2e",
        elements: [
          { id: "a", type: "rectangle", width: 100, height: 60 },
          { id: "b", type: "text", text: "hola e2e", width: 60 },
        ],
        appState: {},
        files: {},
      };
      const result = await tools.create_diagram({ name: nm("Escena Directa"), mode: "agent", scene });
      created.push(result.name);
      if (result.elementCount !== 2) {
        throw new Error(`expected 2 elements, got ${result.elementCount}`);
      }
      return { canonicalName: result.name, elementCount: result.elementCount };
    });

    await step("create-fork-ai", async () => {
      let result;
      try {
        result = await tools.create_diagram({
          name: nm("Con IA"),
          mode: "fork-ai",
          prompt: "un flujo simple de dos pasos",
        });
      } catch (error) {
        // Only against a real deployment may the AI endpoint be unusable, and
        // only when the deployment itself reports it (gateway-style 5xx or a
        // provider-configuration error) may the step be skipped. The stub's
        // canned response makes this step a hard requirement in stub mode.
        if (realDeployment) {
          const verdict = classifyForkAiError(error);
          if (verdict.skipped) {
            return { skipped: true, reason: verdict.reason };
          }
        }
        throw error;
      }
      created.push(result.name);
      const verdict = classifyForkAiResult(result, { realDeployment });
      if (!verdict.ok) {
        throw new Error(verdict.reason);
      }
      return {
        canonicalName: result.name,
        provider: result.provider,
        model: result.model,
        elementCount: result.elementCount,
      };
    });

    await step("overwrite-protection", async () => {
      const canonical = expected("Flujo E2E");
      const before = await tools.get_diagram({ name: canonical, format: "scene" });
      const beforeCount = before.scene.elements.length;
      const conflict = await expectRejection(
        () => tools.create_diagram({ name: nm("Flujo E2E"), mode: "agent", mermaid: "flowchart TD\n  A --> B" }),
        "the unprotected re-create",
      );
      if (!(conflict instanceof Error) || !conflict.message.includes(canonical)) {
        throw new Error(`conflict error must name the existing diagram: ${String(conflict)}`);
      }
      const unchanged = await tools.get_diagram({ name: canonical, format: "scene" });
      if (unchanged.scene.elements.length !== beforeCount) {
        throw new Error("the refused create must not change the stored scene");
      }
      const replaced = await tools.create_diagram({
        name: nm("Flujo E2E"),
        mode: "agent",
        mermaid: "flowchart TD\n  X[Uno] --> Y[Dos] --> Z[Tres]",
        overwrite: true,
      });
      if (replaced.name !== canonical) {
        throw new Error(`overwrite returned the wrong canonical name: ${replaced.name}`);
      }
      const after = await tools.get_diagram({ name: canonical, format: "scene" });
      if (after.scene.elements.length === beforeCount) {
        throw new Error("overwrite: true must replace the stored scene");
      }
      return {
        conflictMessage: conflict.message,
        elementsBefore: beforeCount,
        elementsAfterOverwrite: after.scene.elements.length,
      };
    });

    await step("list-diagrams", async () => {
      const { diagrams } = await tools.list_diagrams();
      const names = diagrams.map((d) => d.name);
      for (const createdName of created) {
        if (!names.includes(createdName)) {
          throw new Error(`created diagram "${createdName}" missing from the list`);
        }
      }
      return { diagramCount: diagrams.length, includesCreated: created.length };
    });

    await step("summary-and-bound", async () => {
      const manyTexts = Array.from({ length: 300 }, (_, i) => ({
        id: `t${i}`,
        type: "text",
        text: `etiqueta ${i} ${"contenido ".repeat(24)}`,
      }));
      const big = await tools.create_diagram({
        name: nm("E2E Grande"),
        mode: "agent",
        scene: { type: "excalidraw", version: 2, source: "e2e", elements: manyTexts, appState: {}, files: {} },
      });
      created.push(big.name);
      const summary = await tools.get_diagram({ name: big.name });
      if (summary.elementCount !== 300 || summary.labels.total !== 300) {
        throw new Error(`unexpected summary: ${JSON.stringify({ elementCount: summary.elementCount, total: summary.labels.total })}`);
      }
      if (summary.labels.shown.length > 20) {
        throw new Error(`label list exceeded the bound: ${summary.labels.shown.length}`);
      }
      if (summary.labels.shown.some((label) => label.length > 80)) {
        throw new Error("a label exceeded the 80-character truncation");
      }
      return {
        elementCount: summary.elementCount,
        labelsTotal: summary.labels.total,
        labelsShown: summary.labels.shown.length,
        maxLabelLength: Math.max(...summary.labels.shown.map((label) => label.length)),
      };
    });

    await step("get-scene", async () => {
      const canonical = expected("Flujo E2E");
      const result = await tools.get_diagram({ name: canonical, format: "scene" });
      if (!Array.isArray(result.scene.elements) || result.scene.elements.length === 0) {
        throw new Error("scene format must return the full non-empty scene");
      }
      return { canonicalName: result.name, elementCount: result.scene.elements.length };
    });

    await step("name-normalization", async () => {
      const result = await tools.create_diagram({
        name: nm("Informe Final!!"),
        mode: "agent",
        mermaid: "flowchart TD\n  A[Uno] --> B[Dos]",
      });
      created.push(result.name);
      if (result.name !== expected("Informe Final!!")) {
        throw new Error(`expected ${expected("Informe Final!!")}, got ${result.name}`);
      }
      return { requestedName: nm("Informe Final!!"), canonicalName: result.name };
    });

    await step("malformed-mermaid", async () => {
      const error = await expectRejection(
        () => tools.create_diagram({ name: nm("roto"), mode: "agent", mermaid: "esto no es mermaid ===" }),
        "the malformed Mermaid create",
      );
      if (!(error instanceof MermaidSceneError)) {
        throw new Error(`expected a typed Mermaid error, got: ${describeError(error).name}: ${describeError(error).message}`);
      }
      if (!(error instanceof MermaidParseError)) {
        throw new Error(`expected MermaidParseError, got ${error.name}`);
      }
      if (!error.message || error.message.length < 10) {
        throw new Error("the error message must be actionable");
      }
      const stored = await expectRejection(
        () => tools.get_diagram({ name: expected("roto") }),
        "the get of a diagram that must not exist",
      );
      if (!(stored instanceof NotFoundError)) {
        throw new Error(`the malformed input must not have stored a diagram, but get returned: ${describeError(stored)}`);
      }
      return { errorName: error.name, errorMessage: error.message, nothingStored: true };
    });

    await step("delete-and-not-found", async () => {
      const canonical = expected("Escena Directa");
      const deleted = await tools.delete_diagram({ name: canonical });
      if (deleted.name !== canonical || deleted.deleted !== true) {
        throw new Error(`unexpected delete result: ${JSON.stringify(deleted)}`);
      }
      created.splice(created.indexOf(canonical), 1);
      const again = await expectRejection(() => tools.delete_diagram({ name: canonical }), "the second delete");
      if (!(again instanceof NotFoundError)) {
        throw new Error(`expected NotFoundError on the second delete, got: ${describeError(again)}`);
      }
      return { deletedName: deleted.name, secondDelete: again.name };
    });
  } finally {
    await step("cleanup", async () => {
      const failures = [];
      for (const canonical of [...created]) {
        try {
          await tools.delete_diagram({ name: canonical });
          created.splice(created.indexOf(canonical), 1);
        } catch (error) {
          failures.push({ name: canonical, ...describeError(error) });
        }
      }
      if (failures.length > 0) {
        throw new Error(`cleanup failures: ${JSON.stringify(failures)}`);
      }
      const { diagrams } = await tools.list_diagrams();
      const remaining = diagrams.map((d) => d.name).filter((name) => created.includes(name));
      if (remaining.length > 0) {
        throw new Error(`not cleaned up: ${remaining.join(", ")}`);
      }
      return { deleted: steps.length && created.length === 0 ? "all created diagrams removed" : "see failures" };
    });

    if (stub) {
      await stub.close();
    }
  }

  const failed = steps.filter((s) => s.ok === false).length;
  const skipped = steps.filter((s) => s.evidence && typeof s.evidence === "object" && s.evidence.skipped === true).length;
  console.log(
    JSON.stringify(
      {
        mode,
        steps,
        summary: { total: steps.length, passed: steps.length - failed, failed, skipped },
      },
      null,
      2,
    ),
  );
  process.exitCode = failed > 0 ? 1 : 0;
}

// Run the end-to-end flow only when invoked as the main module, so the
// exported classifiers can be unit-tested without executing the run.
const invokedAsMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedAsMain) {
  await main();
}
