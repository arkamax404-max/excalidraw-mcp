/**
 * PNG rendering of an Excalidraw scene, so an agent can look at what it built.
 *
 * This is the only place in the project that renders pixels. It uses
 * Excalidraw's own `exportToBlob` inside a headless Chromium, because that is
 * the only path that produces real Excalifont text metrics: a jsdom shim can
 * measure approximately, but not faithfully. The measured recipe:
 *
 * 1. esbuild bundles `exportToBlob` from `@excalidraw/excalidraw` as an IIFE
 *    with the global `Ex` (`npm run build:export`, about 14.5 MB).
 * 2. `window.EXCALIDRAW_ASSET_PATH` is pointed at the package's local
 *    `dist/prod/` directory so the Excalifont files resolve without a CDN.
 * 3. `exportToBlob` is called with a white background.
 *
 * Two measured facts shape the options, because the obvious API does not work:
 * `appState.exportScale` is **ignored** by this version, so the natural size is
 * the size the scene asks for; `maxWidthOrHeight` **is** honoured and shrinks
 * the export while keeping its aspect ratio. A requested `scale` is therefore
 * applied as an explicit canvas resample, which is a raster operation and is
 * documented as such.
 *
 * Rendering never writes into the repository and never mutates Excalidraw; the
 * only side effect allowed here is the PNG written to the system temp
 * directory by the caller. Every diagnostic goes through the returned value or
 * a thrown `RenderError`, never through stdout.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getSharedBrowser } from "./browser.ts";

/** Thrown when a scene cannot be rendered to PNG. */
export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface RenderSceneOptions {
  /** Raster scale applied to the export. Clamped to 0.2..4; 1 keeps the natural size. */
  scale?: number;
  /** Shrink the export so its longest side is at most this many pixels; 0 disables it. */
  maxWidth?: number;
  /** Background colour of the exported image. */
  background?: string;
}

