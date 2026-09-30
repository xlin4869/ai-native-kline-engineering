import type { Coordinator } from './coordinator.js';

// Optional live source: Binance Spot raw <symbol>@trade over the market-data-only combined stream.
// Contract (binance-spot-api-docs web-socket-streams.md @ 828ca74, 2026-09-18): payload fields e="trade", s, t (trade ID),
// p/q (decimal strings), T (trade time, ms); a connection lives at most 24 h; the server pings every 20 s and sends
// a `serverShutdown` event before closing. The WHATWG WebSocket answers pings itself but does not expose them, so
// liveness here is "a frame arrived recently" (silence watchdog). Nothing proves every market trade was delivered.

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  close(code?: number, reason?: string): void;
}
export type SocketFactory = (url: string) => SocketLike;
export interface Timers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }

export type ParsedFrame =
  | { kind: 'trade'; trade: Record<string, unknown> }   // mapped to the service trade shape; the store validates it
  | { kind: 'shutdown' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'malformed'; raw: unknown; reason: string };

/** Parses one frame. Trade IDs keep their exact source digits, so IDs above 2^53 cannot be rounded. */
export function parseBinanceFrame(text: string, symbols: readonly string[]): ParsedFrame {
  let value: unknown;
  try {
    value = JSON.parse(text, function (key: string, raw: unknown, context?: { source?: string }) {
      if (key === 't' && typeof raw === 'number') return context?.source ?? (Number.isSafeInteger(raw) ? String(raw) : null);
      return raw;
    });
  } catch { return { kind: 'malformed', raw: text.slice(0, 200), reason: 'not JSON' }; }
  if (!value || typeof value !== 'object') return { kind: 'malformed', raw: value, reason: 'not an object' };
  let data = value as Record<string, unknown>;
  let streamSymbol: string | null = null;
  if (typeof data.stream === 'string' && data.data && typeof data.data === 'object') {
    const match = /^([a-z0-9]+)@trade$/.exec(data.stream);
    if (data.stream === '!serverShutdown') return { kind: 'shutdown' };
    if (!match) return { kind: 'ignored', reason: `unexpected stream ${data.stream.slice(0, 40)}` };
    streamSymbol = match[1]!.toUpperCase();
    data = data.data as Record<string, unknown>;
  }
  if (data.e === 'serverShutdown') return { kind: 'shutdown' };
  if (data.e !== 'trade') return { kind: 'ignored', reason: `event ${String(data.e ?? 'none').slice(0, 40)}` };
  const trade = { venue: 'binance', market: 'spot', symbol: data.s, tradeId: data.t, eventTimeMs: data.T, price: data.p, quantity: data.q };
  if (streamSymbol !== null && data.s !== streamSymbol) return { kind: 'malformed', raw: trade, reason: 'stream/symbol mismatch' };
  if (typeof data.s !== 'string' || !symbols.includes(data.s)) return { kind: 'malformed', raw: trade, reason: 'unsubscribed symbol' };
  return { kind: 'trade', trade };
}

export interface BinanceSourceOptions {
  endpoint?: string;               // default: market-data-only stream
  symbols: string[];
  socketFactory?: SocketFactory;   // default: global WebSocket (Node 22)
  timers?: Timers;
  random?: () => number;
  reconnectBaseMs?: number;        // default 1 s, doubled per failed attempt, jittered, capped
  reconnectMaxMs?: number;         // default 30 s (Binance allows 300 connection attempts per 5 min per IP)
  maxConnectionAgeMs?: number;     // default 23 h 50 m: rotate before the documented 24 h cut
  silenceTimeoutMs?: number;       // default 60 s without any frame => treat the connection as dead
  onEvent?: (event: Record<string, unknown>) => void;
}

export class BinanceTradeSource {
  readonly url: string;
  private readonly timers: Timers;
  private readonly factory: SocketFactory;
  private socket: SocketLike | null = null;
  private generation = 0;
  private attempts = 0;
  private connected = false;
  private stopped = false;
  private lastFrameAt: number | null = null;
  private reconnectTimer: unknown = null;
  private ageTimer: unknown = null;
  private silenceTimer: unknown = null;
  private drainScheduled = false;
  readonly counts = { frames: 0, trades: 0, refused: 0, malformed: 0, ignored: 0, connects: 0, drops: 0 };

