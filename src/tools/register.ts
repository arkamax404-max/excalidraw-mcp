/**
 * MCP registration for the diagram tools.
 *
 * This module is the transport boundary: it binds the transport-free handlers
 * from `src/tools/diagram-tools.ts` onto an official
 * `@modelcontextprotocol/sdk` `McpServer`, with zod schemas (the SDK's own
 * validation stack) for tool inputs, and converts every typed error into a
 * readable tool result that tells the agent what to do differently.
 *
 * Nothing here writes to stdout; the MCP stdio transport owns stdout, so any
 * diagnostic must go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AuthenticationError,
  HttpApiError,
  NotFoundError,
  RateLimitError,
  TransportError,
} from "../api/errors.ts";
import {
  ConverterError,
  InvalidMermaidError,
  MermaidLimitError,
  MermaidParseError,
  MermaidSceneError,
} from "../scene/errors.ts";
import { RenderError } from "../render/png.ts";
import { createDiagramTools, type DiagramToolDeps, type DiagramTools } from "./diagram-tools.ts";
import { createRenderTools, type RenderDiagramResult, type RenderToolDeps, type RenderTools } from "./render-tools.ts";
import { DiagramConflictError, ToolInputError } from "./errors.ts";

/**
 * Maps a typed error onto a readable tool result. RATIONALE: the agent only
 * sees this text, so every branch states what happened AND what to do
 * differently. Password, cookie values and stack traces never appear: the
 * messages are built from fixed guidance plus the typed errors' own
 * server-provided messages (which the API layer already keeps free of
 * credentials).
 */
export function toolResultForError(error: unknown): CallToolResult {
  const text = describeError(error);
  return { content: [{ type: "text", text }], isError: true };
}

function describeError(error: unknown): string {
  if (error instanceof ToolInputError) {
    return `${error.message} Fix the input and call the tool again.`;
  }
  if (error instanceof DiagramConflictError) {
    return error.message;
  }
  if (error instanceof NotFoundError) {
    return `Diagram not found: ${error.message}. Fix: run list_diagrams to see the available diagrams.`;
  }
  if (error instanceof AuthenticationError) {
    return `Authentication failed: ${error.message}. Fix: check EXCALIDRAW_USERNAME and EXCALIDRAW_PASSWORD, then retry.`;
  }
  if (error instanceof RateLimitError) {
    return error.retryAfterSeconds !== undefined
      ? `The fork's AI rate limit was hit: ${error.message}. Fix: retry in ${error.retryAfterSeconds} seconds.`
      : `The fork's AI rate limit was hit: ${error.message}. Fix: retry later.`;
  }
  if (error instanceof TransportError) {
    return error.kind === "timeout"
      ? "The Excalidraw server did not answer in time. Fix: retry, or raise EXCALIDRAW_TIMEOUT_MS if it is consistently too slow."
      : "The Excalidraw server could not be reached. Fix: verify EXCALIDRAW_BASE_URL and that the server is running.";
  }
  if (error instanceof InvalidMermaidError) {
    return `Invalid Mermaid input: ${error.message}. Fix: send non-empty Mermaid diagram text.`;
  }
  if (error instanceof MermaidLimitError) {
    return `Diagram too large: ${error.message}. Fix: split or simplify the diagram.`;
  }
  if (error instanceof MermaidParseError) {
    return `Mermaid could not be converted: ${error.message}. Fix: check the Mermaid syntax and try a simpler diagram.`;
  }
  if (error instanceof ConverterError) {
    return `Conversion failed: ${error.message}. Fix: retry; if it persists, simplify the diagram.`;
  }
  if (error instanceof MermaidSceneError) {
    return `Conversion failed: ${error.message}.`;
  }
  if (error instanceof HttpApiError) {
    return `Excalidraw server error (${error.status}): ${error.serverMessage ?? "no details"}. Fix: retry or adjust the request.`;
  }
  if (error instanceof RenderError) {
    return `Could not render the diagram: ${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Unexpected error: ${message}. Fix: retry; if it persists, report the failure.`;
}

/** Wraps a handler so both success results and typed errors become tool results. */
async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error: unknown) {
    return toolResultForError(error);
  }
}

/**
 * Builds the MCP result for a render: the image itself plus the summary the
 * agent needs (pixel size, element count, elapsed time, saved path). Kept out
 * of the registration callback so it can be tested without a transport.
 */
