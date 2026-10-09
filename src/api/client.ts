/**
 * Authenticated HTTP client for the self-hosted Excalidraw fork.
 *
 * The client keeps the `excalidraw.sid` session cookie in memory only, applies
 * `config.timeoutMs` to every request, re-logs in exactly once when an
 * authenticated call is rejected with 401, and maps every failure mode onto
 * the typed hierarchy in `./errors.ts`. It never logs and never puts the
 * password or the cookie value into an error message or thrown property.
 */
import type { ExcalidrawConfig } from "../config.ts";
import {
  ApiError,
  AuthenticationError,
  HttpApiError,
  NotFoundError,
  RateLimitError,
  TransportError,
} from "./errors.ts";

export interface ExcalidrawUser {
  username?: string;
  [key: string]: unknown;
}

export interface ExcalidrawSession {
  authenticated: boolean;
  user?: ExcalidrawUser;
}

export interface DiagramFile {
  name: string;
  fileName: string;
  updatedAt?: string;
}

export interface Diagram {
  file: DiagramFile;
  scene: unknown;
}

export interface MermaidGeneration {
  mermaid: string;
  provider: string;
  model: string;
}

const SESSION_COOKIE_PREFIX = "excalidraw.sid=";

/** Maps a failed `fetch` onto the typed transport error; raw errors never escape. */
function toTransportError(error: unknown): TransportError {
  if (error instanceof TransportError) {
    return error;
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new TransportError("timeout", { cause: error });
  }
  // `fetch` surfaces unreachable hosts and refused connections as TypeError.
  return new TransportError("unreachable", { cause: error });
}

export function createExcalidrawClient(config: ExcalidrawConfig) {
  /** Session cookie from the last `Set-Cookie`; kept in memory only. */
  let sessionCookie: string | undefined;

  function applySetCookie(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      if (cookie.startsWith(SESSION_COOKIE_PREFIX)) {
        sessionCookie = cookie.split(";")[0];
      }
    }
  }

  /**
   * Performs one raw request. Applies the timeout, stores any session cookie
   * the server hands out, and maps transport failures to `TransportError`.
   */
  async function rawRequest(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<{ status: number; response: Response }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (sessionCookie !== undefined) {
      headers["Cookie"] = sessionCookie;
    }
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error: unknown) {
      throw toTransportError(error);
    }
    applySetCookie(response);
    return { status: response.status, response };
  }

  async function readJsonBody(response: Response): Promise<{ parsed: boolean; value: unknown }> {
    try {
      return { parsed: true, value: (await response.json()) as unknown };
    } catch {
      // Non-JSON (or empty) body: callers decide what a typed error looks like.
      return { parsed: false, value: undefined };
    }
  }

  function serverMessageOf(value: unknown): string | undefined {
    const error = (value as { error?: unknown } | undefined)?.error;
    return typeof error === "string" ? error : undefined;
  }

  /** Turns any non-success status into the matching typed error. */
  async function throwForStatus(status: number, response: Response): Promise<never> {
    const { value } = await readJsonBody(response);
    const serverMessage = serverMessageOf(value);
    if (status === 401) {
      throw new AuthenticationError(serverMessage);
    }
    if (status === 404) {
      throw new NotFoundError(serverMessage);
    }
    if (status === 429) {
      throw new RateLimitError(response.headers.get("retry-after") ?? undefined, serverMessage);
    }
    throw new HttpApiError(status, serverMessage);
  }

  async function login(): Promise<ExcalidrawUser> {
    const { status, response } = await rawRequest("/api/auth/login", "POST", {
      username: config.username,
      password: config.password,
    });
    if (status !== 200) {
      await throwForStatus(status, response);
    }
    const { value } = await readJsonBody(response);
    return (value as { user?: ExcalidrawUser } | undefined)?.user ?? {};
  }

  /**
   * Authenticated request with the single-retry rule: on a 401 the client
   * re-logs in once and retries the original call once. A second 401 (or a
   * failed re-login) surfaces the typed authentication error — never a loop.
   */
  async function authedRequest(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<{ status: number; response: Response }> {
    let attempt = await rawRequest(path, method, body);
    if (attempt.status === 401) {
      await login();
      attempt = await rawRequest(path, method, body);
    }
    return attempt;
  }

  async function jsonOrThrow(
    attempt: { status: number; response: Response },
  ): Promise<unknown> {
    if (attempt.status < 200 || attempt.status >= 300) {
      await throwForStatus(attempt.status, attempt.response);
    }
    const { value } = await readJsonBody(attempt.response);
    return value;
  }

  return {
    /** Authenticates and stores the session cookie. */
    async login(): Promise<ExcalidrawUser> {
      return login();
    },

    async session(): Promise<ExcalidrawSession> {
      const attempt = await rawRequest("/api/auth/session", "GET");
      return (await jsonOrThrow(attempt)) as ExcalidrawSession;
    },

    async listDiagrams(): Promise<DiagramFile[]> {
      const attempt = await authedRequest("/api/files", "GET");
      const value = (await jsonOrThrow(attempt)) as { files?: DiagramFile[] };
      return value.files ?? [];
    },

    async getDiagram(name: string): Promise<Diagram> {
      const attempt = await authedRequest(`/api/files/${encodeURIComponent(name)}`, "GET");
      return (await jsonOrThrow(attempt)) as Diagram;
    },

    async putDiagram(name: string, scene: unknown): Promise<DiagramFile> {
      const attempt = await authedRequest(`/api/files/${encodeURIComponent(name)}`, "PUT", scene);
      const value = (await jsonOrThrow(attempt)) as { file?: DiagramFile };
      return value.file ?? ({} as DiagramFile);
    },

    async deleteDiagram(name: string): Promise<DiagramFile> {
      const attempt = await authedRequest(`/api/files/${encodeURIComponent(name)}`, "DELETE");
      const value = (await jsonOrThrow(attempt)) as { file?: DiagramFile };
      return value.file ?? ({} as DiagramFile);
    },

    async generateMermaid(prompt: string): Promise<MermaidGeneration> {
      const attempt = await authedRequest("/api/ai/diagram", "POST", { prompt });
      return (await jsonOrThrow(attempt)) as MermaidGeneration;
    },
  };
}

export type ExcalidrawClient = ReturnType<typeof createExcalidrawClient>;

// Re-export so callers can branch without importing two modules.
export { ApiError, AuthenticationError, HttpApiError, NotFoundError, RateLimitError, TransportError };
