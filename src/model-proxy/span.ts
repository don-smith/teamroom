import { randomUUID } from "node:crypto";
import type { SpanFields } from "../types.js";

export function newSpanId(): string {
  return randomUUID();
}

export interface BuildSpanInput extends SpanFields {
  extra?: Record<string, unknown>;
}

export function buildSpan(input: BuildSpanInput): Record<string, unknown> {
  const { extra, ...base } = input;
  return { ...base, ...(extra ?? {}) };
}
