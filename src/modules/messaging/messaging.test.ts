import { describe, expect, it } from "bun:test";
import { JsonLinesLogger } from "../../logger/logger.js";
import { SystemClock } from "../../clock/clock.js";
import { composeMessaging } from "./messaging.js";

describe("composeMessaging", () => {
  it("returns an EventBus that publishes and subscribes", () => {
    const logger = new JsonLinesLogger(new SystemClock(), () => {}, { component: "test" });
    const messaging = composeMessaging({ logger });
    const payloads: unknown[] = [];
    messaging.eventBus.subscribe("foo", (payload) => {
      payloads.push(payload);
    });
    messaging.eventBus.publish("foo", { x: 1 });
    expect(payloads).toEqual([{ x: 1 }]);
  });
});
