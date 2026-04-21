import { QueryServer } from "./query-server.js";
import type { Storage } from "../storage/storage.js";
import type { Logger } from "../../logger/logger.js";

export interface Mail {
  port: number;
  stop: () => Promise<void>;
}

export interface MailDeps {
  storage: Storage;
  logger: Logger;
  port: number;
}

/**
 * Compose the mail read surface: a WebSocket server for inbox/thread
 * queries. Distinct from `mcp-mail` (the in-process agent-facing mail
 * system); this is the external read view onto it.
 */
export async function composeMail(deps: MailDeps): Promise<Mail> {
  const server = new QueryServer({
    storage: deps.storage,
    logger: deps.logger,
    port: deps.port,
  });
  await server.start();
  return {
    port: server.port,
    stop: () => server.stop(),
  };
}
