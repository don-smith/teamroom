import type { BusEvent } from "../types.js";

export type EventFilter = (event: BusEvent) => boolean;

export interface NotifyBus {
  publish(event: BusEvent): Promise<void>;
  subscribe(filter?: EventFilter): AsyncIterable<BusEvent>;
  close(): Promise<void>;
}
