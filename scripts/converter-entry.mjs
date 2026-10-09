/**
 * Bundle entry for the Excalidraw element converter.
 *
 * `@excalidraw/excalidraw` cannot be imported as ESM under Node: its dist imports
 * `open-color.json` without the `type: "json"` import attribute that modern Node
 * requires, and its `exports` map blocks deep runtime paths. Bundling it with
 * esbuild inlines that JSON, exactly like the Vite browser build does.
 *
 * Built by `npm run build:converter` into `dist/vendor/excalidraw-converter.mjs`.
 */
export { convertToExcalidrawElements } from "@excalidraw/excalidraw";
