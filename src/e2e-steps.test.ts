import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpApiError, RateLimitError, TransportError } from "./api/errors.ts";

// Dynamic (computed) import: the e2e script is plain JavaScript without type
// declarations, and a computed specifier keeps the module side-effect free
// while still letting node:test load it for these unit tests.
const scriptModule = (await import(new URL("../scripts/e2e.mjs", import.meta.url).href)) as {
  classifyForkAiError: (error: unknown) => { skipped: boolean; reason?: unknown };
  classifyForkAiResult: (
    result: unknown,
    mode: { realDeployment: boolean },
  ) => { ok: boolean; reason?: string };
};
const { classifyForkAiError, classifyForkAiResult } = scriptModule;

/**
 * Focused unit tests for the `create-fork-ai` step classification in
 * `scripts/e2e.mjs`. The script only runs its end-to-end flow when invoked as
 * the main module, so importing it here is side-effect free. No real provider
 * is involved: these tests classify canned results and typed errors.
 */
describe("e2e fork-ai step classification", () => {
  describe("classifyForkAiResult", () => {
    it("stub mode accepts exactly the canned provider and model", () => {
      assert.deepEqual(classifyForkAiResult({ provider: "stub", model: "stub-1" }, { realDeployment: false }), {
        ok: true,
      });
      assert.equal(classifyForkAiResult({ provider: "openrouter", model: "stub-1" }, { realDeployment: false }).ok, false);
      assert.equal(classifyForkAiResult({ provider: "stub", model: "openrouter/free" }, { realDeployment: false }).ok, false);
    });

    it("real mode accepts a non-stub provider, model and positive element count", () => {
      assert.deepEqual(
        classifyForkAiResult({ provider: "openrouter", model: "openrouter/free", elementCount: 11 }, { realDeployment: true }),
        { ok: true },
      );
    });

    it("real mode rejects empty or missing provider/model", () => {
      for (const bad of [
        { provider: "", model: "openrouter/free", elementCount: 3 },
        { model: "openrouter/free", elementCount: 3 },
        { provider: "openrouter", model: "", elementCount: 3 },
        { provider: "openrouter", elementCount: 3 },
        { provider: 42, model: "openrouter/free", elementCount: 3 },
      ]) {
        const verdict = classifyForkAiResult(bad, { realDeployment: true });
        assert.equal(verdict.ok, false, `expected rejection of ${JSON.stringify(bad)}`);
        assert.equal(typeof verdict.reason, "string");
      }
    });

    it("real mode rejects the stub values leaking into a real deployment", () => {
      assert.equal(
        classifyForkAiResult({ provider: "stub", model: "stub-1", elementCount: 5 }, { realDeployment: true }).ok,
        false,
      );
    });

    it("real mode rejects a non-positive or missing element count", () => {
      for (const elementCount of [0, -1, 2.5, undefined, "3"]) {
        const verdict = classifyForkAiResult({ provider: "openrouter", model: "openrouter/free", elementCount }, { realDeployment: true });
        assert.equal(verdict.ok, false, `expected rejection of elementCount ${JSON.stringify(elementCount)}`);
      }
    });
  });

  describe("classifyForkAiError", () => {
    it("records a skip for gateway-style 502/503/504 failures", () => {
      for (const status of [502, 503, 504]) {
        const verdict = classifyForkAiError(new HttpApiError(status, "The AI provider is temporarily unavailable."));
        assert.deepEqual(verdict.skipped, true, `expected skip for status ${status}`);
        assert.match(JSON.stringify(verdict.reason), new RegExp(String(status)));
      }
    });

    it("records a skip for a typed error naming the provider configuration", () => {
      const verdict = classifyForkAiError(
        new HttpApiError(503, "AI generation is not configured on this server."),
      );
      assert.equal(verdict.skipped, true);
    });

    it("does not allow a skip for any other failure", () => {
      assert.equal(classifyForkAiError(new HttpApiError(500, "AI generation failed unexpectedly.")).skipped, false);
      assert.equal(classifyForkAiError(new RateLimitError("7", "Too many AI generation requests.")).skipped, false);
      assert.equal(classifyForkAiError(new TransportError("timeout")).skipped, false);
      assert.equal(classifyForkAiError(new Error("expected canned provider/model, got stub/stub-1")).skipped, false);
    });
  });
});
