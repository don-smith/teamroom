import type { BusEvent } from "../types.js";
import type { EventFilter, NotifyBus } from "./notify-bus.js";

interface Subscriber {
  filter: EventFilter | undefined;
  queue: BusEvent[];
  resolver: (() => void) | null;
  closed: boolean;
}

export class InMemoryBus implements NotifyBus {
  private subscribers: Subscriber[] = [];
  private closedFlag = false;

  async publish(event: BusEvent): Promise<void> {
    if (this.closedFlag) return;
    for (const sub of this.subscribers) {
      if (sub.closed) continue;
      if (sub.filter && !sub.filter(event)) continue;
      sub.queue.push(event);
      if (sub.resolver) {
        const r = sub.resolver;
        sub.resolver = null;
        r();
      }
    }
  }

  subscribe(filter?: EventFilter): AsyncIterable<BusEvent> {
    const sub: Subscriber = { filter, queue: [], resolver: null, closed: false };
    this.subscribers.push(sub);

    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            if (sub.queue.length > 0) {
              yield sub.queue.shift()!;
              continue;
            }
            if (sub.closed || self.closedFlag) return;
            await new Promise<void>((resolve) => {
              sub.resolver = resolve;
            });
          }
        } finally {
          sub.closed = true;
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closedFlag = true;
    for (const sub of this.subscribers) {
      sub.closed = true;
      if (sub.resolver) {
        sub.resolver();
        sub.resolver = null;
      }
    }
  }
}
