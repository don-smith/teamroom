import type { EventBus } from "../bus/event-bus.js";
import type { MailingListRegistry } from "./registry.js";
import type { SendMailInput, SendMailResult } from "../mail-dispatcher/mail-dispatcher.js";

export interface TriggerMailDispatcher {
  sendMail(input: SendMailInput): SendMailResult;
}

export interface TriggerListenerDeps {
  bus: EventBus;
  registry: MailingListRegistry;
  dispatcher: TriggerMailDispatcher;
  /** Formats an event payload into a human-readable mail body. */
  formatBody: (eventType: string, payload: unknown) => string;
  /**
   * Optional subject formatter. If omitted, the subject is the event type
   * verbatim (useful for inbox readability).
   */
  formatSubject?: (eventType: string, payload: unknown) => string;
}

/**
 * Subscribes to every bus event declared as a list trigger in the registry,
 * and on fire dispatches a `system`-originated mail to the corresponding
 * `list:<name>` address. Dispatcher handles list expansion, so each
 * subscriber receives one row in their inbox.
 *
 * Stateless after construction — no need to tear it down except at daemon
 * shutdown (the dispatcher outlives individual sessions anyway).
 */
export class MailingListTriggerListener {
  constructor(deps: TriggerListenerDeps) {
    for (const ev of deps.registry.allTriggers()) {
      deps.bus.subscribe(ev, (payload) => {
        const lists = deps.registry.listsTriggeredBy(ev);
        for (const listName of lists) {
          deps.dispatcher.sendMail({
            from: "system",
            to: [`list:${listName}`],
            subject: deps.formatSubject ? deps.formatSubject(ev, payload) : ev,
            body: deps.formatBody(ev, payload),
            threadId: null,
          });
        }
      });
    }
  }
}