export interface RenderSceneResult {
  png: Buffer;
  width: number;
  height: number;
  elapsedMs: number;
  /** True when `maxWidth` forced an export smaller than the natural size. */
  scaledDown: boolean;
  /** Scale actually applied as a raster resample. */
  scaleUsed: number;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const EXPORT_BUNDLE_GLOBAL = "Ex";
const EXPORT_FUNCTION_NAME = "exportToBlob";
const ASSET_SUBDIRECTORY = join("dist", "prod") + "/";

/** Directory of this module, whichever of `src/` or `dist/` it was loaded from. */
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/** Candidates for the export bundle, in the shipped and the development layouts. */
export function exportBundleCandidates(): string[] {
  return [
    join(moduleDirectory, "..", "vendor", "excalidraw-export.js"),
    join(moduleDirectory, "..", "..", "dist", "vendor", "excalidraw-export.js"),
  ];
}

function resolveExportBundle(): string {
  const found = exportBundleCandidates().find((candidate) => existsSync(candidate));
  if (found) {
    return found;
  }
  // Same self-sufficiency rule the scene tests follow for the converter bundle.
  const projectRoot = join(moduleDirectory, "..", "..");
  const built = spawnSync("npm", ["run", "build:export"], {
    cwd: projectRoot,
    stdio: "ignore",
    shell: true,
  });
  const afterBuild = exportBundleCandidates().find((candidate) => existsSync(candidate));
  if (afterBuild) {
    return afterBuild;
  }
  throw new RenderError(
    `The PNG export bundle is missing and could not be built (exit code ${built.status ?? "unknown"}). ` +
      `Fix: run \`npm run build:export\` in the project root. Looked for:\n` +
      exportBundleCandidates()
        .map((candidate) => `  - ${candidate}`)
        .join("\n"),
  );
}

/** `file://` URL of the Excalidraw assets (fonts) shipped with the package. */
function excalidrawAssetUrl(): string {
  const candidates = [
    join(moduleDirectory, "..", "..", "node_modules", "@excalidraw", "excalidraw", ASSET_SUBDIRECTORY),
    join(moduleDirectory, "..", "..", "..", "node_modules", "@excalidraw", "excalidraw", ASSET_SUBDIRECTORY),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new RenderError(
      "Could not locate @excalidraw/excalidraw's dist/prod directory, which holds the fonts the export needs. " +
        "Fix: run `npm install` in the project root.",
    );
  }
  return pathToFileURL(found).href;
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) {
    return 1;
  }
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

interface SceneLike {
  elements: unknown[];
  files?: unknown;
}

interface PageExport {
  base64: string;
  width: number;
  height: number;
}

/**
 * Renders a scene to a PNG buffer. The shared browser is reused across calls;
 * a fresh page per render keeps one scene's styles from leaking into the next.
 */
export async function renderSceneToPng(
  scene: SceneLike,
  options: RenderSceneOptions = {},
): Promise<RenderSceneResult> {
  const elements = Array.isArray(scene?.elements) ? scene.elements : [];
  if (elements.length === 0) {
    throw new RenderError("The scene has no elements, so there is nothing to render.");
  }

  const requestedScale = clampScale(options.scale ?? 1);
  const maxWidth = options.maxWidth ?? 0;
  const background = options.background ?? "#ffffff";
  const bundlePath = resolveExportBundle();
  const assetUrl = excalidrawAssetUrl();
  const started = Date.now();

  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: bundlePath });
    // The callbacks run in the browser and this project's tsconfig has no DOM
    // lib, so browser globals are reached through `globalThis`.
    await page.evaluate(
      ([url, globalName, exportName]) => {
        const globals = globalThis as unknown as Record<string, unknown>;
        globals.EXCALIDRAW_ASSET_PATH = url;
        const namespace = globals[globalName] as Record<string, unknown> | undefined;
        if (!namespace || typeof namespace[exportName] !== "function") {
          throw new Error(`the export bundle did not expose ${globalName}.${exportName}`);
        }
      },
      [assetUrl, EXPORT_BUNDLE_GLOBAL, EXPORT_FUNCTION_NAME] as const,
    );

    /**
     * One export pass. `limit` maps onto Excalidraw's `maxWidthOrHeight`, the
     * only knob this version honours; `scale` is applied afterwards as a canvas
     * resample, which is why it is a raster operation.
     */
    const render = async (limit: number, scale: number): Promise<PageExport> =>
      page.evaluate(
        async ([sc, limitValue, scaleValue, backgroundValue, globalName, exportName]) => {
          const globals = globalThis as unknown as Record<string, unknown>;
          const namespace = globals[globalName] as Record<string, unknown> | undefined;
          const exporter = namespace?.[exportName] as
            | ((input: Record<string, unknown>) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>)
            | undefined;
          if (typeof exporter !== "function") {
            throw new Error(`the export bundle did not expose ${globalName}.${exportName}`);
          }

          const exportInput: Record<string, unknown> = {
            elements: sc.elements,
            files: sc.files ?? {},
            mimeType: "image/png",
            appState: { exportBackground: true, viewBackgroundColor: backgroundValue, exportWithDarkMode: false },
          };
          if (limitValue > 0) {
            exportInput.maxWidthOrHeight = limitValue;
          }

          let blob = await exporter(exportInput);
          if (scaleValue !== 1) {
            const documentRef = globals.document as {
              createElement: (tag: string) => {
                width: number;
                height: number;
                getContext: (id: string) => {
                  imageSmoothingEnabled: boolean;
                  imageSmoothingQuality: string;
                  drawImage: (source: unknown, x: number, y: number, w: number, h: number) => void;
                } | null;
                toBlob: (callback: (result: unknown) => void, type: string) => void;
              };
            };
            const makeBitmap = globals.createImageBitmap as (
              source: unknown,
            ) => Promise<{ width: number; height: number }>;
            const source = await makeBitmap(blob);
            const canvas = documentRef.createElement("canvas");
            canvas.width = Math.max(1, Math.round(source.width * scaleValue));
            canvas.height = Math.max(1, Math.round(source.height * scaleValue));
            const context = canvas.getContext("2d");
            if (!context) {
              throw new Error("could not get a 2d context to apply the requested scale");
            }
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = "high";
            context.drawImage(source, 0, 0, canvas.width, canvas.height);
            blob = await new Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>((resolve) => {
              canvas.toBlob((result) => resolve(result as { arrayBuffer: () => Promise<ArrayBuffer> }), "image/png");
            });
          }

          const bitmap = await (globals.createImageBitmap as (source: unknown) => Promise<{ width: number; height: number }>)(blob);
          const buffer = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (let index = 0; index < buffer.length; index += 8192) {
            binary += String.fromCharCode(...buffer.subarray(index, index + 8192));
          }
          const toBase64 = globals.btoa as (value: string) => string;
          return { base64: toBase64(binary), width: bitmap.width, height: bitmap.height };
        },
        [{ elements, files: scene.files ?? {} }, limit, scale, background, EXPORT_BUNDLE_GLOBAL, EXPORT_FUNCTION_NAME] as const,
      );

    let rendered = await render(0, requestedScale);
    let scaledDown = false;

    // `maxWidthOrHeight` limits the longest side, so compare against that.
    if (maxWidth > 0 && Math.max(rendered.width, rendered.height) > maxWidth) {
      rendered = await render(maxWidth, requestedScale);
      scaledDown = true;
    }

    return {
      png: Buffer.from(rendered.base64, "base64"),
      width: rendered.width,
      height: rendered.height,
      elapsedMs: Date.now() - started,
      scaledDown,
      scaleUsed: requestedScale,
    };
  } catch (error) {
    if (error instanceof RenderError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new RenderError(`Could not render the scene to PNG: ${message}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Writes a rendered PNG under the system temp directory and returns its path. */
export async function writePngToTempDirectory(fileName: string, png: Buffer): Promise<string> {
  const directory = join(tmpdir(), "excalidraw-mcp-render");
  await mkdir(directory, { recursive: true });
  const safeName =
    fileName
      .replace(/[^\w.-]+/g, "-")
      .slice(0, 80)
      .replace(/^-+|-+$/g, "") || "diagrama";
  const path = join(directory, `${safeName}.png`);
  await writeFile(path, png);
  return path;
}
