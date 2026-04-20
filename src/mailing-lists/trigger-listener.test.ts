import { describe, expect, it, vi } from "vitest";
import { MailingListTriggerListener } from "./trigger-listener.js";
import { MailingListRegistry } from "./registry.js";
import { EventBus } from "../bus/event-bus.js";
import type { MailDispatcher } from "../mail-dispatcher/mail-dispatcher.js";

describe("MailingListTriggerListener", () => {
  it("forwards triggering bus events to the dispatcher as a system-sent mail", () => {
    const registry = new MailingListRegistry(
      [{ name: "harness-activity", triggers: ["turn.started"] }],
      [],
    );
    const bus = new EventBus();
    const dispatcher = { sendMail: vi.fn() } as unknown as MailDispatcher;

    new MailingListTriggerListener({
      bus,
      registry,
      dispatcher,
      formatBody: (eventType, payload) => `${eventType}: ${JSON.stringify(payload)}`,
    });

    bus.publish("turn.started", { agentId: "X", turnId: "T" });

    expect(dispatcher.sendMail).toHaveBeenCalledWith({
      from: "system",
      to: ["list:harness-activity"],
      subject: "turn.started",
      body: 'turn.started: {"agentId":"X","turnId":"T"}',
      threadId: null,
    });
  });

  it("honors a custom subject formatter", () => {
    const registry = new MailingListRegistry(
      [{ name: "l", triggers: ["e"] }],
      [],
    );
    const bus = new EventBus();
    const dispatcher = { sendMail: vi.fn() } as unknown as MailDispatcher;
    new MailingListTriggerListener({
      bus,
      registry,
      dispatcher,
      formatBody: () => "",
      formatSubject: (ev) => `[${ev}]`,
    });

    bus.publish("e", {});

    expect(dispatcher.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "[e]" }),
    );
  });

  it("ignores events that trigger no lists", () => {
    const registry = new MailingListRegistry(
      [{ name: "l", triggers: ["e"] }],
      [],
    );
    const bus = new EventBus();
    const dispatcher = { sendMail: vi.fn() } as unknown as MailDispatcher;
    new MailingListTriggerListener({ bus, registry, dispatcher, formatBody: () => "" });

    bus.publish("unrelated", {});

    expect(dispatcher.sendMail).not.toHaveBeenCalled();
  });

  it("fans out to multiple lists triggered by the same event", () => {
    const registry = new MailingListRegistry(
      [
        { name: "l1", triggers: ["e"] },
        { name: "l2", triggers: ["e"] },
      ],
      [],
    );
    const bus = new EventBus();
    const dispatcher = { sendMail: vi.fn() } as unknown as MailDispatcher;
    new MailingListTriggerListener({ bus, registry, dispatcher, formatBody: () => "" });

    bus.publish("e", {});

    expect(dispatcher.sendMail).toHaveBeenCalledTimes(2);
    const toValues = (dispatcher.sendMail as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0].to);
    expect(toValues).toEqual([["list:l1"], ["list:l2"]]);
  });
});
