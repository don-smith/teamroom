---
name: Team Room — no skipped tests; pass means full end-to-end success
description: Integration tests run on every npm test, no opt-in gates, no silent skips. Failure preconditions surface as visible failures with remediation messages, not skipped tests. "Passing" requires the full success criterion (e.g., HTTP 200 + valid content), never an intermediate signal like "auth was accepted but request was rate-limited."
type: feedback
---

Two related testing preferences that came up sharply during M2 OAuth debugging:

**(a) No skipped tests.** Integration tests should run on every `npm test`, even when they take longer / hit real APIs / cost a small amount of subscription quota. No `RUN_REAL_INTEGRATION_TESTS=1`-style opt-in gates — those are too easy to forget, defeating the point of having a test. If a test legitimately can't run (e.g., LM Studio not reachable, no Anthropic credential), it should **fail loudly with a remediation message** ("set CLAUDE_CODE_OAUTH_TOKEN in .env, or log into Claude Code, or place ~/.claude/.credentials.json"), not silently skip.

**(b) Pass means PASS — full end-to-end success.** Don't soften assertions to "pass" on intermediate signals. Concrete example from M2: when an integration test got HTTP 429 from Anthropic, I (Claude) called it a pass on the basis that "auth was accepted, only rate-limiting bounced it." User pushback: "If we would have run the integration test, you said they passed, but if the request was rejected because of rate limiting, then that's not a pass. Just because it looks like the auth was accepted. Let's be clear about what passing looks like." Tests must assert the full success criterion (status 200 + valid response body, codeword recall, etc.).

**Why:** A skipped test is a test that has been silently disarmed — it's worse than no test because the suite reports green while regressions slip through. A "passing" test that only checks a precursor signal is the same failure mode in finer-grain form. The discipline is: tests assert what they're supposed to verify; if they can't, they fail visibly.

**How to apply:**
- When writing an integration test that hits a real service, gate ONLY on credential discovery (and even then, fail loudly when missing — don't skip). Never add an opt-in env var.
- When asserting a test's result, assert the full success path — don't widen the assertion to accept rate limits, partial responses, or "the API returned something." If those edge cases need to be tolerated separately, they should be their own test cases (e.g., "rate limit handling" as an explicit test).
- If a test starts asserting on an intermediate signal because the full path is flaky, fix the flake — don't water down the assertion.
- Apply this even when it would be more convenient to add a gate (e.g., "this test costs $0.01 to run") — the cost of forgotten gates is much higher than the API spend.
