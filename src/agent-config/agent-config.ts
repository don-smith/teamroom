import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

export interface AgentConfig {
  name: string;
  model: string;
  imageTag: string;
  configPath: string;     // absolute path to the agent folder
  agentsMdPath: string;   // absolute path to AGENTS.md inside the folder
  storePath: string;      // absolute path to store/
}

export function loadAgentConfig(agentDir: string): AgentConfig {
  const configPath = resolve(agentDir);
  const yamlPath = join(configPath, "agent.yaml");
  const agentsMdPath = join(configPath, "AGENTS.md");
  const storePath = join(configPath, "store");

  if (!existsSync(yamlPath)) throw new Error(`missing agent.yaml at ${yamlPath}`);
  if (!existsSync(agentsMdPath)) throw new Error(`missing AGENTS.md at ${agentsMdPath}`);
  if (!existsSync(storePath) || !statSync(storePath).isDirectory()) {
    throw new Error(`missing store/ directory at ${storePath}`);
  }

  const parsed = YAML.parse(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
  const name = parsed.name;
  const model = parsed.model;
  const imageTag = parsed.image_tag;
  if (typeof name !== "string") throw new Error(`agent.yaml missing 'name'`);
  if (typeof model !== "string") throw new Error(`agent.yaml missing 'model'`);
  if (typeof imageTag !== "string") throw new Error(`agent.yaml missing 'image_tag'`);

  return { name, model, imageTag, configPath, agentsMdPath, storePath };
}
