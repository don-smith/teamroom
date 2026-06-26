import { LocalModelProxy } from "../../model-proxy/local-model-proxy.js";
import { TokenRegistry } from "../../model-proxy/token-registry.js";
import { OpenAICompatAdapter } from "../../model-proxy/adapters/openai-compat-adapter.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../logger/logger.js";

export interface ModelProxyModule {
  tokenRegistry: TokenRegistry;
  modelProxy: LocalModelProxy;
  port: number;
  modelBaseUrl: string;
  stop: () => Promise<void>;
}

export interface ModelProxyDeps {
  logger: Logger;
  openrouter: { upstreamUrl: string; realKey: string };
  /** Shared secret for verifying daemon-signed tokens (HMAC). */
  sharedSecret?: string;
}

export async function composeModelProxy(deps: ModelProxyDeps): Promise<ModelProxyModule> {
  const tokenRegistry = new TokenRegistry(randomUUID, deps.sharedSecret);
  const adapters = {
    openrouter: new OpenAICompatAdapter({
      id: "openrouter",
      upstreamUrl: deps.openrouter.upstreamUrl,
      auth: { mode: "bearer", key: deps.openrouter.realKey },
      defaultHeaders: {
        "HTTP-Referer": "https://teamroom.local",
        "X-Title": "Team Room",
      },
    }),
  };
  const modelProxy = new LocalModelProxy({
    registry: tokenRegistry,
    adapters,
    logger: deps.logger,
  });
  const proxyInfo = await modelProxy.start();
  const modelBaseUrl = `http://host.docker.internal:${proxyInfo.port}`;
  deps.logger.info("model proxy started", { port: proxyInfo.port });
  return {
    tokenRegistry,
    modelProxy,
    port: proxyInfo.port,
    modelBaseUrl,
    stop: () => modelProxy.stop(),
  };
}