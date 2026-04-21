import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDatabase, type Db } from "../../db/database.js";
import { runMigrations } from "../../db/migrator.js";
import { AgentRepo } from "../../db/agent-repo.js";
import { MessageRepo } from "../../db/message-repo.js";
import { TurnRepo } from "../../db/turn-repo.js";

export interface Storage {
  db: Db;
  agentRepo: AgentRepo;
  messageRepo: MessageRepo;
  turnRepo: TurnRepo;
  close(): void;
}

export interface StorageDeps {
  /** Either a directory path (file DB) or `:memory:` for in-process tests. */
  dataDir: string;
}

export function composeStorage(deps: StorageDeps): Storage {
  let dbPath: string;
  if (deps.dataDir === ":memory:") {
    dbPath = ":memory:";
  } else {
    mkdirSync(deps.dataDir, { recursive: true });
    dbPath = join(deps.dataDir, "teamroom.db");
  }
  const db = createDatabase(dbPath);
  runMigrations(db);
  return {
    db,
    agentRepo: new AgentRepo(db),
    messageRepo: new MessageRepo(db),
    turnRepo: new TurnRepo(db),
    close: () => db.close(),
  };
}
