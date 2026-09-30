import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Clock } from './clock.js';
import { type Envelope, type HistoryAggregate, type InputEvent, type ServiceConfig } from './contracts.js';
import { SqliteStore, type Decision } from './sqlite-store.js';

export class Coordinator {
  private readonly queue: InputEvent[] = [];
  private seq = 0;
  private lastEnqueuedAt = -1;
  private pendingTick = false;
  private overflowLatched = false;
  private fault: string | null = null;
  // Once a fault event is committed or a write fails, nothing queued behind it may commit.
  private halted = false;
  private draining: Promise<void> | null = null;
  readonly decisions: Decision[] = [];
  readonly runId: string;

  constructor(readonly store: SqliteStore, readonly clock: Clock, readonly config: ServiceConfig, runId = `run-${process.pid}`) {
    this.runId = runId;
    this.store.resume(clock.now());
    this.halted = Boolean(this.store.meta().writerFault);
  }
  get writerFault(): string | null { return this.fault ?? this.store.meta().writerFault; }
  get queueDepth(): number { return this.queue.length; }
  get oldestQueuedAt(): number | null { return this.queue[0]?.envelope.receivedAtMs ?? null; }
  get hasDataCapacity(): boolean { return this.queue.filter(event => event.kind === 'trade').length < this.config.maxQueue; }

  private envelope(atMs?: number): Envelope {
    if (atMs !== undefined) {
      if (this.clock.mode !== 'virtual' || !this.clock.advanceTo) throw new Error('explicit atMs requires virtual clock');
      this.clock.advanceTo(atMs);
    }
    const receivedAtMs = this.clock.now();
    if (receivedAtMs < this.lastEnqueuedAt) throw new Error('ingress time moved backwards');
    this.lastEnqueuedAt = receivedAtMs;
    return Object.freeze({ runId: this.runId, seq: ++this.seq, receivedAtMs });
  }
  private checkRealClock(refusingTrade: boolean): void {
    if (this.clock.mode !== 'real' || this.fault) return;
    if ((this.clock.driftMs?.() ?? 0) > this.config.clockDriftLimitMs) {
      const event = Object.freeze({ kind: 'fault' as const, envelope: this.envelope(), code: 'clock_untrusted' as const, knownIncomplete: refusingTrade });
      this.queue.push(event); this.fault = 'clock_untrusted';
    }
  }
  enqueueTrade(raw: unknown, atMs?: number): boolean {
    this.checkRealClock(true);
    if (this.writerFault) return false;
    if (!this.hasDataCapacity) {
      if (!this.overflowLatched) {
        this.queue.push(Object.freeze({ kind: 'fault' as const, envelope: this.envelope(atMs), code: 'overflow' as const, knownIncomplete: true }));
        this.overflowLatched = true; this.fault = 'overflow';
      }
      return false;
    }
    const envelope = this.envelope(atMs);
    let copy: unknown = null;
    try {
      const serialized = JSON.stringify(raw);
      if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= 2_048) copy = JSON.parse(serialized);
    } catch { /* Malformed raw input remains an attributable invalid event. */ }
    this.queue.push(Object.freeze({ kind: 'trade' as const, envelope, raw: copy }));
    return true;
  }
  enqueueTick(atMs?: number): boolean {
    this.checkRealClock(false);
    if (this.writerFault || this.pendingTick) return false;
    this.queue.push(Object.freeze({ kind: 'tick' as const, envelope: this.envelope(atMs) }));
    this.pendingTick = true; return true;
  }
  enqueueSource(state: 'connected' | 'disconnected' | 'stopped', atMs?: number, observedUntilMs?: number): boolean {
    this.checkRealClock(false);
    if (this.writerFault) return false;
    if (this.queue.filter(event => event.kind === 'source').length >= 8) {
      this.queue.push(Object.freeze({ kind: 'fault' as const, envelope: this.envelope(atMs), code: 'overflow' as const, knownIncomplete: false }));
      this.fault = 'overflow'; return false;
    }
    if (observedUntilMs !== undefined && (!Number.isSafeInteger(observedUntilMs) || observedUntilMs < 0)) throw new Error('invalid observedUntilMs');
    this.queue.push(Object.freeze({ kind: 'source' as const, envelope: this.envelope(atMs), state, ...(observedUntilMs === undefined ? {} : { observedUntilMs }) }));
    return true;
  }
  /** Queues a closed minute's trade history. Bounded: returns false while 16 reconciliations are already pending. */
  enqueueReconcile(symbol: string, openTimeMs: number, aggregates: HistoryAggregate[], provenance: string, atMs?: number): boolean {
    this.checkRealClock(false);
    if (this.writerFault || this.queue.filter(event => event.kind === 'reconcile').length >= 16) return false;
    this.queue.push(Object.freeze({ kind: 'reconcile' as const, envelope: this.envelope(atMs), symbol, openTimeMs,
      aggregates: aggregates.map(item => ({ ...item })), provenance }));
    return true;
  }
  async drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.drainLoop();
    try { await this.draining; } finally { this.draining = null; }
  }
  private async drainLoop(): Promise<void> {
    let batch = 0;
    while (this.queue.length && !this.halted) {
      const event = this.queue.shift()!;
      if (event.kind === 'tick') this.pendingTick = false;
      try {
        const decision = this.store.process(event);
        this.decisions.push(decision);
        if (this.decisions.length > 2_048) this.decisions.shift();
        if (decision.kind === 'resource_limit') { this.fault = 'resource_limit'; this.halted = true; break; }
        if (decision.kind === 'fault') { this.halted = true; break; }
      }
      catch (error) {
        this.fault = `writer_error:${error instanceof Error ? error.message : String(error)}`;
        this.halted = true;
        // The failed event and any trade still queued behind it are delivered but not stored.
        const lostTrade = event.kind === 'trade' || this.queue.some(queued => queued.kind === 'trade');
        this.store.latchWriterFault(this.fault, event.envelope.receivedAtMs, lostTrade);
        break;
      }
      if (++batch >= 256) { batch = 0; await nextTurn(); }
    }
  }
}
