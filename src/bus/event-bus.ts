import type { Logger } from "../logger/logger.js";

/**
 * Typed in-process publish/subscribe for M4 signals (mail delivered/sent,
 * tool calls, CLI channel events, session lifecycle, turn lifecycle).
 *
 * Not durable. Crashes drop in-flight events. Delivery is synchronous within
 * `publish` — handlers run to completion before publish returns, in
 * subscription order. A throwing handler does not derail the others; the bus
 * logs and keeps delivering.
 *
 * Use this for notifications (“something changed; check your inbox / reset
 * your timer”). Use the DB for anything that must survive a crash.
 */
export type EventType = string;
export type EventHandler<P = unknown> = (payload: P) => void;

export class EventBus {
  private readonly handlers = new Map<EventType, Set<EventHandler>>();

  constructor(private readonly logger?: Logger) {}

  subscribe<P = unknown>(type: EventType, handler: EventHandler<P>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as EventHandler);
    return () => {
      const s = this.handlers.get(type);
      if (!s) return;
      s.delete(handler as EventHandler);
      if (s.size === 0) this.handlers.delete(type);
    };
  }

  publish<P = unknown>(type: EventType, payload: P): void {
    const set = this.handlers.get(type);
    if (!set) return;
    // Snapshot so a handler that unsubscribes mid-publish doesn't skip peers.
    const snapshot = [...set];
    for (const h of snapshot) {
      try {
        h(payload);
      } catch (err) {
        this.logger?.warn("event-bus.handler.error", {
          type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
