import { describe, it, expect } from "vitest";
import { AgentSubscriptionIndex } from "./subscriptions.js";
import type { AgentConfig } from "../agent-config/agent-config.js";

function cfg(name: string, subscriptions: string[]): AgentConfig {
  return {
    name, model: "m", imageTag: "t", provider: "anthropic",
    configPath: "/x", agentsMdPath: "/x/AGENTS.md", storePath: "/x/store",
    subscriptions, allowedTools: [],
  };
}

describe("AgentSubscriptionIndex", () => {
  it("returns agent ids subscribed to a dm topic", () => {
    const cfgs = new Map([
      ["claude-assistant", cfg("claude-assistant", ["claude-assistant"])],
      ["studio-assistant", cfg("studio-assistant", ["studio-assistant"])],
    ]);
    const idx = new AgentSubscriptionIndex(cfgs);
    expect(idx.lookup("dm", "claude-assistant")).toEqual(["claude-assistant"]);
    expect(idx.lookup("dm", "studio-assistant")).toEqual(["studio-assistant"]);
  });

  it("returns empty array when no subscribers match", () => {
    const cfgs = new Map([["a", cfg("a", ["a"])]]);
    const idx = new AgentSubscriptionIndex(cfgs);
    expect(idx.lookup("dm", "nonexistent")).toEqual([]);
    expect(idx.lookup("other-channel", "a")).toEqual([]);
  });

  it("supports multiple agents on the same topic", () => {
    const cfgs = new Map([
      ["a", cfg("a", ["team-wide"])],
      ["b", cfg("b", ["team-wide"])],
    ]);
    const idx = new AgentSubscriptionIndex(cfgs);
    expect(idx.lookup("dm", "team-wide").sort()).toEqual(["a", "b"]);
  });

  it("an agent can subscribe to multiple topics", () => {
    const cfgs = new Map([["a", cfg("a", ["t1", "t2"])]]);
    const idx = new AgentSubscriptionIndex(cfgs);
    expect(idx.lookup("dm", "t1")).toEqual(["a"]);
    expect(idx.lookup("dm", "t2")).toEqual(["a"]);
  });
});
