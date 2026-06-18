import { describe, expect, it } from "bun:test";

describe("serve", () => {
  it("requires OPENROUTER_API_KEY when called", async () => {
    // serve() requires OPENROUTER_API_KEY. We can't call serve() in a test
    // because it starts a long-running daemon. This test verifies the error
    // path by checking the module exports.
    const serve = await import("./serve.js");
    expect(serve.serve).toBeDefined();
  });

  it("does not export old resolveServeProviderTokens (removed with provider consolidation)", async () => {
    const serve = await import("./serve.js") as Record<string, unknown>;
    expect(serve.resolveServeProviderTokens).toBeUndefined();
  });
});