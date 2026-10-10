// The only place server code reads the wall clock. Everything else gets `now` passed in.

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Test and seed clock: time moves only when told to. */
export class FakeClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
