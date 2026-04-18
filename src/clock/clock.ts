export interface Clock {
  nowMs(): number;
  nowIso(): string;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
}

export class ControllableClock implements Clock {
  private currentMs: number;

  constructor(startIso: string) {
    this.currentMs = Date.parse(startIso);
    if (Number.isNaN(this.currentMs)) {
      throw new Error(`ControllableClock: invalid ISO string ${startIso}`);
    }
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}
