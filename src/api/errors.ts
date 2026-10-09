/**
 * Typed error hierarchy for the Excalidraw API client.
 *
 * Callers branch on these classes; raw fetch failures (for example
 * `TypeError: fetch failed`) must never escape the client. No error in this
 * hierarchy ever carries the configured password or the session cookie value:
 * messages are built only from status codes and the server-provided message.
 */

/** Base class for every error raised by the Excalidraw API client. */
export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 401 from the server, including after the single re-login attempt. */
export class AuthenticationError extends ApiError {
  readonly status = 401;

  constructor(serverMessage?: string) {
    super(
      serverMessage
        ? `Excalidraw authentication failed: ${serverMessage}`
        : "Excalidraw authentication failed",
    );
  }
}

/** 404 from the server. */
export class NotFoundError extends ApiError {
  readonly status = 404;

  constructor(serverMessage?: string) {
    super(
      serverMessage ? `Excalidraw resource not found: ${serverMessage}` : "Excalidraw resource not found",
    );
  }
}

/** 429 from the server; carries the raw and parsed `Retry-After` when present. */
export class RateLimitError extends ApiError {
  readonly status = 429;
  /** Raw `Retry-After` header value (seconds or an HTTP-date). */
  readonly retryAfter: string | undefined;
  /** `Retry-After` parsed as a whole number of seconds, when numeric. */
  readonly retryAfterSeconds: number | undefined;

  constructor(retryAfter: string | undefined, serverMessage?: string) {
    super(
      serverMessage
        ? `Excalidraw rate limit hit: ${serverMessage}`
        : "Excalidraw rate limit hit",
    );
    this.retryAfter = retryAfter;
    this.retryAfterSeconds = /^\d+$/.test(retryAfter ?? "") ? Number(retryAfter) : undefined;
  }
}

/** Any other non-success HTTP status; carries the status and server message. */
export class HttpApiError extends ApiError {
  readonly status: number;
  readonly serverMessage: string | undefined;

  constructor(status: number, serverMessage: string | undefined) {
    super(
      serverMessage
        ? `Excalidraw request failed with ${status}: ${serverMessage}`
        : `Excalidraw request failed with ${status}`,
    );
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

export type TransportFailureKind = "timeout" | "unreachable";

/** Network-level failure: the configured timeout fired or the host was unreachable. */
export class TransportError extends ApiError {
  readonly kind: TransportFailureKind;

  constructor(kind: TransportFailureKind, options?: { cause?: unknown }) {
    super(
      kind === "timeout"
        ? "Excalidraw request timed out"
        : "Excalidraw server could not be reached",
    );
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
    this.kind = kind;
  }
}
