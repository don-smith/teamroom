import { describe, expect, it } from "bun:test";
import { composeMail } from "./mail.js";
import { composeStorage } from "../storage/storage.js";
import { JsonLinesLogger } from "../../logger/logger.js";
import { ControllableClock } from "../../clock/clock.js";

describe("composeMail", () => {
  it("starts the query server on an ephemeral port", async () => {
    const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });
    const storage = composeStorage({ dataDir: ":memory:" });
    const mail = await composeMail({ storage, logger, port: 0 });
    expect(mail.port).toBeGreaterThan(0);
    await mail.stop();
    storage.close();
  });
});
