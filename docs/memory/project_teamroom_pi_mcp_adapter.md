---
name: Team Room — pi-mcp-adapter is available for MCP integration
description: The community pi-mcp-adapter extension (nicopreme v2.10.0) is installed as an npm dependency but not yet wired into SDK agent sessions
type: project
---

The community MCP adapter for Pi — [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter) by nicopreme (v2.10.0) — is installed as an npm dependency. It provides proper MCP server integration for Pi, including tool discovery via `listTools`, lazy server connections, OAuth flows, and `directTools` mode for registering MCP tools as first-class Pi tools.

**Current state:** Installed but not wired. Pi SDK agent sessions currently use hand-rolled MCP tool wrappers in `src/agent-runtime/pi-mail-tools.ts` via the extension factory pattern. This works but duplicates tool schemas between the Pi side and the MCP server side.

**When to switch:** When adding a second MCP server (e.g., memory, scheduling), or when the tool schema duplication becomes a maintenance burden. The adapter would replace `pi-mail-tools.ts` entirely — you'd generate a `.pi/mcp.json` pointing at the mail MCP server with `directTools: true`, and the adapter handles registration.

**How to apply:**
- For now, keep the extension-factory pattern — it's simple and works
- When the next MCP server is added, evaluate switching to pi-mcp-adapter
- The adapter is available as `import mcpAdapter from "pi-mcp-adapter"` and exposes an `ExtensionAPI` factory compatible with the SDK's `DefaultResourceLoader`