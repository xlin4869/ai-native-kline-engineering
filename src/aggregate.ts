import { BarRow, InputError, MINUTE_MS, Money, canonicalPositiveDecimal, compareTradeOrder, decimalText, minuteOpen,
  type HistoryAggregate, type Trade } from './contracts.js';

export function reduceTrade(prior: BarRow | null, trade: Trade): BarRow {
  const openTimeMs = minuteOpen(trade.eventTimeMs);
  const quote = decimalText(new Money(trade.price).mul(trade.quantity));
  if (!prior) return {
    venue: trade.venue, market: 'spot', symbol: trade.symbol, openTimeMs, endTimeMs: openTimeMs + 60_000,
    open: trade.price, high: trade.price, low: trade.price, close: trade.price,
    volume: trade.quantity, quoteVolume: quote, tradeCount: 1,
    firstTimeMs: trade.eventTimeMs, firstTradeId: trade.tradeId,
    lastTimeMs: trade.eventTimeMs, lastTradeId: trade.tradeId,
    state: 'open', valueRevision: 0,
  };
  if (prior.openTimeMs !== openTimeMs || prior.venue !== trade.venue || prior.symbol !== trade.symbol) throw new Error('bar key mismatch');
  if (prior.state !== 'open') throw new Error('closed bar cannot be revised');
  if (prior.tradeCount >= 1_000_000) throw new Error('minute trade count limit');
  const first = compareTradeOrder(trade.eventTimeMs, trade.tradeId, prior.firstTimeMs, prior.firstTradeId) < 0;
  const last = compareTradeOrder(trade.eventTimeMs, trade.tradeId, prior.lastTimeMs, prior.lastTradeId) > 0;
  return {
    ...prior, open: first ? trade.price : prior.open, close: last ? trade.price : prior.close,
    high: new Money(trade.price).gt(prior.high) ? trade.price : prior.high,
    low: new Money(trade.price).lt(prior.low) ? trade.price : prior.low,
    volume: decimalText(new Money(prior.volume).add(trade.quantity)),
    quoteVolume: decimalText(new Money(prior.quoteVolume).add(quote)), tradeCount: prior.tradeCount + 1,
    firstTimeMs: first ? trade.eventTimeMs : prior.firstTimeMs, firstTradeId: first ? trade.tradeId : prior.firstTradeId,
    lastTimeMs: last ? trade.eventTimeMs : prior.lastTimeMs, lastTradeId: last ? trade.tradeId : prior.lastTradeId,
  };
}

/**
 * Rebuilds a minute from a venue's complete trade history (aggregates of consecutive raw trade IDs at one price
 * and time) with the same ordering and decimal rules as reduceTrade. The history must cover a contiguous raw-ID
 * range; a hole means the history itself is incomplete and nothing is reconciled.
 */
export function barFromHistory(venue: Trade['venue'], symbol: string, openTimeMs: number, aggregates: readonly HistoryAggregate[]): BarRow | null {
  if (!aggregates.length) return null;
  const items = aggregates.map(item => {
    if (!/^(?:0|[1-9]\d{0,39})$/.test(item.firstTradeId) || !/^(?:0|[1-9]\d{0,39})$/.test(item.lastTradeId) ||
        BigInt(item.firstTradeId) > BigInt(item.lastTradeId)) throw new InputError('history: invalid trade-ID range', symbol);
    if (!Number.isSafeInteger(item.eventTimeMs) || item.eventTimeMs < openTimeMs || item.eventTimeMs >= openTimeMs + MINUTE_MS)
      throw new InputError('history: trade time outside the minute', symbol);
    return { ...item, price: canonicalPositiveDecimal(item.price, 'history price'), quantity: canonicalPositiveDecimal(item.quantity, 'history quantity') };
  }).sort((a, b) => (BigInt(a.firstTradeId) < BigInt(b.firstTradeId) ? -1 : 1));
  for (let i = 1; i < items.length; i++)
    if (BigInt(items[i]!.firstTradeId) !== BigInt(items[i - 1]!.lastTradeId) + 1n) throw new InputError('history: trade IDs are not contiguous', symbol);
  let bar: BarRow | null = null; let count = 0n;
  for (const item of items) {
    const units = BigInt(item.lastTradeId) - BigInt(item.firstTradeId) + 1n;
    // One aggregate carries one price, so its quote volume is price x total quantity.
    bar = reduceTrade(bar, { venue, market: 'spot', symbol, tradeId: item.firstTradeId, eventTimeMs: item.eventTimeMs, price: item.price, quantity: item.quantity });
    count += units;
  }
  const last = items.find(item => item.firstTradeId === bar!.lastTradeId)!;
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new InputError('history: trade count too large', symbol);
  return { ...bar!, tradeCount: Number(count), lastTradeId: last.lastTradeId };
}
