/**
 * Configuration loading for the Excalidraw MCP server.
 *
 * Variables are read from a plain record (defaulting to `process.env`), so the
 * logic stays testable without touching the real environment.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

export interface ExcalidrawConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
}

/** Thrown when a required variable is missing or a value is invalid. */
export class ConfigError extends Error {
  /** Name of the offending environment variable. */
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

const DEFAULT_BASE_URL = "http://localhost:3030";
const DEFAULT_TIMEOUT_MS = 30000;

function readString(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key];
  return value === undefined ? undefined : value.trim();
}

/**
 * Loads and validates the Excalidraw connection configuration.
 *
 * - `EXCALIDRAW_BASE_URL`: optional, defaults to `http://localhost:3030`,
 *   trailing slashes are trimmed.
 * - `EXCALIDRAW_USERNAME`: required, trimmed; an empty (or whitespace-only)
 *   value counts as missing.
 * - `EXCALIDRAW_PASSWORD`: required, NOT trimmed (whitespace may be meaningful)
 *   and never logged anywhere; an empty string counts as missing.
 * - `EXCALIDRAW_TIMEOUT_MS`: optional, defaults to `30000`; must be a positive
 *   integer.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): ExcalidrawConfig {
  const rawBaseUrl = readString(env, "EXCALIDRAW_BASE_URL");
  let baseUrl = rawBaseUrl === undefined || rawBaseUrl === "" ? DEFAULT_BASE_URL : rawBaseUrl;
  baseUrl = baseUrl.replace(/\/+$/, "");
  if (baseUrl === "") {
    throw new ConfigError(
      "EXCALIDRAW_BASE_URL",
      "EXCALIDRAW_BASE_URL must be a non-empty URL",
    );
  }

  const username = readString(env, "EXCALIDRAW_USERNAME");
  if (username === undefined || username === "") {
    throw new ConfigError(
      "EXCALIDRAW_USERNAME",
      "EXCALIDRAW_USERNAME is required (empty values count as missing)",
    );
  }

  const password = env["EXCALIDRAW_PASSWORD"];
  if (password === undefined || password === "") {
    throw new ConfigError(
      "EXCALIDRAW_PASSWORD",
      "EXCALIDRAW_PASSWORD is required (empty values count as missing)",
    );
  }

  const rawTimeoutMs = readString(env, "EXCALIDRAW_TIMEOUT_MS");
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeoutMs !== undefined && rawTimeoutMs !== "") {
    if (!/^\d+$/.test(rawTimeoutMs) || !Number.isSafeInteger(Number(rawTimeoutMs)) || Number(rawTimeoutMs) <= 0) {
      throw new ConfigError(
        "EXCALIDRAW_TIMEOUT_MS",
        "EXCALIDRAW_TIMEOUT_MS must be a positive integer (milliseconds)",
      );
    }
    timeoutMs = Number(rawTimeoutMs);
  }

  return { baseUrl, username, password, timeoutMs };
}

/**
 * Renders a safe diagnostic string for the configuration. It reveals
 * `baseUrl`, `username` and `timeoutMs`, and for the password only whether a
 * value is present — never the value itself, so this is safe to log (to
 * stderr) from the server.
 */
export function describeConfig(config: ExcalidrawConfig): string {
  const passwordState = config.password === "" ? "absent" : "present";
  return (
    `ExcalidrawConfig(baseUrl=${config.baseUrl}, username=${config.username}, ` +
    `timeoutMs=${config.timeoutMs}, password=${passwordState})`
  );
}

/**
 * Loads a dotenv file from an explicit path, or from `<repository root>/.env`
 * (the current working directory) when no path is given, and returns the
 * parsed `KEY=VALUE` pairs. Parsing is delegated to the real `dotenv`
 * dependency (`dotenv.parse`), so quoting and `KEY=a=b=c` values follow
 * dotenv's documented semantics.
 *
 * This function never throws when the file is absent: a missing `.env` is a
 * normal setup (the human may rely on real environment variables instead), so
 * it simply returns an empty record in that case. It is pure with respect to
 * `process.env` — loading a file never injects values into the environment;
 * the caller decides what to do with the returned record.
 */
export function loadEnvFile(filePath?: string): Record<string, string> {
  const path = filePath ?? resolve(process.cwd(), ".env");
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    // Absent (or unreadable) env file: not an error, per the contract above.
    return {};
  }
  return dotenv.parse(content);
}
