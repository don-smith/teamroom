/**
 * In-memory registry of valid channel names. Populated at daemon startup
 * (cli is always registered; Telegram/Slack/etc. register themselves as
 * they come online). Consulted by the dispatcher at delivery time to
 * enforce "strict deliver" on channel-kind addresses (the parse side is
 * lenient — see address.ts for the full contract).
 *
 * Loud failure on duplicate registration: silent overwrite would mask
 * config bugs during module composition.
 */
export class ChannelRegistry {
  private readonly channels = new Set<string>();

  register(name: string): void {
    if (this.channels.has(name)) {
      throw new Error(`channel '${name}' already registered`);
    }
    this.channels.add(name);
  }

  has(name: string): boolean {
    return this.channels.has(name);
  }

  listChannels(): string[] {
    return [...this.channels];
  }
}
