import type { Logger } from "../logger/logger.js";

export function installSafetyNets(logger: Logger): void {
  process.on("uncaughtException", (err) => {
    logger.fatal("uncaughtException (daemon does not exit)", {
      error: String(err),
      stack: err?.stack,
    });
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal("unhandledRejection (daemon does not exit)", {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
