import { Bot, GrammyError, InputFile } from "grammy";
import https from "node:https";
import OpenAI from "openai";
import type { EventBus } from "../bus/event-bus.js";
import type { Logger } from "../logger/logger.js";
import type { TelegramBotEntry } from "./telegram-config.js";

export interface DeliverInboundInput {
  from: string;
  to: string[];
  body: string;
  threadId: string | null;
  cc: string[];
}

export interface TelegramGatewayDeps {
  bus: EventBus;
  /** Deliver an inbound message to the agent. In the meta-process this
   *  resolves repo from bot config and calls deliverToDaemon. In the
   *  monolithic daemon this wraps the local mail delivery path. */
  deliverInbound: (msg: DeliverInboundInput) => void;
  logger: Logger;
  bots: TelegramBotEntry[];
  genId: () => string;
  /** OpenAI client for voice transcription/synthesis. Undefined = voice disabled. */
  openai: OpenAI | undefined;
}

/**
 * Factory function following the existing composeMcpMail / composeChannels
 * pattern. Callable from both startDaemon and composeIntegrationHarness
 * (composition parity).
 */
export function composeTelegram(deps: TelegramGatewayDeps): TelegramGateway {
  return new TelegramGateway(deps);
}

interface BotInstance {
  agent: string;
  bot: Bot;
  stop: () => Promise<void>;
}

const MAX_TELEGRAM_LENGTH = 4096;

/**
 * Multi-bot Telegram gateway. Manages one grammy Bot instance per
 * configured agent. Handles:
 *   - Inbound text messages → deliverInbound()
 *   - Outbound delivery via channel.out event subscription
 *   - 4096-char message splitting
 *   - Markdown parse mode with plain text fallback
 *   - Inbound voice → Whisper STT with graceful fallback
 *   - Fire-and-forget TTS for voice-originated threads
 *   - IPv4 forced for Telegram connections
 */
