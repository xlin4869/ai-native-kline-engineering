import { performance } from 'node:perf_hooks';

export interface Clock { readonly mode: 'real' | 'virtual'; now(): number; advanceTo?(ms: number): void; driftMs?(): number }

export class VirtualClock implements Clock {
  readonly mode = 'virtual';
  constructor(private currentMs: number) {
    if (!Number.isSafeInteger(currentMs) || currentMs < 0) throw new Error('invalid virtual start time');
  }
  now(): number { return this.currentMs; }
  advanceTo(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < this.currentMs) throw new Error('virtual clock cannot move backwards');
    this.currentMs = ms;
  }
}

export class RealClock implements Clock {
  readonly mode = 'real';
  private readonly startWall = Date.now();
  private readonly startMonotonic = performance.now();
  now(): number { return Math.floor(this.startWall + performance.now() - this.startMonotonic); }
  driftMs(): number { return Math.abs(Date.now() - this.now()); }
}
