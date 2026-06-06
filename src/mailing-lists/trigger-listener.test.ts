import { describe, expect, it } from "bun:test";
import { MailingListTriggerListener } from "./trigger-listener.js";
import { MailingListRegistry } from "./registry.js";
import { EventBus } from "../bus/event-bus.js";
import type { SendMailInput, SendMailResult } from "../mail-dispatcher/mail-dispatcher.js";

class FakeDispatcher {
  public readonly sent: SendMailInput[] = [];

  sendMail(input: SendMailInput): SendMailResult {
    this.sent.push(input);
    return { threadId: input.threadId ?? "thread-1", rowIds: [] };
  }
}

describe("MailingListTriggerListener", () => {
  it("forwards triggering bus events to the dispatcher as a system-sent mail", () => {
    const registry = new MailingListRegistry(
      [{ name: "harness-activity", triggers: ["turn.started"] }],
      [],
    );
    const bus = new EventBus();
    const dispatcher = new FakeDispatcher();

    new MailingListTriggerListener({
      bus,
      registry,
      dispatcher,
      formatBody: (eventType, payload) => `${eventType}: ${JSON.stringify(payload)}`,
    });

    bus.publish("turn.started", { agentId: "X", turnId: "T" });

    expect(dispatcher.sent).toEqual([{
      from: "system",
      to: ["list:harness-activity"],
      subject: "turn.started",
      body: 'turn.started: {"agentId":"X","turnId":"T"}',
      threadId: null,
    }]);
  });

  it("honors a custom subject formatter", () => {
    const registry = new MailingListRegistry(
      [{ name: "l", triggers: ["e"] }],
      [],
    );
    const bus = new EventBus();
    const dispatcher = new FakeDispatcher();
    new MailingListTriggerListener({
      bus,
      registry,
      dispatcher,
      formatBody: () => "",
      formatSubject: (ev) => `[${ev}]`,
    });

    bus.publish("e", {});

    expect(dispatcher.sent).toHaveLength(1);
    expect(dispatcher.sent[0]).toMatchObject({ subject: "[e]" });
  });

  it("ignores events that trigger no lists", () => {
    const registry = new MailingListRegistry(
      [{ name: "l", triggers: ["e"] }],
      [],
    );
    const bus = new EventBus();
    const dispatcher = new FakeDispatcher();
    new MailingListTriggerListener({ bus, registry, dispatcher, formatBody: () => "" });

    bus.publish("unrelated", {});

    expect(dispatcher.sent).toHaveLength(0);
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
    const dispatcher = new FakeDispatcher();
    new MailingListTriggerListener({ bus, registry, dispatcher, formatBody: () => "" });

    bus.publish("e", {});

    expect(dispatcher.sent).toHaveLength(2);
    const toValues = dispatcher.sent.map((mail) => mail.to);
    expect(toValues).toEqual([["list:l1"], ["list:l2"]]);
  });
});
