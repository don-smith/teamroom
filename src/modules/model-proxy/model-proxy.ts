import { LocalModelProxy } from "../../model-proxy/local-model-proxy.js";
import { TokenRegistry } from "../../model-proxy/token-registry.js";
import type { ProviderAdapter } from "../../model-proxy/adapters/adapter.js";
import { OpenAICompatAdapter } from "../../model-proxy/adapters/openai-compat-adapter.js";
import { AnthropicAdapter } from "../../model-proxy/adapters/anthropic-adapter.js";
import { AnthropicOAuthCache } from "../../model-proxy/adapters/anthropic-oauth-cache.js";
import type { Logger } from "../../logger/logger.js";
import type { Provider } from "../../types.js";

export type AnthropicCreds =
  | { mode: "api-key"; apiKey: string }
  | { mode: "oauth"; oauthToken: string };

export interface ModelProxyModule {
  tokenRegistry: TokenRegistry;
  modelProxy: LocalModelProxy;
  port: number;
  modelBaseUrl: string;
  anthropicAdapterPresent: boolean;
  stop: () => Promise<void>;
}

export interface ModelProxyDeps {
  logger: Logger;
  lmStudio: { upstreamUrl: string; realKey: string };
  ollama: { upstreamUrl: string };
  anthropic: AnthropicCreds | null;
}

export async function composeModelProxy(deps: ModelProxyDeps): Promise<ModelProxyModule> {
  const tokenRegistry = new TokenRegistry();
  const adapters: Partial<Record<Provider, ProviderAdapter>> = {
    "lm-studio": new OpenAICompatAdapter({
      id: "lm-studio",
      upstreamUrl: deps.lmStudio.upstreamUrl,
      auth: { mode: "bearer", key: deps.lmStudio.realKey },
    }),
    ollama: new OpenAICompatAdapter({
      id: "ollama",
      upstreamUrl: deps.ollama.upstreamUrl,
      auth: { mode: "none" },
    }),
  };
  const anthropicAdapterPresent = deps.anthropic !== null;
  if (deps.anthropic) {
    adapters.anthropic = buildAnthropicAdapter(deps.anthropic);
  }
  const modelProxy = new LocalModelProxy({
    registry: tokenRegistry,
    adapters: adapters as Record<Provider, ProviderAdapter>,
    logger: deps.logger,
  });
  const proxyInfo = await modelProxy.start();
  const modelBaseUrl = `http://host.docker.internal:${proxyInfo.port}`;
  deps.logger.info("model proxy started", { port: proxyInfo.port, anthropicAdapterPresent });
  return {
    tokenRegistry,
    modelProxy,
    port: proxyInfo.port,
    modelBaseUrl,
    anthropicAdapterPresent,
    stop: () => modelProxy.stop(),
  };
}

function buildAnthropicAdapter(creds: AnthropicCreds): AnthropicAdapter {
  if (creds.mode === "api-key") {
    return new AnthropicAdapter({ auth: { mode: "api-key", apiKey: creds.apiKey } });
  }
  const cache = new AnthropicOAuthCache();
  return new AnthropicAdapter({
    auth: {
      mode: "oauth",
      oauthToken: creds.oauthToken,
      cache,
      exchange: directOAuthPassthrough,
    },
  });
}

/**
 * "Exchange" function that returns the OAuth token directly as the temp key.
 *
 * See the M2 as-built / M3 as-built for background on why we skip the
 * exchange: Anthropic gates the programmatic exchange endpoint with 403
 * for `claude setup-token` issued tokens, but those tokens are themselves
 * long-lived API tokens accepted directly via `x-api-key` on `/v1/messages`.
 */
function directOAuthPassthrough(oauthToken: string): Promise<{ tempKey: string; expiresAt: number }> {
  return Promise.resolve({
    tempKey: oauthToken,
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
  });
}
