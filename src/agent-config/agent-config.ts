import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import type { Provider } from "../types.js";

export interface AgentConfig {
  name: string;
  model: string;
  imageTag: string;
  provider: Provider;
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
  const name = requireString(parsed, "name");
  const model = requireString(parsed, "model");
  const imageTag = requireString(parsed, "image_tag");
  const provider = parsed.provider;
  if (provider === undefined || provider === null) {
    throw new Error(`agent.yaml missing 'provider' (expected 'anthropic' or 'lm-studio')`);
  }
  if (provider !== "anthropic" && provider !== "lm-studio") {
    throw new Error(
      `agent.yaml 'provider' must be 'anthropic' or 'lm-studio' (got '${String(provider)}')`,
    );
  }

  return { name, model, imageTag, provider, configPath, agentsMdPath, storePath };
}

function requireString(parsed: Record<string, unknown>, field: string): string {
  const value = parsed[field];
  if (value === undefined || value === null) {
    throw new Error(`agent.yaml missing '${field}'`);
  }
  if (typeof value !== "string") {
    throw new Error(`agent.yaml '${field}' must be a string (got ${typeof value}: '${String(value)}')`);
  }
  return value;
}
