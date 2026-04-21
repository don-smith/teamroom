# Modules

Composition modules for the daemon. Each module exposes a single
`compose<Name>(deps): <Name>` factory function and a `<Name>` interface
for the things it returns. `startDaemon` and `composeIntegrationHarness`
both call these factories with different concrete deps; composition
parity between test and prod is by construction.

See [`docs/specs/2026-04-21-m4.5-ai-native-harness-design.md`](../../docs/specs/2026-04-21-m4.5-ai-native-harness-design.md)
for the architecture rationale.

## Files

- [`observability/`](observability/) — clock, log sink, root logger.
- [`storage/`](storage/) — DB connection, migrations, repos.
- [`messaging/`](messaging/) — `EventBus`.
- [`mcp-mail/`](mcp-mail/) — MCP tool registry (uses `@modelcontextprotocol/sdk`); wired into `MailMcpServer`.
- [`model-proxy/`](model-proxy/) — `LocalModelProxy` factory + provider adapters.
- [`session-management/`](session-management/) — session lifecycle; subscribes to bus events to drive agent turns.
- [`channels/`](channels/) — `ChannelRegistry`, `ChatServer` (WebSocket); exposes the chat port.
- [`mail/`](mail/) — `QueryServer` (WebSocket); exposes the mail query port.

## Related

- Parent: [`../README.md`](../README.md)
- Spec: [`../../docs/specs/2026-04-21-m4.5-ai-native-harness-design.md`](../../docs/specs/2026-04-21-m4.5-ai-native-harness-design.md)
