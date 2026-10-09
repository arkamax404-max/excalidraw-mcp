/**
 * Chromium resolution and shared-browser lifecycle for the PNG renderer.
 *
 * Playwright 1.64 expects Chromium build 1248, but an existing install often
 * has a different build (e.g. 1243) under `%LOCALAPPDATA%/ms-playwright`, and
 * `chromium.launch()` without an explicit `executablePath` then fails with
 * "Executable doesn't exist". Resolution order (first hit wins):
 *
 * 1. the `EXCALIDRAW_MCP_CHROMIUM` environment variable, when it names an
 *    existing file;
 * 2. Playwright's own resolution (`chromium.executablePath()`), when that file
 *    exists;
 * 3. a search of the Playwright browsers directory for a `chromium_headless_shell-<build>`
 *    directory holding `chrome-headless-shell-win64/chrome-headless-shell.exe`, then a
 *    `chromium-<build>` directory holding `chrome-win64/chrome.exe`, preferring the
 *    newest build.
 *
 * When nothing is found, a typed, actionable error is thrown listing the
 * paths that were looked for and how to install a browser. See
 * `odd/notes/mermaid-node-spike.md` for the measured background.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Browser } from "playwright";
import { chromium } from "playwright";

/** Thrown when no usable Chromium executable can be resolved. */
export class BrowserResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

const HEADLESS_SHELL_PREFIX = "chromium_headless_shell-";
const HEADLESS_SHELL_RELATIVE = join("chrome-headless-shell-win64", "chrome-headless-shell.exe");
const FULL_CHROMIUM_PREFIX = "chromium-";
const FULL_CHROMIUM_RELATIVE = join("chrome-win64", "chrome.exe");

export interface ResolveChromiumOptions {
  /** Environment to read `EXCALIDRAW_MCP_CHROMIUM` from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Playwright's own candidate; defaults to `chromium.executablePath()`. */
  playwrightExecutable?: string | null;
  /** Directories searched for installed browsers; defaults to the Playwright browsers dir. */
  searchRoots?: readonly string[];
}

function defaultSearchRoots(): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  return localAppData ? [join(localAppData, "ms-playwright")] : [];
}

/** Extracts the numeric build from a directory name like `chromium-1243`. */
function buildNumber(directoryName: string): number {
  const match = directoryName.match(/-(\d+)$/);
  return match ? Number(match[1]) : -1;
}

/** Finds the newest `prefix<number>` directory under `root` holding `relative`. */
function findNewestBrowser(root: string, prefix: string, relative: string): string | undefined {
  if (!existsSync(root)) {
    return undefined;
  }
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  for (const name of entries.sort((a, b) => buildNumber(b) - buildNumber(a))) {
    const candidate = join(root, name, relative);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolves a usable Chromium executable. See the module docs for the order.
 * Pure with respect to the filesystem: no browser is launched.
 */
export function resolveChromiumExecutable(options: ResolveChromiumOptions = {}): string {
  const env = options.env ?? process.env;

  const fromEnv = env.EXCALIDRAW_MCP_CHROMIUM;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    if (existsSync(fromEnv)) {
      return fromEnv;
    }
    throw new BrowserResolutionError(
      `EXCALIDRAW_MCP_CHROMIUM is set to "${fromEnv}" but that file does not exist. ` +
        `Fix the environment variable to point at a Chromium or chrome-headless-shell executable, or unset it.`,
    );
  }

  const fromPlaywright = options.playwrightExecutable ?? chromium.executablePath();
  if (typeof fromPlaywright === "string" && fromPlaywright !== "" && existsSync(fromPlaywright)) {
    return fromPlaywright;
  }

  const searchRoots = options.searchRoots ?? defaultSearchRoots();
  const searched: string[] = [];
  for (const root of searchRoots) {
    for (const [prefix, relative] of [
      [HEADLESS_SHELL_PREFIX, HEADLESS_SHELL_RELATIVE],
      [FULL_CHROMIUM_PREFIX, FULL_CHROMIUM_RELATIVE],
    ] as const) {
      const found = findNewestBrowser(root, prefix, relative);
      if (found) {
        return found;
      }
      searched.push(join(root, prefix, relative));
    }
  }

  throw new BrowserResolutionError(
    "No Chromium executable found for the PNG renderer. Looked for:\n" +
      searched.map((path) => `  - ${path}`).join("\n") +
      "\nFix: run `npx playwright install chromium`, or set EXCALIDRAW_MCP_CHROMIUM " +
      "to the full path of an existing Chromium/chrome-headless-shell executable.",
  );
}

// ---------------------------------------------------------------------------
// Shared browser lifecycle: one browser and one page, created lazily, reused
// across renders, closed on process exit.
// ---------------------------------------------------------------------------

let sharedBrowser: Browser | undefined;
let sharedBrowserPromise: Promise<Browser> | undefined;

async function launchSharedBrowser(): Promise<Browser> {
  const executablePath = resolveChromiumExecutable();
  const browser = await chromium.launch({ executablePath });
  sharedBrowser = browser;
  installExitHook();
  return browser;
}

/** Lazily launches the shared headless Chromium; consecutive calls reuse it. */
export function getSharedBrowser(): Promise<Browser> {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = launchSharedBrowser().catch((error: unknown) => {
      // Allow a retry after a failed launch (e.g. browser disappeared).
      sharedBrowserPromise = undefined;
      throw error;
    });
  }
  return sharedBrowserPromise;
}

/** Closes the shared browser if it is running; safe to call more than once. */
export async function closeSharedBrowser(): Promise<void> {
  const browser = sharedBrowser;
  sharedBrowser = undefined;
  sharedBrowserPromise = undefined;
  if (browser) {
    try {
      await browser.close();
    } catch {
      // Already closed or crashed; nothing else to do.
    }
  }
}

// Best-effort cleanup on process exit: close() is async and cannot be awaited
// in an "exit" handler, so the child process is killed synchronously instead.
// Install the hook only once, lazily, when a browser is actually launched.
let exitHookInstalled = false;

/**
 * The child-process accessor exists at runtime but is not on Playwright's
 * public `Browser` type; probe it structurally instead of casting blindly.
 */
function childProcessOf(browser: Browser): { kill: (signal?: string) => unknown } | undefined {
  const candidate = (browser as { process?: unknown }).process;
  if (typeof candidate !== "function") {
    return undefined;
  }
  const child = (candidate as () => unknown).call(browser);
  if (child && typeof (child as { kill?: unknown }).kill === "function") {
    return child as { kill: (signal?: string) => unknown };
  }
  return undefined;
}

function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.once("exit", () => {
    const browser = sharedBrowser;
    if (!browser) {
      return;
    }
    try {
      childProcessOf(browser)?.kill("SIGKILL");
    } catch {
      // Best effort only; the process is exiting anyway.
    }
  });
}
