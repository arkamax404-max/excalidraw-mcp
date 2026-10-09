/**
 * Tests for the PNG renderer.
 *
 * The integration cases need a Chromium; when none can be resolved they skip
 * with the reason recorded rather than passing silently, because a green suite
 * that never rendered anything would be a false signal about the one thing
 * this module exists to do.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { BrowserResolutionError, closeSharedBrowser, resolveChromiumExecutable } from "./browser.ts";
import { exportBundleCandidates, renderSceneToPng, RenderError } from "./png.ts";
import { mermaidToScene } from "../scene/mermaid.ts";

const BRANCHING = `flowchart TD
  INI["Inicio"] --> A["fecha_ref"]
  INI --> B["recordata_v3"]
  B --> C["asociados"]
  B --> D["principales"]
  A --> E["Ruta 1"]
  D --> E
  E --> F["UNION"]
`;

let skipReason: string | undefined;
try {
  resolveChromiumExecutable();
} catch (error) {
  skipReason =
    error instanceof BrowserResolutionError
      ? `no Chromium available: ${String(error.message).split("\n")[0]}`
      : `browser resolution failed: ${String(error)}`;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The shared browser keeps the test process alive, and node:test waits for its
// children to exit: without this the whole suite hangs instead of finishing.
after(async () => {
  await closeSharedBrowser();
});

describe("export bundle location", () => {
  it("looks in the shipped and the development layouts", () => {
    const candidates = exportBundleCandidates();
    assert.equal(candidates.length, 2);
    for (const candidate of candidates) {
      assert.match(candidate, /excalidraw-export\.js$/);
    }
  });
});

describe("renderSceneToPng", () => {
  it("refuses a scene with no elements", async () => {
    await assert.rejects(() => renderSceneToPng({ elements: [] }), RenderError);
  });

  it(
    "renders a branching flowchart to a real PNG",
    { skip: skipReason },
    async () => {
      const scene = (await mermaidToScene(BRANCHING)).scene;
      const rendered = await renderSceneToPng(scene);

      assert.ok(rendered.png.subarray(0, 8).equals(PNG_MAGIC), "the result must start with the PNG signature");
      assert.ok(rendered.png.byteLength > 5000, `expected a real image, got ${rendered.png.byteLength} bytes`);
      assert.ok(rendered.width > 100 && rendered.height > 100, `unexpected size ${rendered.width}x${rendered.height}`);
      assert.ok(rendered.elapsedMs > 0);
      assert.equal(rendered.scaledDown, false);
      assert.equal(rendered.scaleUsed, 1);

      // A second render must reuse the shared browser rather than fail or leak.
      const again = await renderSceneToPng(scene);
      assert.ok(again.png.byteLength > 5000);
    },
  );

  it(
    "downscales when the result would exceed maxWidth",
    { skip: skipReason },
    async () => {
      const scene = (await mermaidToScene(BRANCHING)).scene;
      const full = await renderSceneToPng(scene);
      const limit = Math.max(200, Math.round(Math.max(full.width, full.height) / 2));
      const limited = await renderSceneToPng(scene, { maxWidth: limit });

      assert.equal(limited.scaledDown, true, "the limit must be reported as applied");
      assert.ok(
        Math.max(limited.width, limited.height) <= limit,
        `${limited.width}x${limited.height} should have its longest side within ${limit}`,
      );
      assert.ok(limited.height < full.height, "the limited render must be smaller");
      assert.equal(limited.scaleUsed, 1, "the raster scale stays as requested");
    },
  );

  it(
    "applies a requested scale as an explicit raster resample",
    { skip: skipReason },
    async () => {
      const scene = (await mermaidToScene(BRANCHING)).scene;
      const natural = await renderSceneToPng(scene);
      const doubled = await renderSceneToPng(scene, { scale: 2 });

      assert.equal(doubled.scaleUsed, 2);
      assert.equal(doubled.scaledDown, false);
      assert.ok(
        Math.abs(doubled.width - natural.width * 2) <= 2 && Math.abs(doubled.height - natural.height * 2) <= 2,
        `expected about ${natural.width * 2}x${natural.height * 2}, got ${doubled.width}x${doubled.height}`,
      );
    },
  );
});
