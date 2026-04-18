import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Db } from "./database.js";
import { runMigrations } from "./migrator.js";
import { AgentRepo } from "./agent-repo.js";

function freshDb(): Db {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return db;
}

describe("AgentRepo", () => {
  let db: Db;
  let repo: AgentRepo;

  beforeEach(() => {
    db = freshDb();
    repo = new AgentRepo(db);
  });

  it("creates an agent and returns it", () => {
    repo.create({
      id: "studio-assistant",
      configPath: "/abs/path/agents/studio-assistant",
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    const found = repo.findById("studio-assistant");
    expect(found).toEqual({
      id: "studio-assistant",
      configPath: "/abs/path/agents/studio-assistant",
      createdAt: "2026-04-18T00:00:00.000Z",
    });
  });

  it("returns null when agent is missing", () => {
    expect(repo.findById("nope")).toBeNull();
  });

  it("lists all agents ordered by id", () => {
    repo.create({ id: "b", configPath: "/b", createdAt: "2026-04-18T00:00:00.000Z" });
    repo.create({ id: "a", configPath: "/a", createdAt: "2026-04-18T00:00:00.000Z" });
    const all = repo.findAll();
    expect(all.map((a) => a.id)).toEqual(["a", "b"]);
  });
});
