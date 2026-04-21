import { describe, expect, it, vi } from "vitest";
import { JsonLinesLogger } from "../../logger/logger.js";
import { SystemClock } from "../../clock/clock.js";
import { composeMessaging } from "./messaging.js";

describe("composeMessaging", () => {
  it("returns an EventBus that publishes and subscribes", () => {
    const logger = new JsonLinesLogger(new SystemClock(), () => {}, { component: "test" });
    const messaging = composeMessaging({ logger });
    const cb = vi.fn();
    messaging.eventBus.subscribe("foo", cb);
    messaging.eventBus.publish("foo", { x: 1 });
    expect(cb).toHaveBeenCalledWith({ x: 1 });
  });
});
