/**
 * Typed errors raised by the diagram tool handlers, beyond what the API and
 * scene layers already report. The registration boundary
 * (`src/tools/register.ts`) converts every typed error into a readable tool
 * result that tells the agent what to do differently; none of these errors
 * ever carries the password, the session cookie, or a stack trace.
 */

/** Base class for tool-level errors. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The tool input is invalid; the message says what to provide instead. */
export class ToolInputError extends ToolError {
  constructor(message: string) {
    super(`Invalid input: ${message}`);
  }
}

/**
 * The diagram name already exists and `overwrite` was not requested. Names the
 * existing diagram so the agent can decide to pass `overwrite: true`.
 */
export class DiagramConflictError extends ToolError {
  readonly existingName: string;

  constructor(existingName: string) {
    super(
      `Diagram "${existingName}" already exists. Pass overwrite: true to replace it, or choose another name.`,
    );
    this.existingName = existingName;
  }
}
