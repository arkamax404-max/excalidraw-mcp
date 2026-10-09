import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { INVALID_CONFIG_EXIT_CODE, guardStdout } from "./server.ts";

/** Absolute source path: Node 24 runs TypeScript directly (type stripping). */
const serverPath = fileURLToPath(new URL("./server.ts", import.meta.url));

const DUMMY_USER = "test-agent";
const DUMMY_PASSWORD = "dummy-password-123";

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  result?: { tools?: Array<{ name: string }>; serverInfo?: { name: string } };
  [key: string]: unknown;
}

interface SpawnedServer {
  child: ChildProcess;
  /** Raw stdout lines, in order — used for the stdout-purity proof. */
  stdoutLines: string[];
  stderrText: () => string;
  send: (message: unknown) => void;
  waitFor: (matches: (message: JsonRpcMessage) => boolean, timeoutMs?: number) => Promise<JsonRpcMessage>;
  onceExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Spawns the real entrypoint with a temp cwd so the human's real `.env` (if
 * any) is never read; all configuration comes from explicit dummy variables.
 */
function spawnServer(extraEnv: Record<string, string>): SpawnedServer {
  const { EXCALIDRAW_ENV_FILE: _dropped, ...rest } = process.env;
  const child = spawn(process.execPath, [serverPath], {
    cwd: mkdtempSync(join(tmpdir(), "excalidraw-mcp-server-test-")),
    env: { ...rest, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutLines: string[] = [];
  const parsed: JsonRpcMessage[] = [];
  const waiters: Array<{ matches: (message: JsonRpcMessage) => boolean; resolve: (message: JsonRpcMessage) => void }> = [];
  let stdoutBuffer = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line !== "") {
        stdoutLines.push(line);
        try {
          const message = JSON.parse(line) as JsonRpcMessage;
          parsed.push(message);
          const waiterIndex = waiters.findIndex((waiter) => waiter.matches(message));
          if (waiterIndex >= 0) {
            const [waiter] = waiters.splice(waiterIndex, 1);
            waiter?.resolve(message);
          }
        } catch {
          // Left unparsed on purpose: the purity assertions below fail loudly
          // if any stdout line is not JSON-RPC.
        }
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    child,
    stdoutLines,
    stderrText: () => stderr,
    send: (message: unknown) => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    waitFor: (matches, timeoutMs = 20000) =>
      new Promise((resolve, reject) => {
        const already = parsed.find(matches);
        if (already) {
          resolve(already);
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for a matching message; stderr so far: ${stderr}`));
        }, timeoutMs);
        waiters.push({
          matches: (message) => {
            if (!matches(message)) return false;
            clearTimeout(timer);
            return true;
          },
          resolve,
        });
      }),
    onceExit: async () => {
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
        child.once("exit", (code, signal) => resolve([code, signal]));
      });
      return { code, signal };
    },
  };
}

function initializeAndListTools(spawned: SpawnedServer): Promise<JsonRpcMessage> {
  spawned.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "server-test", version: "0.0.0" },
    },
  });
  return spawned.waitFor((message) => message.id === 1 && message.result !== undefined);
}

describe("MCP stdio server (real child process)", () => {
  it("answers initialize + tools/list with the four tools, stdout stays pure JSON-RPC", async () => {
    const spawned = spawnServer({ EXCALIDRAW_USERNAME: DUMMY_USER, EXCALIDRAW_PASSWORD: DUMMY_PASSWORD });
    try {
      const init = await initializeAndListTools(spawned);
      assert.equal(init.result?.serverInfo?.name, "excalidraw-mcp");
      spawned.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      spawned.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const list = await spawned.waitFor((message) => message.id === 2 && message.result !== undefined);
      const toolNames = (list.result?.tools ?? []).map((tool) => tool.name).sort();
      assert.deepEqual(toolNames, ["create_diagram", "delete_diagram", "get_diagram", "list_diagrams"]);

      // stdout-purity proof: every single line the child wrote to stdout must
      // parse as JSON-RPC 2.0 — one stray line would corrupt the session.
      assert.ok(spawned.stdoutLines.length >= 2, "the child must have written the two responses");
      for (const line of spawned.stdoutLines) {
        const message = JSON.parse(line) as JsonRpcMessage;
        assert.equal(message.jsonrpc, "2.0", `stdout line is not JSON-RPC: ${JSON.stringify(line)}`);
      }
      // Startup must not touch the network: tools/list already succeeded with
      // no Excalidraw server running.
      assert.ok(!spawned.stderrText().toLowerCase().includes("econnrefused"), "no connection attempt at startup");
    } finally {
      // Clean shutdown through the portable path: closing stdin ends the
      // JSON-RPC channel and the server must exit 0.
      spawned.child.stdin?.end();
    }
    const { code } = await spawned.onceExit();
    assert.equal(code, 0, "closing stdin must lead to a clean exit 0");
  });

  it("shuts down cleanly on SIGTERM", async () => {
    const spawned = spawnServer({ EXCALIDRAW_USERNAME: DUMMY_USER, EXCALIDRAW_PASSWORD: DUMMY_PASSWORD });
    await initializeAndListTools(spawned);
    spawned.child.kill("SIGTERM");
    const { code, signal } = await spawned.onceExit();
    if (process.platform === "win32") {
      // Windows cannot deliver SIGTERM to a handler: the OS terminates the
      // process unconditionally and reports the signal instead of a code.
      // The portable clean-shutdown proof is the stdin-end test above.
      assert.equal(signal, "SIGTERM");
      assert.equal(code, null);
    } else {
      assert.equal(code, 0);
      assert.equal(signal, null);
    }
  });

  it("exits 78 with an actionable stderr line when EXCALIDRAW_USERNAME is missing", async () => {
    const spawned = spawnServer({ EXCALIDRAW_PASSWORD: DUMMY_PASSWORD });
    const { code } = await spawned.onceExit();
    assert.equal(code, INVALID_CONFIG_EXIT_CODE);
    const stderr = spawned.stderrText();
    assert.match(stderr, /EXCALIDRAW_USERNAME/, "the stderr line must name the missing variable");
    assert.ok(!stderr.includes(DUMMY_PASSWORD), "the stderr line must never contain the password");
    assert.deepEqual(spawned.stdoutLines, [], "a config failure must never write to stdout");
  });
});

describe("stdout purity guard", () => {
  it("redirects console.log/info/debug to stderr and writes nothing to stdout", () => {
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const fakeConsole = {
      log: (...args: unknown[]) => stdoutWrites.push(args.join(" ")),
      info: (...args: unknown[]) => stdoutWrites.push(args.join(" ")),
      debug: (...args: unknown[]) => stdoutWrites.push(args.join(" ")),
      error: (...args: unknown[]) => stderrWrites.push(args.join(" ")),
    } as unknown as Console;

    guardStdout(fakeConsole);
    fakeConsole.log("x");
    fakeConsole.info("info-y");
    fakeConsole.debug("debug-z");

    assert.deepEqual(stdoutWrites, [], "the guard must let nothing reach stdout");
    const errText = stderrWrites.join("\n");
    assert.match(errText, /x/);
    assert.match(errText, /info-y/);
    assert.match(errText, /debug-z/);
  });
});
