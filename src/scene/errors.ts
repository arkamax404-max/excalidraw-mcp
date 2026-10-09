/**
 * Typed error hierarchy for the Mermaid → Excalidraw scene pipeline.
 *
 * Every failure mode the pipeline can produce is a subclass of
 * `MermaidSceneError`, so callers can branch without catching strings. No
 * error carries raw library internals that could confuse or mislead callers;
 * causes are attached where they aid diagnosis.
 */

/** Base class for every error raised by the scene pipeline. */
export class MermaidSceneError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** The input is not a usable Mermaid definition (empty or blank). */
export class InvalidMermaidError extends MermaidSceneError {
  constructor(message = "Mermaid input is empty or blank") {
    super(message);
  }
}

/** The input exceeds the dependency's own limits and would be truncated. */
export class MermaidLimitError extends MermaidSceneError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * The input is a valid Mermaid diagram of a type this pipeline does not lay
 * out itself. The error names the detected type and the supported list so the
 * caller can fix the input instead of receiving an illegible scene or a
 * placeholder image.
 */
export class UnsupportedDiagramError extends MermaidSceneError {
  constructor(diagramType: string, supported: readonly string[]) {
    super(
      `Unsupported Mermaid diagram type "${diagramType}": only ${supported.join(" and ")} diagrams are supported. ` +
        `Convert the input to one of the supported types or use a different tool.`,
    );
  }
}

/**
 * Mermaid could not be parsed into a usable diagram. This also covers the
 * dependency's silent failure mode: a failed parse does NOT throw, it returns
 * a single placeholder `image` element — that fallback is detected and raised
 * as this error instead of being persisted.
 */
export class MermaidParseError extends MermaidSceneError {
  constructor(message = "Mermaid could not be parsed into a usable diagram", options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The bundled Excalidraw converter could not be loaded or failed to convert. */
export class ConverterError extends MermaidSceneError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
