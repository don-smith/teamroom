import { describe, it, expect } from "vitest";
import { AnthropicLlmClient } from "./anthropic-llm-client.js";
import type { LlmClient } from "./runtime.js";

// The full behavior of this client is exercised by
// tests/integration/anthropic-oauth-real.test.ts, which runs the actual
// claude-agent-sdk subprocess against the real proxy + real Anthropic. There's
// nothing meaningful to test in isolation here without mocking the SDK, which
// we don't do (real-impl-tests-only convention). These two tests cover the
// shape contract.

describe("AnthropicLlmClient", () => {
  it("is constructible with no options", () => {
    const client = new AnthropicLlmClient();
    expect(client).toBeInstanceOf(AnthropicLlmClient);
  });

  it("implements the LlmClient interface (compile-time guarded)", () => {
    // Assigning to LlmClient at compile time forces structural compliance —
    // if the createMessage signature drifts, this won't typecheck.
    const client: LlmClient = new AnthropicLlmClient();
    expect(typeof client.createMessage).toBe("function");
  });
});
