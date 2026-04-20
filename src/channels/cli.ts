import type { MailDispatcher } from "../mail-dispatcher/mail-dispatcher.js";

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
 * Thin bridge between the CLI surface (`teamroom send <target> <body>`) and
 * the mail dispatcher. Inbound CLI messages enter the mail substrate as a
 * `cli:<user> → agent:<target>` send; outbound CLI messages flow back
 * through the dispatcher when agents reply to `cli:<user>`.
 *
 * Kept as its own module (rather than inline in the daemon) so the next
 * channel (Telegram, Slack, etc.) can slot in with the same shape.
 */
export class CliChannelAdapter {
  constructor(private readonly deps: CliChannelAdapterDeps) {}

  send(input: CliSendInput): { threadId: string; rowIds: string[] } {
    return this.deps.dispatcher.sendMail({
      from: `cli:${input.user}`,
      to: [`agent:${input.target}`],
      body: input.body,
      threadId: input.threadId ?? null,
    });
  }
}
