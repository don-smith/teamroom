import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chokidar from "chokidar";
import type { BusEvent } from "../types.js";
import type { EventFilter, NotifyBus } from "./notify-bus.js";

export class FileNotifyBus implements NotifyBus {
  private readonly eventsFile: string;
  private readonly notifyFile: string;
  private closedFlag = false;
  private watchers: chokidar.FSWatcher[] = [];
  private sleepingResolvers = new Set<() => void>();

  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.eventsFile = join(dir, "events.jsonl");
    this.notifyFile = join(dir, ".notify");
    if (!existsSync(this.eventsFile)) writeFileSync(this.eventsFile, "");
    if (!existsSync(this.notifyFile)) writeFileSync(this.notifyFile, "");
  }

  async publish(event: BusEvent): Promise<void> {
    if (this.closedFlag) return;
    appendFileSync(this.eventsFile, JSON.stringify(event) + "\n");
    // touch the notify file so fs.watch subscribers wake up
    writeFileSync(this.notifyFile, String(Date.now()));
  }

  subscribe(filter?: EventFilter): AsyncIterable<BusEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const seenIds = new Set<string>();
        let buffered: BusEvent[] = [];
        let wakeUp: (() => void) | null = null;
        let watcherClosed = false;

        const readNew = () => {
          const contents = readFileSync(self.eventsFile, "utf8");
          const lines = contents.split("\n").filter((l) => l.length > 0);
          for (const line of lines) {
            let parsed: BusEvent;
            try {
              parsed = JSON.parse(line) as BusEvent;
            } catch {
              continue;
            }
            if (seenIds.has(parsed.id)) continue;
            seenIds.add(parsed.id);
            if (filter && !filter(parsed)) continue;
            buffered.push(parsed);
          }
          if (wakeUp && buffered.length > 0) {
            const fn = wakeUp;
            wakeUp = null;
            self.sleepingResolvers.delete(fn);
            fn();
          }
        };

        const watcher = chokidar.watch(self.notifyFile, {
          persistent: true,
          ignoreInitial: true,
          usePolling: true,
          interval: 500,
        });
        self.watchers.push(watcher);
        watcher.on("change", () => {
          if (!watcherClosed) readNew();
        });
        watcher.on("add", () => {
          if (!watcherClosed) readNew();
        });

        // Wait for chokidar to finish its initial scan before proceeding
        await new Promise<void>((resolve) => watcher.on("ready", resolve));

        // initial drain — events already on disk when subscribe was called
        readNew();

        try {
          while (true) {
            if (buffered.length > 0) {
              const next = buffered.shift()!;
              yield next;
              continue;
            }
            if (self.closedFlag) return;
            await new Promise<void>((resolve) => {
              wakeUp = resolve;
              self.sleepingResolvers.add(resolve);
              // ensure close wakes us if it happened between the check and here
              if (self.closedFlag) {
                wakeUp = null;
                self.sleepingResolvers.delete(resolve);
                resolve();
              }
            });
          }
        } finally {
          if (wakeUp) {
            self.sleepingResolvers.delete(wakeUp);
            wakeUp = null;
          }
          watcherClosed = true;
          await watcher.close();
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closedFlag = true;
    // wake up all sleeping iterators
    for (const resolve of this.sleepingResolvers) {
      resolve();
    }
    this.sleepingResolvers.clear();
    for (const w of this.watchers) {
      await w.close();
    }
    this.watchers = [];
  }
}
