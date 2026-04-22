---
name: Team Room — default to the reference SDK when implementing a third-party protocol
description: For any third-party protocol (MCP, OAuth, etc.), use the reference SDK rather than hand-rolling. Protocols evolve; SDKs absorb that drift. Hand-rolling is reserved for transports the SDK can't provide, with a documented blocker-grade reason
type: feedback
---

When implementing a server or client for a third-party protocol — MCP, OAuth flows, provider APIs, anything with a spec maintained by an external body — **default to the reference SDK** rather than hand-rolling the wire shape.

Protocols evolve. SDK maintainers track that evolution. Hand-rolled code drifts silently, and the drift surfaces as schema-validation errors, permission-model surprises, or deprecation-era breakage — all of which would have been absorbed by the SDK for free.

**Why:** Two milestones have now produced this lesson:

- **M2** used `@anthropic-ai/sdk` on the Anthropic client side of the model proxy. No regret; the SDK's type definitions and request-shape enforcement caught several fixture-level errors before they became runtime bugs.
- **M4** hand-rolled the MCP server side (`src/mail-mcp/server.ts`), using `node:http` + manual JSON-RPC handlers, to avoid the stateful-session-id dance in `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`. The cost: three post-manual-test fix commits for MCP shape bugs — `{type:"json"}` is not a valid content type; `structuredContent` must be a plain object (not an array); tool naming convention is `mcp__<server>__<tool>`. Each was a spec quirk the SDK enforces at the boundary but hand-rolled code had to re-derive. Total fix-bugs time substantially exceeded what SDK adoption would have cost up-front.

The asymmetry that made the M4 cost especially visible: the client side *was* SDK-backed (via `claude-agent-sdk`'s `mcpServers` option, which handles the MCP client protocol entirely internally). Only the server was hand-rolled. One side carried the protocol-drift tax; the other didn't.

User comment at M4 retro (2026-04-21): *"my preference would absolutely be to use the SDK because this is also a fairly new protocol. It's only been out for a couple of years tops and it's most likely to change. So we don't want to be tracking that with hand rolled code."*

**How to apply:**

- **Starting work on a protocol server or client?** Look for the reference SDK first. For MCP specifically: `@modelcontextprotocol/sdk`. For Anthropic: `@anthropic-ai/sdk`. For OAuth flows: prefer battle-tested libraries over custom flows.
- **Reserve hand-rolling for transports or capabilities the SDK genuinely doesn't support.** Document the blocker-grade reason in the code or a followup — e.g., "the SDK's transport requires stateful sessions, which don't fit our per-spawn token model, and no stateless mode is available." If the "blocker" is avoiding learning curve, that's not a blocker.
- **At spec time**, when a plan task has a "hand-roll or SDK" choice point (like M4 Task 5 did), default to SDK in the spec itself. Let hand-roll be the exception that has to argue for itself, not the path of least resistance.
- **When reviewing a PR that hand-rolls a protocol layer**, ask explicitly: "what does the SDK not provide here?" A clean answer confirms the choice; a vague answer is the signal to reconsider.
- **Protocol-quirk memory entries are an anti-pattern.** If you find yourself wanting to document "MCP content types are limited to text/image/resource..." as a memory entry, that's evidence you're hand-rolling instead of using the SDK. The SDK is the documentation, enforced.

**Source:** M2 Anthropic SDK use (first sighting, no regret); M4 hand-rolled MCP server reversal (second sighting, documented cost). M4 retro §2 "hand-rolling the MCP server side was false economy"; action item executed during M4.5 (MCP SDK retrofit shipped).
