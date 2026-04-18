import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmCreateArgs, LlmCreateResult } from "./runtime.js";

interface Opts {
  baseURL: string;
  apiKey: string;
  maxTokens?: number;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly sdk: Anthropic;
  private readonly maxTokens: number;

  constructor(opts: Opts) {
    this.sdk = new Anthropic({ baseURL: opts.baseURL, apiKey: opts.apiKey });
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  async createMessage(args: LlmCreateArgs): Promise<LlmCreateResult> {
    const resp = await this.sdk.messages.create({
      model: args.model,
      max_tokens: this.maxTokens,
      system: args.system,
      messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const block = resp.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text : "";
    return { text };
  }
}
