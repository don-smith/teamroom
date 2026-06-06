import { describe, it, expect } from "bun:test";
import { TokenRegistry } from "./token-registry.js";

const baseEntry = {
  agentId: "a", turnId: "t", traceId: "tr", provider: "anthropic" as const, model: "m",
};

describe("TokenRegistry", () => {
  it("mintToken returns a non-empty string and lookup returns the entry", () => {
    const r = new TokenRegistry(() => "fixed-token");
    const tok = r.mint(baseEntry);
    expect(tok).toBe("fixed-token");
    expect(r.lookup(tok)).toEqual(baseEntry);
  });

  it("evict removes the entry; lookup-after-evict returns undefined", () => {
    const r = new TokenRegistry();
    const tok = r.mint(baseEntry);
    r.evict(tok);
    expect(r.lookup(tok)).toBeUndefined();
  });

  it("concurrent mints produce distinct tokens", () => {
    const r = new TokenRegistry();
    const tokens = new Set([r.mint(baseEntry), r.mint(baseEntry), r.mint(baseEntry)]);
    expect(tokens.size).toBe(3);
  });
});
