import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ConfigError, describeConfig, loadConfig, loadEnvFile } from "./config.ts";

describe("loadConfig", () => {
  it("applies defaults for optional variables", () => {
    const config = loadConfig({
      EXCALIDRAW_USERNAME: " alice ",
      EXCALIDRAW_PASSWORD: "secret",
    });
    assert.equal(config.baseUrl, "http://localhost:3030");
    assert.equal(config.username, "alice");
    assert.equal(config.password, "secret");
    assert.equal(config.timeoutMs, 30000);
  });

  it("trims trailing slashes from EXCALIDRAW_BASE_URL", () => {
    const config = loadConfig({
      EXCALIDRAW_BASE_URL: "http://excali.example.com///",
      EXCALIDRAW_USERNAME: "alice",
      EXCALIDRAW_PASSWORD: "secret",
    });
    assert.equal(config.baseUrl, "http://excali.example.com");
  });

  it("trims whitespace from EXCALIDRAW_USERNAME", () => {
    const config = loadConfig({
      EXCALIDRAW_USERNAME: "  bob  ",
      EXCALIDRAW_PASSWORD: "secret",
    });
    assert.equal(config.username, "bob");
  });

  it("fails naming EXCALIDRAW_USERNAME when it is missing", () => {
    assert.throws(
      () => loadConfig({ EXCALIDRAW_PASSWORD: "secret" }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.variable, "EXCALIDRAW_USERNAME");
        return true;
      },
    );
  });

  it("treats a whitespace-only EXCALIDRAW_USERNAME as missing", () => {
    assert.throws(
      () => loadConfig({ EXCALIDRAW_USERNAME: "   ", EXCALIDRAW_PASSWORD: "secret" }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.variable, "EXCALIDRAW_USERNAME");
        return true;
      },
    );
  });

  it("fails naming EXCALIDRAW_PASSWORD when it is missing", () => {
    assert.throws(
      () => loadConfig({ EXCALIDRAW_USERNAME: "alice" }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.variable, "EXCALIDRAW_PASSWORD");
        return true;
      },
    );
  });

  it("preserves the password exactly, without trimming", () => {
    const password = "  p4ss w0rd! ";
    const config = loadConfig({
      EXCALIDRAW_USERNAME: "alice",
      EXCALIDRAW_PASSWORD: password,
    });
    assert.equal(config.password, password);
  });

  it("accepts a valid EXCALIDRAW_TIMEOUT_MS", () => {
    const config = loadConfig({
      EXCALIDRAW_USERNAME: "alice",
      EXCALIDRAW_PASSWORD: "secret",
      EXCALIDRAW_TIMEOUT_MS: "120000",
    });
    assert.equal(config.timeoutMs, 120000);
  });

  it("fails on a non-numeric EXCALIDRAW_TIMEOUT_MS", () => {
    assert.throws(
      () =>
        loadConfig({
          EXCALIDRAW_USERNAME: "alice",
          EXCALIDRAW_PASSWORD: "secret",
          EXCALIDRAW_TIMEOUT_MS: "soon",
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.variable, "EXCALIDRAW_TIMEOUT_MS");
        return true;
      },
    );
  });

  it("fails on zero or negative EXCALIDRAW_TIMEOUT_MS", () => {
    for (const value of ["0", "-5"]) {
      assert.throws(
        () =>
          loadConfig({
            EXCALIDRAW_USERNAME: "alice",
            EXCALIDRAW_PASSWORD: "secret",
            EXCALIDRAW_TIMEOUT_MS: value,
          }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.equal(error.variable, "EXCALIDRAW_TIMEOUT_MS");
          return true;
        },
      );
    }
  });

  it("fails on a non-integer EXCALIDRAW_TIMEOUT_MS", () => {
    assert.throws(
      () =>
        loadConfig({
          EXCALIDRAW_USERNAME: "alice",
          EXCALIDRAW_PASSWORD: "secret",
          EXCALIDRAW_TIMEOUT_MS: "12.5",
        }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.variable, "EXCALIDRAW_TIMEOUT_MS");
        return true;
      },
    );
  });
});

describe("describeConfig", () => {
  it("reveals baseUrl, username and timeoutMs but never the password value", () => {
    const config = loadConfig({
      EXCALIDRAW_USERNAME: "alice",
      EXCALIDRAW_PASSWORD: "s3cret-value",
    });
    const description = describeConfig(config);
    assert.match(description, /baseUrl=http:\/\/localhost:3030/);
    assert.match(description, /username=alice/);
    assert.match(description, /timeoutMs=30000/);
    assert.match(description, /password=present/);
    assert.ok(!description.includes("s3cret-value"), "description must not contain the password");
  });

  it("still never leaks the password when fields are odd", () => {
    const description = describeConfig({
      baseUrl: "http://x",
      username: "weird]name",
      password: "topsecret",
      timeoutMs: 1,
    });
    assert.ok(!description.includes("topsecret"), "description must not contain the password");
    assert.match(description, /password=present/);
  });
});

describe("loadEnvFile", () => {
  it("returns no values without throwing when the file is absent", () => {
    const values = loadEnvFile("D:/definitely/missing/.env");
    assert.deepEqual(values, {});
  });

  it("parses file values without touching process.env", () => {
    // Fixture written to a temp dir so no repo files outside src/ are touched.
    const dir = mkdtempSync(join(tmpdir(), "excalidraw-mcp-config-test-"));
    const envFile = join(dir, "fixture.env");
    writeFileSync(
      envFile,
      [
        "# comment",
        "EXISTING=ignored",
        "FROM_FILE=file-value",
        // Only a real dotenv parser gets these right:
        'QUOTED="hello world with spaces"',
        "EXCALIDRAW_PASSWORD=a=b=c",
      ].join("\n"),
      "utf8",
    );
    const values = loadEnvFile(envFile);
    assert.equal(values["FROM_FILE"], "file-value");
    assert.equal(values["QUOTED"], "hello world with spaces");
    assert.equal(values["EXCALIDRAW_PASSWORD"], "a=b=c");
    // Loading a file must never inject into process.env as a side effect.
    assert.equal(process.env["FROM_FILE"], undefined);
    assert.equal(process.env["EXCALIDRAW_PASSWORD"], undefined);
  });
});
