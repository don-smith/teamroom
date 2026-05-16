import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import type { AgentRuntime, Provider } from "../types.js";

export interface AgentConfig {
  name: string;
  model: string;
  imageTag: string;
  provider: Provider;
  runtime: AgentRuntime;
  configPath: string;     // absolute path to the agent folder
  agentsMdPath: string;   // absolute path to AGENTS.md inside the folder
  storePath: string;      // absolute path to store/
  subscriptions: string[];
  allowedTools: string[];
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
    throw new Error(`agent.yaml missing 'provider' (expected 'anthropic', 'lm-studio', 'ollama', or 'openai')`);
  }
  if (provider !== "anthropic" && provider !== "lm-studio" && provider !== "ollama" && provider !== "openai") {
    throw new Error(
      `agent.yaml 'provider' must be 'anthropic', 'lm-studio', 'ollama', or 'openai' (got '${String(provider)}')`,
    );
  }

  const runtime = parseRuntime(parsed.runtime, provider);

  const subscriptions = parseStringArray(parsed, "subscriptions");
  // M4: subscriptions are strictly list:<name>. The MailingListRegistry
  // validates membership at daemon boot; this check catches shape errors
  // (missing prefix, wrong prefix kind) during the individual agent load
  // so the error points at the specific file.
  for (const sub of subscriptions) {
    if (!sub.startsWith("list:") || sub.length <= "list:".length) {
      throw new Error(
        `agent.yaml '${name}': subscriptions must be 'list:<name>' (got '${sub}')`,
      );
    }
  }
  const allowedTools = parseStringArray(parsed, "allowed_tools");

  return { name, model, imageTag, provider, runtime, configPath, agentsMdPath, storePath, subscriptions, allowedTools };
}

function inferRuntime(provider: Provider): AgentRuntime {
  switch (provider) {
    case "anthropic":
      return "anthropic";
    case "lm-studio":
    case "ollama":
    case "openai":
      return "langgraph";
  }
}

function parseRuntime(value: unknown, provider: Provider): AgentRuntime {
  if (value === undefined || value === null) return inferRuntime(provider);
  if (value !== "anthropic" && value !== "langgraph" && value !== "pi") {
    throw new Error(
      `agent.yaml 'runtime' must be 'anthropic', 'langgraph', or 'pi' (got '${String(value)}')`,
    );
  }
  return value;
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

function parseStringArray(parsed: Record<string, unknown>, field: string): string[] {
  const value = parsed[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`agent.yaml '${field}' must be an array (got ${typeof value})`);
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        `agent.yaml '${field}' entries must be a string (got ${typeof entry}: '${String(entry)}')`,
      );
    }
  }
  return value as string[];
}
