// Deliberately independent from production contracts, decimal.js, reducer, and accepted-trade ledger.
// Fixed-point scale of 10^18 for each input and 10^36 for price * quantity.
type RawTrade = { venue: string; market: string; symbol: string; tradeId: string; eventTimeMs: number; price: string; quantity: string };
type Delivery = { kind: string; atMs: number; trade?: RawTrade };
export type ReferenceBar = { open: string; high: string; low: string; close: string; volume: string; quoteVolume: string; tradeCount: number };
const SCALE = 10n ** 18n;
const parse = (value: string): bigint => {
  if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(value)) throw new Error('bad oracle decimal');
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0') || '0');
};
const format = (scaled: bigint, scale: bigint): string => {
  const digits = scale.toString().length - 1;
  const whole = scaled / scale; const fraction = (scaled % scale).toString().padStart(digits, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
};

/** Content key of a trade as the oracle compares it: event time plus exact scaled price and quantity. */
export const oracleContent = (t: RawTrade): string => `${t.eventTimeMs}|${parse(t.price)}|${parse(t.quantity)}`;

/** Identity -> content of every delivery the reference rules admit (first valid, timely delivery wins). */
export function referenceAccepted(actions: Delivery[], graceMs = 2_000, futureToleranceMs = 5_000): Map<string, RawTrade & { p: bigint; q: bigint }> {
  const accepted = new Map<string, RawTrade & { p: bigint; q: bigint }>();
  for (const action of actions) {
    if (action.kind !== 'trade' || !action.trade) continue;
    const t = action.trade;
    const p = parse(t.price), q = parse(t.quantity);
    if (!Number.isSafeInteger(t.eventTimeMs) || p <= 0n || q <= 0n || !/^(?:0|[1-9]\d{0,39})$/.test(t.tradeId)) continue;
    const identity = `${t.venue}|${t.market}|${t.symbol}|${t.tradeId}`;
    if (accepted.has(identity)) continue;
    const minute = Math.floor(t.eventTimeMs / 60_000) * 60_000;
    if (t.eventTimeMs > action.atMs + futureToleranceMs || action.atMs >= minute + 60_000 + graceMs) continue;
    accepted.set(identity, { ...t, p, q });
  }
  return accepted;
}

export function referenceBars(actions: Delivery[], graceMs = 2_000, futureToleranceMs = 5_000): Map<string, ReferenceBar> {
  const groups = new Map<string, Array<RawTrade & { p: bigint; q: bigint }>>();
  for (const t of referenceAccepted(actions, graceMs, futureToleranceMs).values()) {
    const key = `${t.venue}|${t.market}|${t.symbol}|${Math.floor(t.eventTimeMs / 60_000) * 60_000}`;
    const group = groups.get(key) ?? []; group.push(t); groups.set(key, group);
  }
  const result = new Map<string, ReferenceBar>();
  for (const [key, trades] of groups) {
    trades.sort((a, b) => a.eventTimeMs - b.eventTimeMs || (BigInt(a.tradeId) < BigInt(b.tradeId) ? -1 : BigInt(a.tradeId) > BigInt(b.tradeId) ? 1 : 0));
    let high = trades[0]!.p, low = trades[0]!.p, volume = 0n, quote = 0n;
    for (const trade of trades) { if (trade.p > high) high = trade.p; if (trade.p < low) low = trade.p; volume += trade.q; quote += trade.p * trade.q; }
    result.set(key, { open: format(trades[0]!.p, SCALE), high: format(high, SCALE), low: format(low, SCALE),
      close: format(trades.at(-1)!.p, SCALE), volume: format(volume, SCALE), quoteVolume: format(quote, SCALE * SCALE), tradeCount: trades.length });
  }
  return result;
}
