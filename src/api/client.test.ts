import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { ExcalidrawConfig } from "../config.ts";
import {
  AuthenticationError,
  HttpApiError,
  NotFoundError,
  RateLimitError,
  TransportError,
} from "./errors.ts";
import { createExcalidrawClient } from "./client.ts";
import { findClosedPort, startStubServer, type StubServer } from "./stub-server.ts";

/** Serializes an error (own properties, message, stack) for leak assertions. */
function errorDump(error: unknown): string {
  const ownProps = Object.fromEntries(
    Object.getOwnPropertyNames(error as object).map((key) => [key, (error as Record<string, unknown>)[key]]),
  );
  return [String(error), JSON.stringify(ownProps)].join("\n");
}

describe("ExcalidrawClient", () => {
  let stub: StubServer;

  const baseConfig = (): ExcalidrawConfig => ({
    baseUrl: `http://127.0.0.1:${stub.port}`,
    username: "alice",
    password: "secret",
    timeoutMs: 2000,
  });

  before(async () => {
    stub = await startStubServer();
  });

  after(async () => {
    await stub.close();
  });

  it("login sends the credentials and stores the session cookie", async () => {
    stub.clearRequests();
    const client = createExcalidrawClient(baseConfig());
    const user = await client.login();
    assert.deepEqual(user, { username: "alice" });
    const loginRequest = stub.requests.find((request) => request.url === "/api/auth/login");
    assert.ok(loginRequest, "login request must have been recorded");
    assert.deepEqual(loginRequest.body, { username: "alice", password: "secret" });
    const session = await client.session();
    assert.deepEqual(session, { authenticated: true, user: { username: "alice" } });
    const sessionRequest = stub.requests.find((request) => request.url === "/api/auth/session");
    assert.ok(sessionRequest?.cookie?.includes("excalidraw.sid="), "session request must carry the cookie");
  });

  it("sends the stored cookie on later authenticated requests", async () => {
    stub.clearRequests();
    const client = createExcalidrawClient(baseConfig());
    await client.login();
    const files = await client.listDiagrams();
    assert.deepEqual(files, [
      { name: "a.excalidraw", fileName: "a.excalidraw", updatedAt: "2026-01-01T00:00:00.000Z" },
      { name: "b.excalidraw", fileName: "b.excalidraw", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    const filesRequest = stub.requests.find((request) => request.url === "/api/files");
    assert.ok(filesRequest?.cookie?.includes("excalidraw.sid="), "files request must carry the cookie");
  });

  it("re-logs in exactly once and retries once on a 401", async () => {
    stub.clearRequests();
    // No prior login: the first request is rejected with 401, the client must
    // log in once and retry the original call once.
    const client = createExcalidrawClient(baseConfig());
    const diagram = await client.getDiagram("expire");
    assert.equal(diagram.file.name, "expire");
    assert.equal(stub.acceptedLoginCount(), 1, "exactly one re-login must have happened");
    const hits = stub.requests.filter((request) => request.url === "/api/files/expire").length;
    assert.equal(hits, 2, "the original request must be retried exactly once");
  });

  it("surfaces the authentication error after a second 401 without retrying again", async () => {
    stub.clearRequests();
    const client = createExcalidrawClient(baseConfig());
    await client.login();
    assert.equal(stub.acceptedLoginCount(), 1, "initial login");
    await assert.rejects(
      () => client.getDiagram("always401"),
      (error: unknown) => {
        assert.ok(error instanceof AuthenticationError);
        return true;
      },
    );
    assert.equal(stub.acceptedLoginCount(), 2, "one re-login, not a loop");
    const hits = stub.requests.filter((request) => request.url === "/api/files/always401").length;
    assert.equal(hits, 2, "one original request plus one retry, nothing more");
  });

  it("maps a 404 to the not-found error", async () => {
    const client = createExcalidrawClient(baseConfig());
    await client.login();
    await assert.rejects(
      () => client.getDiagram("missing"),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError);
        return true;
      },
    );
  });

  it("maps a 429 to the rate-limit error and exposes Retry-After", async () => {
    const client = createExcalidrawClient(baseConfig());
    await client.login();
    await assert.rejects(
      () => client.generateMermaid("limited"),
      (error: unknown) => {
        assert.ok(error instanceof RateLimitError);
        assert.equal(error.retryAfter, "7");
        assert.equal(error.retryAfterSeconds, 7);
        return true;
      },
    );
  });

  it("maps a server that never answers to the typed timeout error", async () => {
    stub.clearRequests();
    const client = createExcalidrawClient({ ...baseConfig(), timeoutMs: 100 });
    await client.login();
    await assert.rejects(
      () => client.getDiagram("hang"),
      (error: unknown) => {
        assert.ok(error instanceof TransportError);
        assert.equal(error.kind, "timeout");
        return true;
      },
    );
  });

  it("maps an unreachable host to the typed transport error instead of a raw TypeError", async () => {
    const port = await findClosedPort();
    const client = createExcalidrawClient({ ...baseConfig(), baseUrl: `http://127.0.0.1:${port}` });
    await assert.rejects(
      () => client.login(),
      (error: unknown) => {
        assert.ok(error instanceof TransportError);
        assert.equal(error.kind, "unreachable");
        assert.ok(!(error instanceof TypeError), "raw fetch TypeError must not escape");
        return true;
      },
    );
  });

  it("does not crash on a non-JSON error body", async () => {
    const client = createExcalidrawClient(baseConfig());
    await client.login();
    await assert.rejects(
      () => client.getDiagram("boom"),
      (error: unknown) => {
        assert.ok(error instanceof HttpApiError, "a typed error must surface");
        assert.equal(error.status, 500);
        assert.ok(!(error instanceof SyntaxError), "JSON parse failure must not escape");
        return true;
      },
    );
  });

  it("putDiagram sends the scene as JSON to the encoded path and returns the canonical file", async () => {
    stub.clearRequests();
    const client = createExcalidrawClient(baseConfig());
    await client.login();
    const scene = { elements: [{ type: "rectangle" }], appState: {} };
    const file = await client.putDiagram("new diagram", scene);
    assert.equal(file.name, "new diagram");
    const putRequest = stub.requests.find((request) => request.url.startsWith("/api/files/"));
    assert.ok(putRequest, "PUT request must have been recorded");
    assert.equal(putRequest.method, "PUT");
    assert.equal(putRequest.url, "/api/files/new%20diagram", "the name must be URL-encoded, not sanitized");
    assert.deepEqual(putRequest.body, scene);
  });

  it("deleteDiagram maps its 404", async () => {
    const client = createExcalidrawClient(baseConfig());
    await client.login();
    await assert.rejects(
      () => client.deleteDiagram("missing"),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError);
        return true;
      },
    );
  });

  it("generateMermaid returns the parsed AI response", async () => {
    const client = createExcalidrawClient(baseConfig());
    await client.login();
    const result = await client.generateMermaid("a flow chart");
    assert.deepEqual(result, { mermaid: "graph TD;\nA-->B", provider: "stub", model: "stub-1" });
  });

  it("never leaks the configured password or the cookie through thrown errors", async () => {
    const password = "topsecret-value";
    const client = createExcalidrawClient({ ...baseConfig(), password });
    let captured: unknown;
    try {
      await client.login();
      assert.fail("login with wrong credentials must throw");
    } catch (error: unknown) {
      captured = error;
    }
    assert.ok(captured instanceof AuthenticationError);
    const dump = errorDump(captured);
    assert.ok(!dump.includes(password), "error dump must not contain the password");
    assert.ok(!dump.includes("stub-session"), "error dump must not contain the cookie value");
  });
});