export class TelegramGateway {
  private readonly instances: BotInstance[] = [];
  private readonly voiceThreadIds = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: TelegramGatewayDeps) {}

  /**
   * Start all bot instances and subscribe to channel.out for outbound delivery.
   */
  async start(): Promise<void> {
    for (const entry of this.deps.bots) {
      try {
        const token = process.env[entry.tokenEnvVar]!;
        const bot = new Bot(token, {
          client: {
            baseFetchConfig: {
              // Force IPv4 — broken IPv6 routing (e.g. WireGuard/Tailscale split
              // tunnels) causes Node.js Happy Eyeballs to hang on the IPv6 attempt
              // before failing over. Nanoclaw lesson learned.
              agent: new https.Agent({ family: 4, keepAlive: true }),
              compress: true,
            },
          },
        });

      // Inbound text messages
      bot.on("message:text", async (ctx) => {
        const text = ctx.message.text;
        const chatId = ctx.chat.id;
        const agent = entry.agent;

        if (!text || text.length === 0) return;

        this.deps.logger.info("telegram.inbound.text", {
          agent,
          chatId,
          textLength: text.length,
        });

        try {
          this.deps.deliverInbound({
            from: `channel:telegram:${agent}:${chatId}`,
            to: [`agent:${agent}`],
            body: text,
            threadId: null,
            cc: [],
          });
        } catch (err) {
          this.deps.logger.error("telegram.inbound.dispatch_error", {
            agent,
            chatId,
            error: String(err),
          });
        }
      });

      // Inbound voice messages — transcribed via OpenAI Whisper
      bot.on("message:voice", async (ctx) => {
        const voice = ctx.message.voice;
        const chatId = ctx.chat.id;
        const agent = entry.agent;

        this.deps.logger.info("telegram.inbound.voice", {
          agent,
          chatId,
          duration: voice.duration,
        });

        if (!this.deps.openai) {
          this.deps.logger.warn("telegram.inbound.voice_no_openai", { agent, chatId });
          await ctx.reply("Voice processing is unavailable, please send text.");
          return;
        }

        let text: string;
        try {
          // Download the voice file from Telegram
          const file = await ctx.api.getFile(voice.file_id);
          const filePath = file.file_path;
          if (!filePath) {
            throw new Error("voice file has no file_path");
          }
          const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
          const response = await fetch(fileUrl);
          if (!response.ok) {
            throw new Error(`failed to download voice: ${response.status}`);
          }
          const audioBuffer = Buffer.from(await response.arrayBuffer());

          // Transcribe via OpenAI Whisper
          const transcription = await this.deps.openai.audio.transcriptions.create({
            model: "whisper-1",
            file: new File([audioBuffer], "voice.ogg", { type: "audio/ogg" }),
          });
          text = transcription.text || "";
          if (!text) {
            throw new Error("Whisper returned empty transcription");
          }
        } catch (err) {
          this.deps.logger.error("telegram.inbound.stt_error", {
            agent,
            chatId,
            error: String(err),
          });
          // Graceful degradation: send fallback message, don't dispatch to agent
          await ctx.reply("Voice processing is unavailable, please send text.");
          return;
        }

        // Send transcribed text to the agent
        try {
          const threadId = this.deps.genId();
          this.deps.deliverInbound({
            from: `channel:telegram:${agent}:${chatId}`,
            to: [`agent:${agent}`],
            body: text,
            threadId,
            cc: [],
          });
          // Track this thread as voice-originated
          this.voiceThreadIds.add(threadId);
        } catch (err) {
          this.deps.logger.error("telegram.inbound.voice_dispatch_error", {
            agent,
            chatId,
            error: String(err),
          });
        }
      });

      // Global error handler — grammy's bot.catch() catches all unhandled
      // errors from middleware/handlers.
      bot.catch((err) => {
        this.deps.logger.error("telegram.bot_error", {
          agent: entry.agent,
          error: err.message,
        });
      });

      // Start long-polling (grammy manages reconnection and offset internally)
      // Fire bot.start() without awaiting — grammy's polling loop keeps the
      // promise pending indefinitely. Instead, wait for the onStart callback
      // which fires after init + deleteWebhook complete.
      const { promise: botReady, resolve: resolveBotReady, reject: rejectBotReady } = Promise.withResolvers<void>();
      // Timeout guard: if a bot's initialization hangs, don't block the daemon
      const timeout = setTimeout(() =>
        rejectBotReady(new Error(`bot.start() timed out for ${entry.agent}`)), 30_000,
      );
      bot.start({
        onStart: (botInfo) => {
          clearTimeout(timeout);
          resolveBotReady();
          this.deps.logger.info("telegram.bot_started", {
            agent: entry.agent,
            username: botInfo.username,
          });
        },
      }).catch((err) => {
        clearTimeout(timeout);
        // If onStart already resolved, rejecting is a no-op (promise settled)
        rejectBotReady(err);
      });
      await botReady;

        this.instances.push({
          agent: entry.agent,
          bot,
          stop: () => bot.stop(),
        });
      } catch (err) {
        this.deps.logger.error("telegram.bot_init_failed", {
          agent: entry.agent,
          error: String(err),
        });
      }
    }

    // Subscribe to channel.out for outbound delivery to Telegram channels
    this.unsubscribe = this.deps.bus.subscribe<{
      channel: string;
      user: string;
      messageId: string;
      agentId: string;
      threadId: string;
      from: string;
      to: string[];
      body: string;
    }>("channel.out", (payload) => {
      if (payload.channel !== "telegram") return;
      this.deliverOutbound(payload).catch((err) => {
        this.deps.logger.error("telegram.outbound_error", {
          messageId: payload.messageId,
          error: String(err),
        });
      });
    });
  }

  /**
   * Stop all bot instances and unsubscribe from channel.out.
   */
  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    for (const inst of this.instances) {
      try {
        await inst.stop();
      } catch (err) {
        this.deps.logger.warn("telegram.bot_stop_error", {
          agent: inst.agent,
          error: String(err),
        });
      }
    }
    this.instances.length = 0;
  }

  /**
   * Deliver an outbound message to Telegram. The payload.user is
   * "<botName>:<chatId>" — parse to find the right bot instance and chat.
   */
  private async deliverOutbound(payload: {
    channel: string;
    user: string;
    messageId: string;
    agentId: string;
    threadId: string;
    from: string;
    to: string[];
    body: string;
  }): Promise<void> {
    // user format: "<botName>:<chatId>" (e.g. "doc:12345")
    const colonIdx = payload.user.indexOf(":");
    if (colonIdx <= 0) {
      this.deps.logger.warn("telegram.outbound.invalid_user", {
        user: payload.user,
      });
      return;
    }
    const botName = payload.user.slice(0, colonIdx);
    const chatIdStr = payload.user.slice(colonIdx + 1);
    const chatId = Number(chatIdStr);
    if (!Number.isFinite(chatId)) {
      this.deps.logger.warn("telegram.outbound.invalid_chat_id", {
        user: payload.user,
        chatId: chatIdStr,
      });
      return;
    }

    // Find the bot instance for this agent
    const inst = this.instances.find((i) => i.agent === botName);
    if (!inst) {
      this.deps.logger.warn("telegram.outbound.no_bot_instance", {
        agent: botName,
        user: payload.user,
      });
      return;
    }

    // Body is in the channel.out event payload — no DB lookup needed
    const text = payload.body;
    await this.sendText(inst.bot, chatId, text);

    // Fire-and-forget TTS for voice-originated threads
    if (this.voiceThreadIds.has(payload.threadId)) {
      this.ttsSendVoice(inst.bot, chatId, text, payload.threadId).catch((err) => {
        this.deps.logger.warn("telegram.outbound.tts_fallback", {
          threadId: payload.threadId,
          error: String(err),
        });
      });
    }
  }

  /**
   * Send text to a Telegram chat with:
   *   1. Markdown parse mode (fallback to plain text on parse error)
   *   2. 4096-char message splitting
   */
  private async sendText(bot: Bot, chatId: number, text: string): Promise<void> {
    if (text.length <= MAX_TELEGRAM_LENGTH) {
      await this.sendSingle(bot, chatId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_TELEGRAM_LENGTH) {
        const chunk = text.slice(i, i + MAX_TELEGRAM_LENGTH);
        await this.sendSingle(bot, chatId, chunk);
      }
    }
  }

  private async sendSingle(bot: Bot, chatId: number, text: string): Promise<void> {
    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch (err) {
      // If Markdown parsing failed, fall back to plain text
      if (err instanceof GrammyError && (err.error_code === 400 || err.description?.includes("parse"))) {
        await bot.api.sendMessage(chatId, text);
      } else {
        throw err;
      }
    }
  }

  /**
   * Fire-and-forget: synthesize TTS audio and send as Telegram voice message.
   * Never blocks the text reply — errors are logged, not surfaced.
   */
  private async ttsSendVoice(
    bot: Bot,
    chatId: number,
    text: string,
    threadId: string,
  ): Promise<void> {
    try {
      const mp3 = await this.deps.openai!.audio.speech.create({
        model: "tts-1",
        voice: "alloy",
        input: text,
      });
      const audioBuffer = Buffer.from(await mp3.arrayBuffer());
      await bot.api.sendVoice(chatId, new InputFile(audioBuffer, "voice.mp3"));
    } catch (err) {
      // TTS failure is non-blocking — text was already delivered
      this.deps.logger.warn("telegram.outbound.tts_failed", {
        threadId,
        error: String(err),
      });
    }
  }
}