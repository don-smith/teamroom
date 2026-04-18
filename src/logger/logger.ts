import type { Clock } from "../clock/clock.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [k: string]: unknown;
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  fatal(msg: string, extra?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

abstract class BaseLogger implements Logger {
  constructor(protected readonly clock: Clock, protected readonly bindings: Record<string, unknown> = {}) {}

  protected abstract emit(entry: LogEntry): void;

  private log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: this.clock.nowIso(),
      level,
      msg,
      ...this.bindings,
      ...(extra ?? {}),
    };
    this.emit(entry);
  }

  debug(msg: string, extra?: Record<string, unknown>): void { this.log("debug", msg, extra); }
  info(msg: string, extra?: Record<string, unknown>): void { this.log("info", msg, extra); }
  warn(msg: string, extra?: Record<string, unknown>): void { this.log("warn", msg, extra); }
  error(msg: string, extra?: Record<string, unknown>): void { this.log("error", msg, extra); }
  fatal(msg: string, extra?: Record<string, unknown>): void { this.log("fatal", msg, extra); }

  abstract child(bindings: Record<string, unknown>): Logger;
}

export class CapturingLogger extends BaseLogger {
  public readonly entries: LogEntry[];

  constructor(clock: Clock, bindings: Record<string, unknown> = {}, shared?: LogEntry[]) {
    super(clock, bindings);
    this.entries = shared ?? [];
  }

  protected emit(entry: LogEntry): void {
    this.entries.push(entry);
  }

  child(bindings: Record<string, unknown>): CapturingLogger {
    return new CapturingLogger(this.clock, { ...this.bindings, ...bindings }, this.entries);
  }
}

export type LogSink = (line: string) => void;

export class JsonLinesLogger extends BaseLogger {
  constructor(clock: Clock, private readonly sink: LogSink, bindings: Record<string, unknown> = {}) {
    super(clock, bindings);
  }

  protected emit(entry: LogEntry): void {
    this.sink(JSON.stringify(entry));
  }

  child(bindings: Record<string, unknown>): JsonLinesLogger {
    return new JsonLinesLogger(this.clock, this.sink, { ...this.bindings, ...bindings });
  }
}
