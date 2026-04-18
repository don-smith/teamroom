import { randomUUID } from "node:crypto";
import type { Provider } from "../types.js";

export interface TokenEntry {
  agentId: string;
  turnId: string;
  traceId: string;
  provider: Provider;
  model: string;
}

export class TokenRegistry {
  private readonly map = new Map<string, TokenEntry>();
  private readonly genId: () => string;

  constructor(genId: () => string = randomUUID) {
    this.genId = genId;
  }

  mint(entry: TokenEntry): string {
    const tok = this.genId();
    this.map.set(tok, entry);
    return tok;
  }

  lookup(token: string): TokenEntry | undefined {
    return this.map.get(token);
  }

  evict(token: string): void {
    this.map.delete(token);
  }
}
