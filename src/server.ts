#!/usr/bin/env node
/**
 * MCP stdio entrypoint for the excalidraw-mcp server.
 *
 * Launchable by an agent host as a local MCP server (`bin`/`start` map to
 * `dist/server.js`). Wiring lives in `runServer` (testable without spawning),
 * and `guardStdout` is exported for its own test.
 *
 * Configuration: the environment file is resolved in this order —
 * `EXCALIDRAW_ENV_FILE` when set, otherwise `.env` in the current working
 * directory. A missing file is not an error, and real environment variables
 * win over file values (`loadEnvFile` never overwrites). Then `loadConfig`.
 *
 * Startup never touches the network: the client only closes over the
 * configuration and the login happens lazily on the first tool call, so
 * `tools/list` works with no Excalidraw server running.
 *
 * EXIT CODES (documented choice): 0 on a clean shutdown (stdin end, SIGINT or
 * SIGTERM); 78 — sysexits `EX_CONFIG`, "configuration error" — when the
 * configuration is invalid. 78 is deliberately not 0 or 1 so a supervisor can
 * distinguish "bad config, do not retry" from a generic crash.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createExcalidrawClient } from "./api/client.ts";
import { ConfigError, describeConfig, loadConfig, loadEnvFile } from "./config.ts";
import { mermaidToScene } from "./scene/mermaid.ts";
import { registerDiagramTools } from "./tools/register.ts";

/** Sysexits `EX_CONFIG`: invalid configuration. Documented above. */
export const INVALID_CONFIG_EXIT_CODE = 78;

/** Minimal console surface the guard needs; injectable for tests. */
export type WritableConsole = Pick<Console, "log" | "info" | "debug" | "error">;

/**
 * STDOUT PURITY GUARD. stdout is the MCP JSON-RPC channel: a single stray
 * line (a debug print, a library banner) corrupts the whole session, so every
 * `console.log` / `console.info` / `console.debug` call made by this process
 * — including by libraries — is redirected to stderr. stderr stays fully
 * visible: diagnostics remain available. The entrypoint installs this before
 * anything else in the process can write.
 */
export function guardStdout(target: WritableConsole = console): void {
  const toStderr = target.error.bind(target);
  const redirect = (...args: unknown[]): void => {
    toStderr(...args);
  };
  target.log = redirect;
  target.info = redirect;
  target.debug = redirect;
}

export interface RunServerOptions {
  /** Environment record to read and fill from the env file (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Working directory used to resolve the fallback `.env` (default `process.cwd()`). */
  cwd?: string;
}

/**
 * Builds the full server wiring: env file → config → client → McpServer with
 * the four registered tools → StdioServerTransport, plus graceful shutdown.
 * Throws only on unexpected (non-config) failures; invalid configuration
 * prints one actionable stderr line and exits `INVALID_CONFIG_EXIT_CODE`.
 */
export async function runServer({ env = process.env, cwd = process.cwd() }: RunServerOptions = {}): Promise<void> {
  // Environment file: EXCALIDRAW_ENV_FILE wins, else <cwd>/.env. Missing file
  // is not an error. File values fill only the gaps: real environment
  // variables win over file values. `loadEnvFile` itself is pure (T3), so the
  // merge happens here.
  const envFile = env["EXCALIDRAW_ENV_FILE"] ?? resolve(cwd, ".env");
  const fileValues = loadEnvFile(envFile);
  for (const [key, value] of Object.entries(fileValues)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }

  let config;
  try {
    config = loadConfig(env);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      // One actionable line, naming the variable; never the password.
      process.stderr.write(
        `[excalidraw-mcp] invalid configuration: ${error.message}. ` +
          "Fix: set the missing variable (see env.example) and restart.\n",
      );
      process.exit(INVALID_CONFIG_EXIT_CODE);
    }
    throw error;
  }

  // No network here: createExcalidrawClient only closes over the config.
  const client = createExcalidrawClient(config);
  const server = new McpServer({ name: "excalidraw-mcp", version: "0.1.0" });
  registerDiagramTools(server, { client, mermaidToScene });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // describeConfig never includes the password (only its presence).
  process.stderr.write(`[excalidraw-mcp] listening on stdio; config: ${describeConfig(config)}\n`);

  let shuttingDown = false;
  const shutdown = (exitCode: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void server
      .close()
      .catch(() => undefined)
      .then(() => process.exit(exitCode));
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  // The JSON-RPC channel ended (parent closed stdin): clean shutdown. This is
  // the portable path — Windows cannot deliver SIGTERM to a handler.
  process.stdin.on("end", () => shutdown(0));
}

/** True when this module is the process entrypoint (as opposed to being imported). */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  // Installed first, before anything else in this process can write to stdout.
  guardStdout();
  void runServer();
}
