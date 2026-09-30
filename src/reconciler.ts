import type { Coordinator } from './coordinator.js';
import { MINUTE_MS, minuteOpen, type HistoryAggregate, type Trade } from './contracts.js';

/** Complete history per closed minute, or an error. IO adapters should honour signal to release resources. */
export interface TradeHistory {
  readonly name: string;
  aggregates(symbol: string, openTimeMs: number, signal?: AbortSignal): Promise<HistoryAggregate[]>;
}

/** Mock history: the scenario's market truth, one aggregate per trade (IDs are consecutive per symbol). */
export class TruthHistory implements TradeHistory {
  readonly name = 'mock-truth';
  constructor(private readonly truth: readonly Trade[]) {}
  async aggregates(symbol: string, openTimeMs: number, signal?: AbortSignal): Promise<HistoryAggregate[]> {
    signal?.throwIfAborted();
    return this.truth.filter(t => t.symbol === symbol && minuteOpen(t.eventTimeMs) === openTimeMs)
      .map(t => ({ firstTradeId: t.tradeId, lastTradeId: t.tradeId, eventTimeMs: t.eventTimeMs, price: t.price, quantity: t.quantity }));
  }
}

type RawAgg = { a: string; f: string; l: string; T: number; p: string; q: string };
/** Parses GET /api/v3/aggTrades, keeping the ID fields a/f/l as exact source digits. */
export function parseAggTrades(text: string): RawAgg[] {
  const rows = JSON.parse(text, function (key: string, raw: unknown, context?: { source?: string }) {
    if ((key === 'a' || key === 'f' || key === 'l') && typeof raw === 'number') return context?.source ?? (Number.isSafeInteger(raw) ? String(raw) : null);
    return raw;
  }) as unknown;
  if (!Array.isArray(rows)) throw new Error('aggTrades: response is not an array');
  return rows.map(row => {
    const r = row as Record<string, unknown>;
    if (typeof r.a !== 'string' || typeof r.f !== 'string' || typeof r.l !== 'string' || typeof r.p !== 'string' || typeof r.q !== 'string' ||
        !Number.isSafeInteger(r.T)) throw new Error('aggTrades: malformed row');
    return { a: r.a, f: r.f, l: r.l, T: r.T as number, p: r.p, q: r.q };
  });
}

/**
 * Binance Spot aggregate-trade history (GET /api/v3/aggTrades on the market-data endpoint). An aggregate is one
 * taker order's fills at one price and time, covering raw trade IDs f..l, so it rebuilds OHLCV and the raw count
 * exactly. Pages by fromId; refuses to return a truncated minute.
 */
export class BinanceAggTradeHistory implements TradeHistory {
  readonly name = 'binance-rest-aggTrades';
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly maxPages: number;
  private readonly requestTimeoutMs: number;
  constructor(options: { endpoint?: string; fetch?: typeof fetch; maxPages?: number; requestTimeoutMs?: number } = {}) {
    this.base = (options.endpoint ?? 'https://data-api.binance.vision').replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? fetch;
    this.maxPages = options.maxPages ?? 60;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.maxPages) || this.maxPages < 1) throw new Error('maxPages must be a positive integer');
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1 || this.requestTimeoutMs > 2_147_483_647)
      throw new Error('requestTimeoutMs must be a positive timer interval');
  }
  private async page(url: string, signal?: AbortSignal): Promise<RawAgg[]> {
    const request = new AbortController();
    const combined = signal ? AbortSignal.any([signal, request.signal]) : request.signal;
    const timer = setTimeout(() => request.abort(new Error('aggTrades request timed out')), this.requestTimeoutMs);
    try {
      combined.throwIfAborted();
      const response = await this.fetchFn(url, { signal: combined });
      if (!response.ok) throw new Error(`aggTrades HTTP ${response.status}`);
      // The deadline covers the response body too: headers alone are not a completed request.
      return parseAggTrades(await response.text());
    } finally {
      clearTimeout(timer);
      request.abort(); // also releases an unread error response body
    }
  }
  async aggregates(symbol: string, openTimeMs: number, signal?: AbortSignal): Promise<HistoryAggregate[]> {
    const end = openTimeMs + 60_000; const out: HistoryAggregate[] = [];
    let url = `${this.base}/api/v3/aggTrades?symbol=${symbol}&startTime=${openTimeMs}&endTime=${end - 1}&limit=1000`;
    for (let page = 0; page < this.maxPages; page++) {
      signal?.throwIfAborted();
      const rows = await this.page(url, signal);
      for (const r of rows) if (r.T >= openTimeMs && r.T < end)
        out.push({ firstTradeId: r.f, lastTradeId: r.l, eventTimeMs: r.T, price: r.p, quantity: r.q });
      const last = rows.at(-1);
      if (rows.length < 1_000 || !last || last.T >= end) return out;
      url = `${this.base}/api/v3/aggTrades?symbol=${symbol}&fromId=${BigInt(last.a) + 1n}&limit=1000`;
    }
    throw new Error('aggTrades: minute exceeds the page budget; history would be truncated');
  }
}

export type ReconcilePolicy = 'off' | 'flagged' | 'all';
export interface ReconcilerOptions {
  policy: Exclude<ReconcilePolicy, 'off'>;
  settleMs?: number;       // wait after a minute's deadline before asking the history (default 5 s)
  lookbackMs?: number;     // oldest minute considered (default 6 h)
  maxPerRun?: number;      // minutes per run (default 20)
  retryBaseMs?: number;    // exponential retry delay starts here (default 15 s)
  retryMaxMs?: number;     // retry delay ceiling (default 5 min); no lifetime attempt cap
  onEvent?: (event: Record<string, unknown>) => void;
}

