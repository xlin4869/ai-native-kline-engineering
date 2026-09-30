import { Decimal } from 'decimal.js';

export const Money = Decimal.clone({ precision: 96, rounding: Decimal.ROUND_DOWN, toExpNeg: -1000, toExpPos: 1000 });
export const MINUTE_MS = 60_000;
export type SourceState = 'connected' | 'disconnected' | 'stopped' | 'faulted';
export type BarState = 'open' | 'closed';
export type QualityReason = 'startup_partial' | 'source_gap' | 'recovery_gap' | 'late_rejected' | 'conflicting_identity' | 'invalid_input' | 'overflow' | 'resource_limit' | 'clock_untrusted' | 'writer_fault'
  | 'stale_delivery' | 'reconciled' | 'repaired';
export type Completeness = 'unverified' | 'known_incomplete' | 'reconciled';

/** One entry of a venue's trade history for a minute: consecutive raw trade IDs at one price and time. */
export interface HistoryAggregate { firstTradeId: string; lastTradeId: string; eventTimeMs: number; price: string; quantity: string }

export interface Trade {
  venue: 'mock' | 'binance';
  market: 'spot';
  symbol: string;
  tradeId: string;
  eventTimeMs: number;
  price: string;
  quantity: string;
}

export interface Envelope { runId: string; seq: number; receivedAtMs: number }
export type InputEvent =
  | { kind: 'trade'; envelope: Envelope; raw: unknown }
  | { kind: 'tick'; envelope: Envelope }
  // observedUntilMs: last evidence of observation (e.g. last frame) when a drop is detected after the fact.
  | { kind: 'source'; envelope: Envelope; state: 'connected' | 'disconnected' | 'stopped'; observedUntilMs?: number }
  | { kind: 'fault'; envelope: Envelope; code: 'overflow' | 'clock_untrusted'; knownIncomplete: boolean }
  // Complete trade history of one closed minute from a trusted history source (exchange REST or mock truth).
  | { kind: 'reconcile'; envelope: Envelope; symbol: string; openTimeMs: number; aggregates: HistoryAggregate[]; provenance: string };

export interface BarRow {
  venue: string; market: 'spot'; symbol: string; openTimeMs: number; endTimeMs: number;
  open: string; high: string; low: string; close: string;
  volume: string; quoteVolume: string; tradeCount: number;
  firstTimeMs: number; firstTradeId: string; lastTimeMs: number; lastTradeId: string;
  state: BarState; valueRevision: number;
  // Raw trade-ID range covered by a reconciliation; later deliveries inside it are duplicates, not late trades.
  reconciledRange?: { firstTradeId: string; lastTradeId: string } | null;
}

export interface QualityEvent {
  id: number; reason: QualityReason; symbol: string | null;
  startMs: number; endMs: number | null; knownIncomplete: boolean; commitSeq: number;
  occurrences: number;
  detail?: string | null;
}

export interface PublicBar extends Omit<BarRow, 'firstTimeMs' | 'firstTradeId' | 'lastTimeMs' | 'lastTradeId' | 'reconciledRange'> {
  quality: { completeness: Completeness; reasons: QualityReason[]; qualityRevision: number };
}

export interface ServiceConfig {
  scenarioId: string;
  symbols: string[];
  graceMs: number;
  futureToleranceMs: number;
  maxQueue: number;
  maxTrades: number;             // retained identities (see identityRetentionMs), not lifetime trades
  maxQualityEvents: number;
  identityRetentionMs: number;   // identities of older minutes are pruned; later deliveries there are stale
  historyRetentionMs: number;    // bars and their quality evidence expire together
  clockDriftLimitMs: number;
  clockMode: 'real' | 'virtual';
  source: 'mock' | 'binance';
  dbPath: string;
  port: number;
}

export const DEFAULT_CONFIG: ServiceConfig = {
  scenarioId: 'default-test-scenario', symbols: ['BTCUSDT', 'ETHUSDT'], graceMs: 2_000, futureToleranceMs: 5_000,
  maxQueue: 4_096, maxTrades: 500_000, maxQualityEvents: 100_000, identityRetentionMs: 3_600_000,
  historyRetentionMs: 7 * 86_400_000,
  clockDriftLimitMs: 1_000, clockMode: 'virtual', source: 'mock', dbPath: ':memory:', port: 3000,
};

