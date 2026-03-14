import { describe, test, expect } from "bun:test";
import { initDatabase } from "./db.js";

describe("initDatabase", () => {
  test("creates expected tables", () => {
    const db = initDatabase(":memory:");

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("threads");
    expect(tableNames).toContain("windows");
    expect(tableNames).toContain("messages_seen");

    db.close();
  });

  test("creates expected indexes", () => {
    const db = initDatabase(":memory:");

    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as { name: string }[];

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_windows_thread");
    expect(indexNames).toContain("idx_windows_status");

    db.close();
  });

  test("enables foreign keys", () => {
    const db = initDatabase(":memory:");

    const result = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(result.foreign_keys).toBe(1);

    db.close();
  });
});
