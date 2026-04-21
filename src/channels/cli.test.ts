import { describe, expect, it, vi } from "vitest";
import { CliChannelAdapter } from "./cli.js";
import type { MailDispatcher } from "../mail-dispatcher/mail-dispatcher.js";

describe("CliChannelAdapter", () => {
  it("formats cli:<user> → agent:<target> and forwards to the dispatcher", () => {
    const sendMail = vi.fn().mockReturnValue({ threadId: "T1", rowIds: [] });
    const dispatcher = { sendMail } as unknown as MailDispatcher;
    const adapter = new CliChannelAdapter({ dispatcher });

    adapter.send({ user: "don", target: "claude-assistant", body: "hello" });

    expect(sendMail).toHaveBeenCalledWith({
      from: "channel:cli:don",
      to: ["agent:claude-assistant"],
      body: "hello",
      threadId: null,
    });
  });

  it("passes an explicit thread id through", () => {
    const sendMail = vi.fn().mockReturnValue({ threadId: "T2", rowIds: [] });
    const dispatcher = { sendMail } as unknown as MailDispatcher;
    const adapter = new CliChannelAdapter({ dispatcher });

    adapter.send({ user: "don", target: "a", body: "x", threadId: "T2" });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "T2" }),
    );
  });
});
