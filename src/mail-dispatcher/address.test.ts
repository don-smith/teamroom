import { describe, expect, it } from "vitest";
import { parseAddress, formatAddress, type Address } from "./address.js";

describe("parseAddress", () => {
  it.each([
    ["agent:claude-assistant", { kind: "agent" as const, name: "claude-assistant" }],
    ["cli:don", { kind: "cli" as const, user: "don" }],
    ["list:harness-activity", { kind: "list" as const, name: "harness-activity" }],
  ])("parses %s", (input, expected) => {
    expect(parseAddress(input)).toEqual(expected);
  });

  it.each(["no-prefix", ":empty-prefix", "agent:", "xxx:foo"])(
    "rejects %s",
    (s) => {
      expect(() => parseAddress(s)).toThrow();
    },
  );

  it("preserves colons in the name portion (after the first one)", () => {
    // We only split on the first colon. Future address kinds (e.g. urls) are free.
    expect(parseAddress("agent:a:b:c")).toEqual({ kind: "agent", name: "a:b:c" });
  });
});

describe("formatAddress", () => {
  it("round-trips parsed addresses", () => {
    const addrs: Address[] = [
      { kind: "agent", name: "a" },
      { kind: "cli", user: "u" },
      { kind: "list", name: "l" },
    ];
    for (const a of addrs) {
      expect(parseAddress(formatAddress(a))).toEqual(a);
    }
  });
});
