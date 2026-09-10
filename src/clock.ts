import type { Clock } from "./types.js";

export class SystemClock implements Clock {
  now(): Date { return new Date(); }
}

export class MutableClock implements Clock {
  private current: Date;
  constructor(initial: Date | string = new Date()) {
    this.current = new Date(initial);
    if (Number.isNaN(this.current.getTime())) throw new Error("invalid initial clock");
  }
  now(): Date { return new Date(this.current); }
  set(value: Date | string): void {
    const next = new Date(value);
    if (Number.isNaN(next.getTime())) throw new Error("invalid clock value");
    this.current = next;
  }
  advanceMs(ms: number): void {
    if (!Number.isFinite(ms)) throw new Error("invalid clock delta");
    this.current = new Date(this.current.getTime() + ms);
  }
  advanceDays(days: number): void { this.advanceMs(days * 24 * 60 * 60 * 1000); }
}