/** Feeds verified history for flagged (or all) closed minutes through the single writer as reconcile events. */
export class Reconciler {
  private inFlight: Promise<number> | null = null;
  private readonly shutdown = new AbortController();
  private readonly failures = new Map<string, { openTimeMs: number; attempts: number; lastAttemptAt: number; retryAt: number }>();
  readonly counts = { runs: 0, enqueued: 0, historyFailures: 0, observerFailures: 0 };
  constructor(private readonly coordinator: Coordinator, private readonly history: TradeHistory, private readonly options: ReconcilerOptions) {
    for (const [name, value] of Object.entries({ settleMs: options.settleMs ?? 5_000, lookbackMs: options.lookbackMs ?? 6 * 3_600_000,
      maxPerRun: options.maxPerRun ?? 20, retryBaseMs: options.retryBaseMs ?? 15_000, retryMaxMs: options.retryMaxMs ?? 300_000 })) {
      if (!Number.isSafeInteger(value) || value < (name === 'settleMs' ? 0 : 1)) throw new Error(`${name} must be a valid nonnegative/positive integer`);
    }
  }

  runOnce(): Promise<number> {
    if (this.shutdown.signal.aborted || this.inFlight || this.coordinator.writerFault) return Promise.resolve(0);
    const run = this.run();
    this.inFlight = run;
    return run.finally(() => { this.inFlight = null; });
  }

  /** Stop admission, cancel network/body IO, and wait before the owner closes the store. */
  async stop(): Promise<void> {
    this.shutdown.abort();
    await this.inFlight;
  }

  private failed(symbol: string, openTimeMs: number): void {
    const key = `${symbol}|${openTimeMs}`;
    const now = this.coordinator.clock.now();
    // Capping the exponent/count prevents overflow; it never prevents another retry.
    const attempts = Math.min(32, (this.failures.get(key)?.attempts ?? 0) + 1);
    const delay = Math.min(this.options.retryMaxMs ?? 300_000, (this.options.retryBaseMs ?? 15_000) * 2 ** (attempts - 1));
    this.failures.set(key, { openTimeMs, attempts, lastAttemptAt: now, retryAt: now + delay });
  }

  private emit(event: Record<string, unknown>): void {
    try { this.options.onEvent?.(event); }
    catch { this.counts.observerFailures++; }
  }

  private historyFor(symbol: string, openTimeMs: number): Promise<HistoryAggregate[]> {
    const signal = this.shutdown.signal;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      // Native adapters cancel their own IO. This guard also prevents an injected adapter
      // that ignores the signal from blocking shutdown or publishing a later result.
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => this.history.aggregates(symbol, openTimeMs, signal)).then(
        value => { signal.removeEventListener('abort', abort); resolve(value); },
        error => { signal.removeEventListener('abort', abort); reject(error); },
      );
    });
  }

  private async run(): Promise<number> {
    this.counts.runs++;
    const { policy, settleMs = 5_000, lookbackMs = 6 * 3_600_000, maxPerRun = 20 } = this.options;
    const now = this.coordinator.clock.now();
    for (const [key, failure] of this.failures) if (failure.openTimeMs < minuteOpen(now - lookbackMs)) this.failures.delete(key);
    // Inspect the full bounded lookback before filtering/capping work. A small prefilter limit
    // lets old failures hide later minutes (and, with symbol-major scans, other symbols).
    const scanLimit = (Math.ceil(lookbackMs / MINUTE_MS) + 2) * this.coordinator.config.symbols.length;
    const candidates = this.coordinator.store.reconcileCandidates(policy, now, settleMs, lookbackMs, scanLimit)
      .filter(c => (this.failures.get(`${c.symbol}|${c.openTimeMs}`)?.retryAt ?? 0) <= now)
      .sort((a, b) => (this.failures.get(`${a.symbol}|${a.openTimeMs}`)?.lastAttemptAt ?? -1) -
        (this.failures.get(`${b.symbol}|${b.openTimeMs}`)?.lastAttemptAt ?? -1) || a.openTimeMs - b.openTimeMs)
      .slice(0, maxPerRun);
    let enqueued = 0;
    for (const candidate of candidates) {
      if (this.shutdown.signal.aborted || this.coordinator.writerFault) break;
      const key = `${candidate.symbol}|${candidate.openTimeMs}`;
      let aggregates: HistoryAggregate[];
      try { aggregates = await this.historyFor(candidate.symbol, candidate.openTimeMs); }
      catch (error) {
        if (this.shutdown.signal.aborted) break;
        this.counts.historyFailures++; this.failed(candidate.symbol, candidate.openTimeMs);
        this.emit({ event: 'history_failed', ...candidate, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (this.shutdown.signal.aborted) break;
      if (!this.coordinator.enqueueReconcile(candidate.symbol, candidate.openTimeMs, aggregates, this.history.name)) break;
      enqueued++; this.counts.enqueued++;
      await this.coordinator.drain();
      const decision = this.coordinator.decisions.at(-1);
      if (decision?.kind === 'invalid') this.failed(candidate.symbol, candidate.openTimeMs);
      else this.failures.delete(key);
      this.emit({ event: 'reconcile', ...candidate, aggregates: aggregates.length, decision: decision?.kind, detail: decision?.detail });
    }
    return enqueued;
  }
}