export function validateConfig(config: ServiceConfig): void {
  if (!Array.isArray(config.symbols) || config.symbols.length < 1 || config.symbols.length > 2 ||
      new Set(config.symbols).size !== config.symbols.length || config.symbols.some(symbol => !/^[A-Z0-9]{1,20}$/.test(symbol)))
    throw new Error('symbols must be one or two distinct uppercase symbols');
  const bounded = (name: string, value: number, min: number, max: number) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}..${max}`);
  };
  bounded('graceMs', config.graceMs, 0, 10_000);
  bounded('futureToleranceMs', config.futureToleranceMs, 0, 5_000);
  bounded('maxQueue', config.maxQueue, 1, 4_096);
  bounded('maxTrades', config.maxTrades, 1, 500_000);
  bounded('maxQualityEvents', config.maxQualityEvents, 2, 1_000_000);
  // Pruned minutes must be past every deadline, so retention exceeds one minute plus both tolerances.
  bounded('identityRetentionMs', config.identityRetentionMs, MINUTE_MS + config.graceMs + config.futureToleranceMs + 1, 7 * 86_400_000);
  bounded('historyRetentionMs', config.historyRetentionMs, config.identityRetentionMs, 365 * 86_400_000);
  bounded('clockDriftLimitMs', config.clockDriftLimitMs, 1, 5_000);
  bounded('port', config.port, 0, 65_535);
  if (!['mock', 'binance'].includes(config.source) || !['virtual', 'real'].includes(config.clockMode) || !config.dbPath || !config.scenarioId || config.scenarioId.length > 128)
    throw new Error('unsupported source, clock mode, db path or scenario identity');
}

export class InputError extends Error {
  constructor(message: string, readonly symbol: string | null = null, readonly eventTimeMs: number | null = null) { super(message); }
}

export function minuteOpen(eventTimeMs: number): number { return Math.floor(eventTimeMs / MINUTE_MS) * MINUTE_MS; }
export function decimalText(value: Decimal): string {
  const fixed = value.toFixed();
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

export function canonicalPositiveDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(value)) throw new InputError(`${label} must be a positive plain decimal string`);
  const parsed = new Money(value);
  if (!parsed.isFinite() || !parsed.gt(0)) throw new InputError(`${label} must be greater than zero`);
  return decimalText(parsed);
}

export function normalizeTrade(raw: unknown, symbols: readonly string[], venue: Trade['venue']): Trade {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('trade must be an object');
  const value = raw as Record<string, unknown>;
  const symbol = typeof value.symbol === 'string' ? value.symbol : null;
  const time = typeof value.eventTimeMs === 'number' && Number.isSafeInteger(value.eventTimeMs) ? value.eventTimeMs : null;
  // One store serves one configured source, so (symbol, minute) stays a unique bar key for readers and paging.
  if (value.venue !== venue) throw new InputError('venue does not match configured source', symbol, time);
  if (value.market !== 'spot') throw new InputError('unsupported market', symbol, time);
  if (!symbol || !symbols.includes(symbol)) throw new InputError('unknown symbol', symbol, time);
  if (typeof value.tradeId !== 'string' || !/^(?:0|[1-9]\d{0,39})$/.test(value.tradeId)) throw new InputError('invalid tradeId', symbol, time);
  if (time === null || time < 0 || time > Number.MAX_SAFE_INTEGER - MINUTE_MS - 10_000) throw new InputError('invalid eventTimeMs', symbol, time);
  try {
    return { venue, market: 'spot', symbol, tradeId: value.tradeId, eventTimeMs: time,
      price: canonicalPositiveDecimal(value.price, 'price'), quantity: canonicalPositiveDecimal(value.quantity, 'quantity') };
  } catch (error) {
    if (error instanceof InputError) throw new InputError(error.message, symbol, time);
    throw error;
  }
}

export function sameTrade(a: Trade, b: Trade): boolean {
  return a.eventTimeMs === b.eventTimeMs && a.price === b.price && a.quantity === b.quantity;
}

export function compareTradeOrder(aTime: number, aId: string, bTime: number, bId: string): number {
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  const ai = BigInt(aId), bi = BigInt(bId);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}
