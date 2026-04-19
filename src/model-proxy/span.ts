import { randomUUID } from "node:crypto";
import type { SpanFields } from "../types.js";

export function newSpanId(): string {
  return randomUUID();
}

export interface BuildSpanInput extends SpanFields {
  extra?: Record<string, unknown>;
}

/**
 * A span-shaped log record. `event` is the span's canonical name; it is
 * guaranteed present (types enforce it) so log emitters can use it as the
 * log message without a fallback.
 */
export interface SpanLog extends SpanFields {
  [k: string]: unknown;
}

export function buildSpan(input: BuildSpanInput): SpanLog {
  const { extra, ...base } = input;
  return { ...base, ...(extra ?? {}) };
}
