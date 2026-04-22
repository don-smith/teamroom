import { describe, expect, it } from "vitest";
import { MailingListRegistry, type ListDefinition } from "./registry.js";
import type { AgentConfig } from "../agent-config/agent-config.js";

function cfg(name: string, subs: string[]): AgentConfig {
  return {
    name,
    model: "m",
    imageTag: "t",
    provider: "anthropic",
    configPath: "/x",
    agentsMdPath: "/x/AGENTS.md",
    storePath: "/x/store",
    subscriptions: subs,
    allowedTools: [],
    lifecycle: "session",
  };
}

const lists: ListDefinition[] = [
  { name: "harness-activity", triggers: ["turn.started", "turn.completed"] },
  { name: "qa", triggers: [] },
];

describe("MailingListRegistry", () => {
  it("records list definitions and exposes has()", () => {
    const reg = new MailingListRegistry(lists, []);
    expect(reg.has("harness-activity")).toBe(true);
    expect(reg.has("qa")).toBe(true);
    expect(reg.has("nonexistent")).toBe(false);
  });

  it("resolves subscribers via the reverse index from agent configs", () => {
    const reg = new MailingListRegistry(lists, [
      cfg("claude-researcher", ["list:harness-activity", "list:qa"]),
      cfg("claude-assistant", ["list:harness-activity"]),
    ]);
    expect(reg.subscribers("harness-activity").sort()).toEqual([
      "claude-assistant",
      "claude-researcher",
    ]);
    expect(reg.subscribers("qa")).toEqual(["claude-researcher"]);
    expect(reg.subscribers("nonexistent")).toEqual([]);
  });

  it("rejects an agent subscribing to a non-existent list", () => {
    expect(
      () => new MailingListRegistry(lists, [cfg("a", ["list:ghost"])]),
    ).toThrow(/unknown list: ghost/);
  });

  it("rejects non-list: subscriptions", () => {
    expect(
      () => new MailingListRegistry(lists, [cfg("a", ["agent:x"])]),
    ).toThrow(/only list: subscriptions/i);
  });

  it("rejects invalid subscription strings", () => {
    expect(
      () => new MailingListRegistry(lists, [cfg("a", ["not-an-address"])]),
    ).toThrow(/invalid subscription/i);
  });

  it("rejects duplicate list definitions", () => {
    expect(
      () =>
        new MailingListRegistry(
          [
            { name: "dup", triggers: [] },
            { name: "dup", triggers: [] },
          ],
          [],
        ),
    ).toThrow(/duplicate list definition: dup/);
  });

  it("triggersFor returns this list's trigger event types", () => {
    const reg = new MailingListRegistry(lists, []);
    expect(reg.triggersFor("harness-activity").sort()).toEqual([
      "turn.completed",
      "turn.started",
    ]);
    expect(reg.triggersFor("qa")).toEqual([]);
  });

  it("listsTriggeredBy returns all lists an event fans out to", () => {
    const reg = new MailingListRegistry(lists, []);
    expect(reg.listsTriggeredBy("turn.started")).toEqual(["harness-activity"]);
    expect(reg.listsTriggeredBy("unused.event")).toEqual([]);
  });

  it("allTriggers returns the union of trigger event types", () => {
    const reg = new MailingListRegistry(lists, []);
    expect(reg.allTriggers().sort()).toEqual(["turn.completed", "turn.started"]);
  });
});
