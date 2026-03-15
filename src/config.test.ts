import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

// Must set env before dynamic import of config module (which calls requireEnv at top level)
process.env.AGENTMAIL_API_KEY = "test-api-key";

let parseConfig: typeof import("./config.js").parseConfig;

beforeAll(async () => {
  const mod = await import("./config.js");
  parseConfig = mod.parseConfig;
});

describe("parseConfig", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = [...originalArgv.slice(0, 2)];
  });

  test("parses required args and returns Config", () => {
    process.argv = [
      "bun",
      "test",
      "--inbox",
      "test@inbox.example.com",
      "--allowed-domains",
      "example.com,other.org",
      "--work-dir",
      "/tmp/work",
    ];

    const config = parseConfig();

    expect(config.inbox).toBe("test@inbox.example.com");
    expect(config.allowedDomains).toEqual(["example.com", "other.org"]);
    expect(config.workDir).toBe("/tmp/work");
  });

  test("trims and lowercases domains", () => {
    process.argv = [
      "bun",
      "test",
      "--inbox",
      "x@test.com",
      "--allowed-domains",
      " Example.COM , OTHER.org ",
      "--work-dir",
      "/tmp/w",
    ];

    const config = parseConfig();

    expect(config.allowedDomains).toEqual(["example.com", "other.org"]);
  });

  test("uses default values", () => {
    process.argv = [
      "bun",
      "test",
      "--inbox",
      "x@test.com",
      "--allowed-domains",
      "a.com",
      "--work-dir",
      "/tmp/w",
    ];

    const config = parseConfig();

    expect(config.pollInterval).toBe(300_000); // 300s * 1000
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.workerModel).toBe("claude-sonnet-4-6");
    expect(config.maxTurns).toBe(50);
    expect(config.dbPath).toBe("/tmp/w/dispatch.db");
  });

  test("overrides defaults when flags provided", () => {
    process.argv = [
      "bun",
      "test",
      "--inbox",
      "x@test.com",
      "--allowed-domains",
      "a.com",
      "--work-dir",
      "/tmp/w",
      "--poll-interval",
      "60",
      "--db",
      "/custom/db.sqlite",
      "--model",
      "claude-opus-4-6",
      "--worker-model",
      "claude-haiku-4-5-20251001",
      "--max-turns",
      "10",
    ];

    const config = parseConfig();

    expect(config.pollInterval).toBe(60_000);
    expect(config.dbPath).toBe("/custom/db.sqlite");
    expect(config.model).toBe("claude-opus-4-6");
    expect(config.workerModel).toBe("claude-haiku-4-5-20251001");
    expect(config.maxTurns).toBe(10);
  });
});
