import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/e2e.mjs", import.meta.url));

/**
 * Runs the end-to-end script as a child process. The child must exit 0 and
 * every step of its JSON report must be ok. EXCALIDRAW_* variables are
 * stripped so the script always runs in stub mode (a real deployment is never
 * touched from the test suite), and no real `.env` is involved.
 */
describe("end-to-end script", () => {
  it("exercises the full stack against the stub and reports every step ok", async () => {
    const {
      EXCALIDRAW_BASE_URL: _base,
      EXCALIDRAW_USERNAME: _user,
      EXCALIDRAW_PASSWORD: _pass,
      EXCALIDRAW_ENV_FILE: _envFile,
      EXCALIDRAW_TIMEOUT_MS: _timeout,
      ...restEnv
    } = process.env;

    const child = spawn(process.execPath, [scriptPath], {
      env: restEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // A spawn failure (e.g. missing script) surfaces on "error", not "exit".
    const failure = new Promise<never>((_, reject) => {
      child.once("error", (error) => reject(new Error(`child failed to start: ${error.message}`)));
    });
    const exit = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });
    const code = await Promise.race([exit, failure]);

    assert.equal(code, 0, `script exited ${code}; stderr: ${stderr}`);
    const report = JSON.parse(stdout) as {
      mode: string;
      steps: Array<{ name: string; ok: boolean; skipped?: boolean; evidence: unknown }>;
      summary: { total: number; passed: number; failed: number; skipped: number };
    };
    assert.equal(report.mode, "stub");
    assert.ok(report.steps.length >= 10, `expected at least 10 steps, got ${report.steps.length}`);
    for (const step of report.steps) {
      assert.equal(
        step.ok,
        true,
        `step "${step.name}" failed: ${JSON.stringify(step.evidence)}`,
      );
    }
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.passed, report.steps.length);
  });
});
