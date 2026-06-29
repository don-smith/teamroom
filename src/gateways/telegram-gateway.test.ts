import { describe, expect, test } from "bun:test";
import { EventBus } from "../bus/event-bus.js";
import { ControllableClock } from "../clock/clock.js";
import { CapturingLogger } from "../logger/logger.js";
import { composeTelegram, type TelegramGatewayDeps } from "./telegram-gateway.js";

function depsWith(deliverInbound: TelegramGatewayDeps["deliverInbound"]): TelegramGatewayDeps {
  return {
    bus: new EventBus(),
    deliverInbound,
    logger: new CapturingLogger(new ControllableClock("2026-06-23T00:00:00.000Z")),
    bots: [{ agent: "doc", tokenEnvVar: "TELEGRAM_TOKEN", repo: "my-repo" }],
    genId: () => "gen-id",
    openai: undefined,
  };
}

describe("TelegramGateway", () => {
  test("deliverInbound accepts the inbound delivery shape", () => {
    const delivered: Array<TelegramGatewayDeps["deliverInbound"] extends (msg: infer Msg) => void ? Msg : never> = [];
    const deps = depsWith((msg) => {
      delivered.push({ ...msg });
    });

    composeTelegram(deps);
    deps.deliverInbound({
      from: "channel:telegram:doc:12345",
      to: ["agent:doc"],
      body: "hello",
      threadId: null,
      cc: [],
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      from: "channel:telegram:doc:12345",
      to: ["agent:doc"],
      body: "hello",
      threadId: null,
      cc: [],
    });
  });

  test("composeTelegram accepts new TelegramGatewayDeps shape", () => {
    const gateway = composeTelegram(depsWith(() => {}));

    expect(gateway).toBeDefined();
    expect(typeof gateway.start).toBe("function");
    expect(typeof gateway.stop).toBe("function");
  });
});
