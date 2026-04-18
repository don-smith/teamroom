# `agent-runtime/` — what runs inside each container

The shim that reads a single stdin JSON envelope, loads conversation history from `/store/conversation.jsonl`, calls the Anthropic API via an injected `AnthropicClient`, streams `type: "reply"` events on stdout, appends to the conversation file, and exits.

`runtime.ts` holds the pure turn function (DI-testable). `main.ts` wires the real SDK. `session-store.ts` owns the conversation file. Baked into each agent image at build time.

LangGraph is the intended long-term replacement for this shim — see spec §9.1.
