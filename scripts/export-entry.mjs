/**
 * Bundle entry for the Excalidraw PNG exporter.
 *
 * `exportToBlob` needs a real browser environment (canvas, fonts), so it is
 * bundled as an IIFE with the global name `Ex` and evaluated inside a headless
 * Chromium page (see `src/render/png.ts`). Bundling with esbuild inlines the
 * JSON and React dependencies exactly like the Vite browser build does.
 *
 * Built by `npm run build:export` into `dist/vendor/excalidraw-export.js`.
 * IMPORTANT: never import this bundle from Node — it is browser-only.
 */
export { exportToBlob } from "@excalidraw/excalidraw";
