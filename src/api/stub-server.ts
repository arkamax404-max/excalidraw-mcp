/**
 * Local HTTP stub mirroring the recorded contract of the self-hosted
 * Excalidraw fork. Used only by tests: it listens on an ephemeral port and
 * records every request it receives, so tests can assert on exact counts
 * (for example "exactly one re-login").
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  cookie: string | undefined;
  body: unknown;
}

export interface StubServer {
  port: number;
  /** Every request received since the last `clearRequests()`. */
  requests: RecordedRequest[];
  clearRequests: () => void;
  /** Number of accepted `POST /api/auth/login` requests (successful logins). */
  acceptedLoginCount: () => number;
  close: () => Promise<void>;
}

const SESSION_COOKIE = "excalidraw.sid=stub-session";
const VALID_USER = { username: "alice", password: "secret" };

function hasSession(req: IncomingMessage): boolean {
  return (req.headers.cookie ?? "").includes(SESSION_COOKIE);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      try {
        resolveBody(raw === "" ? undefined : JSON.parse(raw));
      } catch {
        resolveBody(undefined);
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Starts the stub on an ephemeral port (`listen(0)`). Always call `close()`
 * in teardown; it also closes kept-alive sockets so the test process can exit.
 */
export function startStubServer(): Promise<StubServer> {
  return new Promise((resolveServer) => {
    const requests: RecordedRequest[] = [];
    let acceptedLogins = 0;
    /** Per-path hit counters, used for "fail on first hit" routes. */
    const pathHits = new Map<string, number>();

    const server = createServer((req, res) => {
      void (async () => {
        const body = await readBody(req);
        const url = req.url ?? "/";
        requests.push({
          method: req.method ?? "",
          url,
          cookie: req.headers.cookie,
          body,
        });
        pathHits.set(url, (pathHits.get(url) ?? 0) + 1);
        const hits = pathHits.get(url) ?? 0;

        if (url === "/api/auth/login" && req.method === "POST") {
          const credentials = body as { username?: string; password?: string } | undefined;
          if (!credentials?.username || !credentials?.password) {
            sendJson(res, 400, { error: "missing fields" });
            return;
          }
          if (credentials.username === VALID_USER.username && credentials.password === VALID_USER.password) {
            acceptedLogins += 1;
            sendJson(
              res,
              200,
              { ok: true, user: { username: VALID_USER.username } },
              { "Set-Cookie": `${SESSION_COOKIE}; Path=/; HttpOnly` },
            );
            return;
          }
          sendJson(res, 401, { error: "invalid credentials" });
          return;
        }

        if (url === "/api/auth/session") {
          sendJson(
            res,
            200,
            hasSession(req)
              ? { authenticated: true, user: { username: VALID_USER.username } }
              : { authenticated: false },
          );
          return;
        }

        if (url === "/api/files" && req.method === "GET") {
          if (!hasSession(req)) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          sendJson(res, 200, {
            files: [
              { name: "a.excalidraw", fileName: "a.excalidraw", updatedAt: "2026-01-01T00:00:00.000Z" },
              { name: "b.excalidraw", fileName: "b.excalidraw", updatedAt: "2026-01-02T00:00:00.000Z" },
            ],
          });
          return;
        }

        if (url.startsWith("/api/files/")) {
          if (!hasSession(req)) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          const name = decodeURIComponent(url.slice("/api/files/".length));
          if (name === "boom") {
            // Non-JSON error body: must not crash the client.
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("kaboom");
            return;
          }
          if (name === "always401") {
            sendJson(res, 401, { error: "session expired" });
            return;
          }
          if (name === "expire" && hits === 1) {
            sendJson(res, 401, { error: "session expired" });
            return;
          }
          if (name === "hang") {
            // Answer very late so a short client timeout fires first; unref
            // keeps the timer from holding the test process open.
            const timer = setTimeout(() => {
              sendJson(res, 200, { file: { name: "hang.excalidraw" }, scene: { elements: [] } });
            }, 5000);
            timer.unref();
            return;
          }
          if (name === "missing") {
            sendJson(res, 404, { error: "file not found" });
            return;
          }
          if (req.method === "GET") {
            sendJson(res, 200, {
              file: { name, fileName: name, updatedAt: "2026-01-03T00:00:00.000Z" },
              scene: { elements: [] },
            });
            return;
          }
          if (req.method === "PUT") {
            const scene = body as { elements?: unknown } | undefined;
            if (!scene || !Array.isArray(scene.elements)) {
              sendJson(res, 400, { error: "body must contain an elements array" });
              return;
            }
            sendJson(res, 200, { ok: true, file: { name, fileName: name } });
            return;
          }
          if (req.method === "DELETE") {
            sendJson(res, 200, { ok: true, file: { name, fileName: name } });
            return;
          }
        }

        if (url === "/api/ai/diagram" && req.method === "POST") {
          const prompt = (body as { prompt?: string } | undefined)?.prompt;
          if (prompt === "limited") {
            sendJson(res, 429, { error: "rate limited" }, { "Retry-After": "7" });
            return;
          }
          sendJson(res, 200, { mermaid: "graph TD;\nA-->B", provider: "stub", model: "stub-1" });
          return;
        }

        sendJson(res, 404, { error: "no such route" });
      })().catch((error: unknown) => {
        // Never let an async stub bug hang the response; report via stderr.
        console.error("[stub-server] handler failed:", error);
        sendJson(res, 500, { error: "stub failure" });
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({
        port,
        requests,
        clearRequests: () => {
          requests.length = 0;
          acceptedLogins = 0;
        },
        acceptedLoginCount: () => acceptedLogins,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.closeAllConnections();
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          }),
      });
    });
  });
}

/**
 * Returns a port that nothing is listening on (bind once, release, reuse the
 * number), for unreachable-host transport tests.
 */
export function findClosedPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolvePort(port));
    });
    probe.on("error", rejectPort);
  });
}
