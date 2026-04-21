import { describe, expect, it } from "vitest";
import { parseAddress, formatAddress, type Address } from "./address.js";

describe("address", () => {
  const cases: [string, Address][] = [
    ["agent:claude-assistant", { kind: "agent", name: "claude-assistant" }],
    ["list:harness-activity", { kind: "list", name: "harness-activity" }],
    ["channel:cli:don", { kind: "channel", channel: "cli", externalId: "don" }],
    ["channel:telegram:12345", { kind: "channel", channel: "telegram", externalId: "12345" }],
  ];

  for (const [str, addr] of cases) {
    it(`parses ${str}`, () => {
      expect(parseAddress(str)).toEqual(addr);
    });
    it(`formats ${str}`, () => {
      expect(formatAddress(addr)).toBe(str);
    });
  }

  it("throws on unknown top-level prefix", () => {
    expect(() => parseAddress("system:foo")).toThrow(/unknown address prefix/);
  });

  it("throws on malformed channel address (missing externalId)", () => {
    expect(() => parseAddress("channel:cli")).toThrow(/invalid channel address/);
  });

  it("parses channel addresses leniently — registry validation happens at dispatch", () => {
    expect(parseAddress("channel:bogus:foo")).toEqual({
      kind: "channel",
      channel: "bogus",
      externalId: "foo",
    });
  });
});
