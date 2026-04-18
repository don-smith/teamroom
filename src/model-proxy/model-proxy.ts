import type { TokenEntry } from "./token-registry.js";

export interface MintTokenInput extends TokenEntry {}

export interface ModelProxy {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  mint(input: MintTokenInput): string;
  evict(token: string): void;
}