  constructor(private readonly coordinator: Coordinator, private readonly options: BinanceSourceOptions) {
    if (!options.symbols.length || options.symbols.some(s => !/^[A-Z0-9]{1,20}$/.test(s))) throw new Error('invalid Binance symbols');
    const endpoint = (options.endpoint ?? 'wss://data-stream.binance.vision').replace(/\/+$/, '');
    if (!/^wss?:\/\//.test(endpoint)) throw new Error('Binance endpoint must be a ws(s) URL');
    this.url = `${endpoint}/stream?streams=${options.symbols.map(s => `${s.toLowerCase()}@trade`).join('/')}`;
    this.timers = options.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout) };
    this.factory = options.socketFactory ?? (url => new WebSocket(url) as unknown as SocketLike);
  }

  start(): void { if (!this.stopped && !this.socket) this.connect(); }

  /** Clean stop: marks the source stopped (a clean gap on restart) and closes the socket. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket; this.socket = null; this.generation++;
    try { socket?.close(1000, 'service stopping'); } catch { /* already closed */ }
    this.coordinator.enqueueSource('stopped', undefined, this.connected ? this.observedUntil() : undefined);
    this.connected = false;
    await this.coordinator.drain();
  }

  private emit(event: Record<string, unknown>): void { this.options.onEvent?.({ at: this.coordinator.clock.now(), ...event }); }
  private observedUntil(): number { return this.lastFrameAt ?? this.coordinator.clock.now(); }

  private connect(): void {
    const generation = ++this.generation;
    this.emit({ event: 'connecting', url: this.url, attempt: this.attempts });
    let socket: SocketLike;
    try { socket = this.factory(this.url); } catch (error) { this.drop(generation, `connect failed: ${String(error)}`); return; }
    this.socket = socket;
    socket.onopen = () => {
      if (generation !== this.generation || this.stopped) return;
      this.attempts = 0; this.connected = true; this.counts.connects++;
      this.lastFrameAt = this.coordinator.clock.now();
      if (!this.coordinator.enqueueSource('connected')) return this.halt('intake refused connected state');
      this.scheduleDrain();
      this.ageTimer = this.timers.setTimeout(() => this.drop(generation, 'max connection age'), this.options.maxConnectionAgeMs ?? 85_800_000);
      this.armSilence(generation);
      this.emit({ event: 'connected' });
    };
    socket.onmessage = event => {
      if (generation !== this.generation || this.stopped) return; // frames from a replaced socket are fenced out
      this.counts.frames++;
      this.lastFrameAt = this.coordinator.clock.now();
      this.armSilence(generation);
      const frame = parseBinanceFrame(typeof event.data === 'string' ? event.data : String(event.data), this.options.symbols);
      if (frame.kind === 'shutdown') return this.drop(generation, 'serverShutdown');
      if (frame.kind === 'ignored') { this.counts.ignored++; return; }
      if (frame.kind === 'malformed') this.counts.malformed++; else this.counts.trades++;
      // Malformed trades are still enqueued: the store records them as invalid_input instead of dropping silently.
      if (!this.coordinator.enqueueTrade(frame.kind === 'trade' ? frame.trade : frame.raw)) { this.counts.refused++; return this.halt('intake refused a trade'); }
      this.scheduleDrain();
    };
    socket.onerror = () => this.drop(generation, 'socket error');
    socket.onclose = event => this.drop(generation, `closed ${event.code ?? ''} ${event.reason ?? ''}`.trim());
  }

  private armSilence(generation: number): void {
    if (this.silenceTimer !== null) this.timers.clearTimeout(this.silenceTimer);
    this.silenceTimer = this.timers.setTimeout(() => this.drop(generation, 'silence timeout'), this.options.silenceTimeoutMs ?? 60_000);
  }

  /** Handles each connection's first failure once; later events of the same socket are fenced by generation. */
  private drop(generation: number, reason: string): void {
    if (generation !== this.generation || this.stopped) return;
    this.generation++;
    this.clearTimers();
    const socket = this.socket; this.socket = null;
    try { socket?.close(); } catch { /* already closed */ }
    this.counts.drops++;
    if (this.connected) {
      this.connected = false;
      // The gap starts at the last received frame: a silent socket was not observing even while "connected".
      if (!this.coordinator.enqueueSource('disconnected', undefined, this.observedUntil())) return this.halt('intake refused disconnect');
      this.scheduleDrain();
    }
    const base = this.options.reconnectBaseMs ?? 1_000, cap = this.options.reconnectMaxMs ?? 30_000;
    const delay = reason === 'serverShutdown' || reason === 'max connection age' ? 0
      : Math.round(Math.min(cap, base * 2 ** this.attempts) * (0.5 + (this.options.random ?? Math.random)() / 2));
    this.attempts++;
    this.emit({ event: 'dropped', reason, reconnectInMs: delay });
    this.reconnectTimer = this.timers.setTimeout(() => { this.reconnectTimer = null; if (!this.stopped) this.connect(); }, delay);
  }

  /** Intake is halted (overflow or a latched fault): stop consuming instead of reconnecting in a loop. */
  private halt(reason: string): void {
    this.stopped = true; this.connected = false; this.generation++;
    this.clearTimers();
    const socket = this.socket; this.socket = null;
    try { socket?.close(1011, 'intake halted'); } catch { /* already closed */ }
    this.emit({ event: 'halted', reason, fault: this.coordinator.writerFault });
    this.scheduleDrain();
  }

  private clearTimers(): void {
    for (const handle of [this.reconnectTimer, this.ageTimer, this.silenceTimer]) if (handle !== null) this.timers.clearTimeout(handle);
    this.reconnectTimer = this.ageTimer = this.silenceTimer = null;
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => { this.drainScheduled = false; void this.coordinator.drain(); });
  }
}
