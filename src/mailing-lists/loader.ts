import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { ListDefinition } from "./registry.js";

export function loadListsYaml(path: string): ListDefinition[] {
  const raw = readFileSync(path, "utf8");
  const parsed = YAML.parse(raw) as { lists?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.lists)) return [];
  const out: ListDefinition[] = [];
  for (const entry of parsed.lists) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`lists.yaml: expected object, got ${typeof entry}`);
    }
    const e = entry as Record<string, unknown>;
    const name = e.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`lists.yaml: list missing 'name'`);
    }
    const triggers = e.triggers;
    if (triggers != null && !Array.isArray(triggers)) {
      throw new Error(`lists.yaml: 'triggers' must be an array (list=${name})`);
    }
    const triggerStrs = (triggers ?? []) as unknown[];
    for (const t of triggerStrs) {
      if (typeof t !== "string") {
        throw new Error(`lists.yaml: trigger entries must be strings (list=${name})`);
      }
    }
    out.push({ name, triggers: triggerStrs as string[] });
  }
  return out;
}
