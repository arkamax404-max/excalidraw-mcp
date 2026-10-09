import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { BrowserResolutionError, resolveChromiumExecutable } from "./browser.ts";

/**
 * Unit tests for the Chromium executable resolution order (fast, hermetic):
 * the real search runs against a fake directory tree under the system temp
 * directory; Playwright's own resolution is injected so no real browser
 * launch happens here.
 */

const cleanupDirs: string[] = [];

function makeFakeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "excalidraw-mcp-chromium-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function fakeExe(dir: string, relative: string): string {
  const exe = join(dir, relative);
  mkdirSync(join(exe, ".."), { recursive: true });
  writeFileSync(exe, "not a real browser");
  return exe;
}

afterEach(() => {
  // The fake trees are left in place; the OS temp directory is cleaned by the
  // system, and deleting here would risk removing something it should not.
});

describe("resolveChromiumExecutable", () => {
  it("prefers EXCALIDRAW_MCP_CHROMIUM when it is set and exists", () => {
    const tree = makeFakeTree();
    const exe = fakeExe(tree, join("custom", "chrome.exe"));
    const resolved = resolveChromiumExecutable({
      env: { EXCALIDRAW_MCP_CHROMIUM: exe },
      searchRoots: [tree],
    });
    assert.equal(resolved, exe);
  });

  it("throws a typed error when EXCALIDRAW_MCP_CHROMIUM is set but missing", () => {
    const tree = makeFakeTree();
    const missing = join(tree, "nowhere", "chrome.exe");
    assert.throws(
      () =>
        resolveChromiumExecutable({
          env: { EXCALIDRAW_MCP_CHROMIUM: missing },
          searchRoots: [tree],
        }),
      (error: unknown) => {
        if (!(error instanceof BrowserResolutionError)) return false;
        assert.match(error.message, /EXCALIDRAW_MCP_CHROMIUM/);
        assert.match(error.message, /chrome\.exe|chromium/i);
        return true;
      },
    );
  });

  it("uses Playwright's own resolution when that file exists", () => {
    const tree = makeFakeTree();
    const exe = fakeExe(tree, join("pw", "chrome.exe"));
    const resolved = resolveChromiumExecutable({
      env: {},
      playwrightExecutable: exe,
      searchRoots: [tree],
    });
    assert.equal(resolved, exe);
  });

  it("ignores Playwright's resolution when missing and falls back to the search", () => {
    const tree = makeFakeTree();
    const exe = fakeExe(
      tree,
      join("chromium_headless_shell-1243", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
    );
    const resolved = resolveChromiumExecutable({
      env: {},
      playwrightExecutable: join(tree, "chromium-1248", "chrome-win64", "chrome.exe"),
      searchRoots: [tree],
    });
    assert.equal(resolved, exe);
  });

  it("prefers the newest build, and headless shells over full Chromium", () => {
    const tree = makeFakeTree();
    const old = fakeExe(
      tree,
      join("chromium_headless_shell-1241", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
    );
    const newest = fakeExe(
      tree,
      join("chromium_headless_shell-1243", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
    );
    fakeExe(tree, join("chromium-1245", "chrome-win64", "chrome.exe"));
    const resolved = resolveChromiumExecutable({ env: {}, searchRoots: [tree] });
    assert.equal(resolved, newest);
    assert.notEqual(resolved, old);
  });

  it("falls back to a full Chromium install when no headless shell exists", () => {
    const tree = makeFakeTree();
    const full = fakeExe(tree, join("chromium-1243", "chrome-win64", "chrome.exe"));
    const resolved = resolveChromiumExecutable({ env: {}, searchRoots: [tree] });
    assert.equal(resolved, full);
  });

  it("throws an actionable error listing the searched paths when nothing is found", () => {
    const tree = makeFakeTree();
    assert.throws(
      () => resolveChromiumExecutable({ env: {}, searchRoots: [tree] }),
      (error: unknown) => {
        if (!(error instanceof BrowserResolutionError)) return false;
        assert.match(error.message, /npx playwright install chromium/);
        assert.match(error.message, /chromium_headless_shell/);
        return true;
      },
    );
  });
});
