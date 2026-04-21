import type { MailDispatcher } from "../../src/mail-dispatcher/mail-dispatcher.js";

export interface CliChannelAdapterDeps {
  dispatcher: MailDispatcher;
}

export interface CliSendInput {
  user: string;
  target: string;
  body: string;
  threadId?: string | null;
}

/**
 * Test-only helper: injects CLI-flavored mail directly into the dispatcher
 * for integration tests. Production CLI flows through the chat WebSocket
 * and does not use this adapter.
 *
 * Relocated from src/channels/cli.ts in M4.5 close-out cleanup to make
 * the test-only purpose explicit.
 */
export class CliChannelAdapter {
  constructor(private readonly deps: CliChannelAdapterDeps) {}

  send(input: CliSendInput): { threadId: string; rowIds: string[] } {
    return this.deps.dispatcher.sendMail({
      from: `channel:cli:${input.user}`,
      to: [`agent:${input.target}`],
      body: input.body,
      threadId: input.threadId ?? null,
    });
  }
}
