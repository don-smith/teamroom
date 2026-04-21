import { EventBus } from "../../bus/event-bus.js";
import type { Logger } from "../../logger/logger.js";

export interface Messaging {
  eventBus: EventBus;
}

export interface MessagingDeps {
  logger: Logger;
}

export function composeMessaging(deps: MessagingDeps): Messaging {
  return { eventBus: new EventBus(deps.logger) };
}
