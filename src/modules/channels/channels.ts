import { ChannelRegistry } from "./channel-registry.js";
import { ChatServer } from "./chat-server.js";
import type { Storage } from "../storage/storage.js";
import type { Messaging } from "../messaging/messaging.js";
import type { McpMail } from "../mcp-mail/mcp-mail.js";
import type { Logger } from "../../logger/logger.js";

export interface Channels {
  registry: ChannelRegistry;
  port: number;
  stop: () => Promise<void>;
}

export interface ChannelsDeps {
  storage: Storage;
  messaging: Messaging;
  mcpMail: McpMail;
  logger: Logger;
  port: number;
}

/**
 * Compose the channels stack: ChannelRegistry pre-populated with the built-in
 * channels (cli for now), plus a ChatServer bus↔WebSocket bridge. Returns
 * the bound port and a stop() that releases the WebSocket subscription and
 * tears down sockets cleanly.
 */
export async function composeChannels(deps: ChannelsDeps): Promise<Channels> {
  const registry = new ChannelRegistry();
  registry.register("cli");

  const server = new ChatServer({
    storage: deps.storage,
    messaging: deps.messaging,
    mcpMail: deps.mcpMail,
    registry,
    logger: deps.logger,
    port: deps.port,
  });
  await server.start();

  return {
    registry,
    port: server.port,
    stop: () => server.stop(),
  };
}