export function renderToolResult(rendered: RenderDiagramResult): CallToolResult {
  const { png, ...summary } = rendered;
  return {
    content: [
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      { type: "text", text: JSON.stringify(summary, null, 2) },
    ],
  };
}

/**
 * Registers the diagram tools and the PNG renderer onto the given MCP server.
 * The transport lives outside this module: it is exported on its own so a stdio
 * host can call it with an `McpServer` of its own.
 *
 * The renderer's injectable pieces stay optional, so the production call site
 * only has to provide the API client and the Mermaid converter.
 */
export function registerDiagramTools(
  server: McpServer,
  deps: DiagramToolDeps & Pick<RenderToolDeps, "renderScene" | "writePng">,
): DiagramTools & RenderTools {
  const tools = createDiagramTools(deps);
  const renderTools = createRenderTools(deps);

  server.registerTool(
    "create_diagram",
    {
      title: "Create diagram",
      description:
        "Create a diagram as the configured user. mode 'agent' converts locally: pass exactly one of " +
        "mermaid (Mermaid text) or scene (an Excalidraw scene object with a non-empty elements array). " +
        "mode 'fork-ai' generates the Mermaid from prompt via the fork's AI and converts it. " +
        "Existing diagrams are protected unless overwrite is true.",
      inputSchema: {
        name: z.string().describe("Diagram name; it is normalized (NFKC, separator runs, lowercase) before use"),
        mode: z.enum(["agent", "fork-ai"]).describe("How the scene is produced"),
        prompt: z.string().optional().describe("Required for mode 'fork-ai': what the diagram should show"),
        mermaid: z.string().optional().describe("Required for mode 'agent' with mermaid: Mermaid diagram text"),
        scene: z.record(z.string(), z.unknown()).optional().describe("Alternative for mode 'agent': a raw Excalidraw scene object with a non-empty elements array"),
        overwrite: z.boolean().optional().describe("Replace an existing diagram with the same name (default false)"),
      },
    },
    (input) => runTool(() => tools.create_diagram(input)),
  );

  server.registerTool(
    "list_diagrams",
    {
      title: "List diagrams",
      description: "List the user's diagrams with name, fileName and updatedAt.",
    },
    () => runTool(() => tools.list_diagrams()),
  );

  server.registerTool(
    "get_diagram",
    {
      title: "Get diagram",
      description:
        "Read a diagram. format 'summary' (default) returns element counts, per-type counts and bounded label " +
        "texts; a raw scene can be tens of thousands of tokens, so the summary is the safe default. " +
        "format 'scene' returns the full scene when genuinely needed.",
      inputSchema: {
        name: z.string(),
        format: z.enum(["summary", "scene"]).optional(),
      },
    },
    (input) => runTool(() => tools.get_diagram(input)),
  );

  server.registerTool(
    "delete_diagram",
    {
      title: "Delete diagram",
      description: "Delete a diagram by name and report the canonical name removed.",
      inputSchema: {
        name: z.string(),
      },
    },
    (input) => runTool(() => tools.delete_diagram(input)),
  );

  server.registerTool(
    "render_diagram",
    {
      title: "Render diagram to PNG",
      description:
        "Render a diagram to a PNG and return the image, so you can judge legibility instead of guessing from element " +
        "counts. Provide exactly one source: name (an existing diagram, rendered without changes), mermaid (Mermaid " +
        "text converted through this project's pipeline and rendered WITHOUT saving anything), or scene (a raw scene " +
        "object). Optional scale (default 1) and maxWidth (downscale wider results). Rendering is read-only and the " +
        "PNG is also written to the system temp directory.",
      inputSchema: {
        name: z.string().optional().describe("Render an existing diagram by name"),
        mermaid: z.string().optional().describe("Render Mermaid text converted locally, without saving it"),
        scene: z.record(z.string(), z.unknown()).optional().describe("Render a raw Excalidraw scene object"),
        scale: z.number().optional().describe("Pixel scale between 0.2 and 4 (default 1)"),
        maxWidth: z.number().int().optional().describe("Downscale when the result would be wider than this many pixels"),
      },
    },
    async (input) => {
      try {
        return renderToolResult(await renderTools.render_diagram(input));
      } catch (error: unknown) {
        return toolResultForError(error);
      }
    },
  );

  return { ...tools, ...renderTools };
}
