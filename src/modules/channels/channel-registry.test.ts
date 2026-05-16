import { describe, expect, it } from "bun:test";
import { ChannelRegistry } from "./channel-registry.js";

describe("ChannelRegistry", () => {
  it("registers channels and reports membership", () => {
    const reg = new ChannelRegistry();
    reg.register("cli");
    expect(reg.has("cli")).toBe(true);
    expect(reg.has("telegram")).toBe(false);
  });

  it("listChannels returns the registered set", () => {
    const reg = new ChannelRegistry();
    reg.register("cli");
    reg.register("telegram");
    expect(reg.listChannels().sort()).toEqual(["cli", "telegram"]);
  });

  it("throws on duplicate registration (loud failure preferred over silent overwrite)", () => {
    const reg = new ChannelRegistry();
    reg.register("cli");
    expect(() => reg.register("cli")).toThrow(/already registered/);
  });
});
