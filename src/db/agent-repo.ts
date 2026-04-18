import type { Agent } from "../types.js";
import type { Db } from "./database.js";

interface AgentRow {
  id: string;
  config_path: string;
  created_at: string;
}

function rowToAgent(row: AgentRow): Agent {
  return { id: row.id, configPath: row.config_path, createdAt: row.created_at };
}

export class AgentRepo {
  constructor(private readonly db: Db) {}

  create(agent: Agent): void {
    this.db
      .prepare("INSERT INTO agents (id, config_path, created_at) VALUES (?, ?, ?)")
      .run(agent.id, agent.configPath, agent.createdAt);
  }

  findById(id: string): Agent | null {
    const row = this.db
      .prepare("SELECT id, config_path, created_at FROM agents WHERE id = ?")
      .get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  findAll(): Agent[] {
    const rows = this.db
      .prepare("SELECT id, config_path, created_at FROM agents ORDER BY id")
      .all() as AgentRow[];
    return rows.map(rowToAgent);
  }
}
