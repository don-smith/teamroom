import type { Provider } from "../types.js";

export interface BuildPiModelConfigArgs {
  provider: Provider;
  model: string;
  baseUrl: string;
  apiToken: string;
}

export interface PiModelsJson {
  providers: Record<string, unknown>;
}

export interface PiModelConfig {
  providerId: string;
  modelId: string;
  modelsJson: PiModelsJson;
}

export function buildPiModelConfig(args: BuildPiModelConfigArgs): PiModelConfig {
  const providerId = "teamroom-openrouter";
  const cleanBase = args.baseUrl.replace(/\/$/, "");
  const modelId = args.model;

  return {
    providerId,
    modelId,
    modelsJson: {
      providers: {
        [providerId]: {
          baseUrl: `${cleanBase}/v1`,
          api: "openai-completions",
          apiKey: args.apiToken,
          authHeader: true,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models: [{ id: modelId }],
        },
      },
    },
  };
}
