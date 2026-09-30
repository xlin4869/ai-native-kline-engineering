// Deterministic tests of the optional Binance raw-trade source: no network. Lifecycle cases use a fake socket and
// fake timers; the replay case feeds a real captured stream (fixtures/binance) through the same adapter.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BinanceTradeSource, parseBinanceFrame, type SocketLike, type Timers } from '../src/binance-source.js';
import { barFromHistory } from '../src/aggregate.js';
import type { HistoryAggregate } from '../src/contracts.js';
import { Reconciler } from '../src/reconciler.js';
import { referenceBars } from './oracle.js';
import { M, harness } from './support.js';

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  closed: { code?: number; reason?: string } | null = null;
  constructor(readonly url: string) {}
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
  send(text: string): void { this.onmessage?.({ data: text }); }
}
class FakeTimers implements Timers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  setTimeout(fn: () => void, ms: number): unknown { const id = this.next++; this.pending.set(id, { fn, ms }); return id; }
  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }
  delays(): number[] { return [...this.pending.values()].map(t => t.ms); }
  fire(ms: number): void {
    const entry = [...this.pending.entries()].find(([, t]) => t.ms === ms);
    assert.ok(entry, `no pending timer of ${ms} ms (pending: ${this.delays()})`);
    this.pending.delete(entry[0]); entry[1].fn();
  }
}
const frame = (id: number | string, tradeTimeMs: number, price = '100.00000000', qty = '0.50000000', symbol = 'BTCUSDT') =>
  `{"stream":"${symbol.toLowerCase()}@trade","data":{"e":"trade","E":${tradeTimeMs + 1},"s":"${symbol}","t":${id},"p":"${price}","q":"${qty}","T":${tradeTimeMs},"m":true,"M":true}}`;

function live(overrides: Parameters<typeof harness>[0] = {}) {
  const h = harness({ source: 'binance', symbols: ['BTCUSDT'], ...overrides });
  const sockets: FakeSocket[] = []; const timers = new FakeTimers();
  const source = new BinanceTradeSource(h.coordinator, { symbols: ['BTCUSDT'], timers, random: () => 0,
    socketFactory: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; } });
  return { ...h, sockets, timers, source };
}

test('parser maps the documented @trade fields and keeps trade IDs above 2^53 exact', () => {
  const parsed = parseBinanceFrame(frame('9007199254740993', M + 1_000, '84594.09000000', '0.00007000'), ['BTCUSDT']);
  assert.deepEqual(parsed, { kind: 'trade', trade: { venue: 'binance', market: 'spot', symbol: 'BTCUSDT', tradeId: '9007199254740993',
    eventTimeMs: M + 1_000, price: '84594.09000000', quantity: '0.00007000' } });
  assert.equal(Number('9007199254740993'), 9007199254740992, 'a JSON number would have been rounded');
  assert.equal(parseBinanceFrame('{"e":"serverShutdown","E":1}', ['BTCUSDT']).kind, 'shutdown');
  assert.equal(parseBinanceFrame('{"stream":"!serverShutdown","data":{"e":"serverShutdown","E":1}}', ['BTCUSDT']).kind, 'shutdown');
  assert.equal(parseBinanceFrame('{"result":null,"id":1}', ['BTCUSDT']).kind, 'ignored');
  assert.equal(parseBinanceFrame('not json', ['BTCUSDT']).kind, 'malformed');
  assert.equal(parseBinanceFrame(frame(1, M, '1', '1', 'ETHUSDT'), ['BTCUSDT']).kind, 'malformed');
  assert.equal(parseBinanceFrame(frame(1, M).replace('"s":"BTCUSDT"', '"s":"ETHUSDT"'), ['BTCUSDT', 'ETHUSDT']).kind, 'malformed');
});

test('connect, trade, duplicate across reconnect, fenced stale socket, gap from last frame', async () => {
  const s = live();
  try {
    s.source.start();
    assert.equal(s.sockets[0]!.url, 'wss://data-stream.binance.vision/stream?streams=btcusdt@trade');
    s.sockets[0]!.onopen!();
    s.clock.advanceTo(M + 1_100); s.sockets[0]!.send(frame(10, M + 1_000));
    s.clock.advanceTo(M + 1_200); s.sockets[0]!.send(frame(11, M + 1_150, '101.00000000'));
    s.clock.advanceTo(M + 3_000);
    s.sockets[0]!.onerror!({}); s.sockets[0]!.onclose!({ code: 1006 }); // one drop, not two
    assert.deepEqual(s.timers.delays(), [500], 'first reconnect after base * 0.5 jitter');
    s.timers.fire(500);
    s.clock.advanceTo(M + 3_600); s.sockets[1]!.onopen!();
    s.sockets[0]!.send(frame(12, M + 3_500, '999.00000000')); // late frame from the replaced socket is fenced out
    s.clock.advanceTo(M + 3_700); s.sockets[1]!.send(frame(11, M + 1_150, '101.00000000')); // redelivered across reconnect
    s.clock.advanceTo(M + 3_800); s.sockets[1]!.send(frame(13, M + 3_750, '99.00000000'));
    await s.coordinator.drain();
    assert.deepEqual(s.coordinator.decisions.map(x => x.kind), ['source', 'accepted', 'accepted', 'source', 'source', 'duplicate', 'accepted']);
    const bar = s.store.current('BTCUSDT').bars[0]!;
    assert.deepEqual([bar.venue, bar.open, bar.high, bar.low, bar.close, bar.tradeCount], ['binance', '100', '101', '99', '99', 3]);
    const gap = s.store.coverage('BTCUSDT', M, M + 60_000, 100).events.find(x => x.reason === 'source_gap')!;
    assert.deepEqual([gap.startMs - M, gap.endMs! - M], [1_200, 3_600], 'the gap starts at the last received frame, not at detection');
    assert.deepEqual(s.source.counts, { frames: 4, trades: 4, refused: 0, malformed: 0, ignored: 0, connects: 2, drops: 1 });
  } finally { s.close(); }
});

test('backoff grows and caps; serverShutdown and max age reconnect at once; silence is a drop', async () => {
  const s = live();
  try {
    s.source.start();
    for (const expected of [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) { // closes before open: failed attempts
      s.sockets.at(-1)!.onclose!({ code: 1006 });
      assert.deepEqual(s.timers.delays(), [expected]);
      s.timers.fire(expected);
    }
    s.sockets.at(-1)!.onopen!();
    s.clock.advanceTo(M + 5_000); s.sockets.at(-1)!.send('{"e":"serverShutdown","E":1}');
    assert.deepEqual(s.timers.delays(), [0], 'serverShutdown reconnects immediately and resets backoff');
    s.timers.fire(0); s.sockets.at(-1)!.onopen!();
    assert.ok(s.timers.delays().includes(85_800_000) && s.timers.delays().includes(60_000));
    s.clock.advanceTo(M + 6_000); s.sockets.at(-1)!.send(frame(1, M + 5_900));
    s.clock.advanceTo(M + 66_000); s.timers.fire(60_000); // silence watchdog
    await s.coordinator.drain();
    const gaps = s.store.coverage('BTCUSDT', M, M + 120_000, 100).events.filter(x => x.reason === 'source_gap' && x.endMs === null);
    assert.deepEqual(gaps.map(x => x.startMs - M), [6_000], 'the silent minute is not presented as observed');
    assert.equal(s.store.meta().sourceState, 'disconnected');
  } finally { s.close(); }
});

test('overflow halts the live source instead of reconnect-looping; stop is clean', async () => {
  const s = live({ maxQueue: 1 });
  try {
    s.source.start(); s.sockets[0]!.onopen!();
    s.clock.advanceTo(M + 1_100);
    s.sockets[0]!.send(frame(1, M + 1_000));
    s.sockets[0]!.send(frame(2, M + 1_050)); // no drain in between: the data queue is full
    assert.deepEqual(s.sockets[0]!.closed, { code: 1011, reason: 'intake halted' });
    assert.deepEqual(s.timers.delays(), [], 'no reconnect after halt');
    await s.coordinator.drain();
    assert.equal(s.coordinator.writerFault, 'overflow');
    const bar = s.store.current('BTCUSDT').bars[0]!;
    assert.equal(bar.quality.completeness, 'known_incomplete');
    assert.ok(bar.quality.reasons.includes('overflow'));
  } finally { s.close(); }

  const clean = live();
  try {
    clean.source.start(); clean.sockets[0]!.onopen!();
    clean.clock.advanceTo(M + 1_100); clean.sockets[0]!.send(frame(1, M + 1_000));
    clean.sockets[0]!.send(frame('2', M + 1_050, 'abc')); // malformed price is recorded, not dropped
    clean.clock.advanceTo(M + 2_000);
    await clean.source.stop();
    assert.deepEqual(clean.coordinator.decisions.map(x => x.kind), ['source', 'accepted', 'invalid', 'source']);
    assert.equal(clean.store.meta().sourceState, 'stopped');
    assert.deepEqual(clean.timers.delays(), []);
    assert.equal(clean.sockets[0]!.closed?.code, 1000);
  } finally { clean.close(); }
});

type Capture = { events: Array<{ r: number; type: string }>; frames: Array<[number, string]>; klines: Record<string, unknown[][]> };
const canonical = (value: string) => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;

test('captured Binance stream replays deterministically and matches the exchange 1m klines', async () => {
  const capture = JSON.parse(readFileSync(new URL('../fixtures/binance/btcusdt-capture.json', import.meta.url), 'utf8')) as Capture;
  const openedAt = capture.events.find(e => e.type === 'open')!.r;
  const h = harness({ source: 'binance', symbols: ['BTCUSDT'] }, openedAt);
  const sockets: FakeSocket[] = [];
  const source = new BinanceTradeSource(h.coordinator, { symbols: ['BTCUSDT'], timers: new FakeTimers(),
    socketFactory: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; } });
  try {
    source.start(); sockets[0]!.onopen!();
    let nextTick = openedAt + 1_000;
    const deliveries: Array<{ kind: 'trade'; atMs: number; trade: { venue: string; market: string; symbol: string; tradeId: string; eventTimeMs: number; price: string; quantity: string } }> = [];
    for (const [receivedAt, text] of capture.frames) {
      for (; nextTick <= receivedAt; nextTick += 1_000) { h.coordinator.enqueueTick(nextTick); await h.coordinator.drain(); }
      h.clock.advanceTo(receivedAt);
      sockets[0]!.send(text);
      const parsed = parseBinanceFrame(text, ['BTCUSDT']);
      assert.equal(parsed.kind, 'trade');
      if (parsed.kind === 'trade') deliveries.push({ kind: 'trade', atMs: receivedAt, trade: parsed.trade as typeof deliveries[number]['trade'] });
      await h.coordinator.drain();
    }
    const lastReceive = capture.frames.at(-1)![0];
    // Replay the recorded end of the capture; without it the last minute would falsely look fully observed.
    const closedAt = capture.events.find(e => e.type === 'close')!.r;
    h.clock.advanceTo(closedAt); sockets[0]!.onclose!({ code: 1000 });
    const ids = deliveries.map(d => BigInt(d.trade.tradeId));
    const unique = new Set(ids.map(String));
    const minId = ids.reduce((a, b) => (b < a ? b : a)), maxId = ids.reduce((a, b) => (b > a ? b : a));
    assert.equal(BigInt(unique.size), maxId - minId + 1n, 'captured trade IDs are contiguous: no trade missing inside the capture');
    h.coordinator.enqueueTick(Math.floor(lastReceive / 60_000) * 60_000 + 62_000); await h.coordinator.drain();

    const expected = referenceBars(deliveries);
    const bars = h.store.bars('BTCUSDT', Math.floor(openedAt / 60_000) * 60_000, lastReceive + 60_000, 1_000).bars;
    assert.equal(bars.length, [...expected.keys()].length);
    for (const bar of bars) {
      const ref = expected.get(`binance|spot|BTCUSDT|${bar.openTimeMs}`)!;
      assert.deepEqual([bar.open, bar.high, bar.low, bar.close, bar.volume, bar.quoteVolume, bar.tradeCount],
        [ref.open, ref.high, ref.low, ref.close, ref.volume, ref.quoteVolume, ref.tradeCount], `oracle ${bar.openTimeMs}`);
    }
    // Minutes whose whole receive window lies inside the capture carry no reason and must equal the exchange kline.
    let compared = 0;
    for (const bar of bars.filter(b => b.quality.reasons.length === 0 && b.state === 'closed')) {
      const row = capture.klines.BTCUSDT!.find(k => k[0] === bar.openTimeMs)!;
      assert.ok(row, `exchange kline for ${bar.openTimeMs}`);
      const exchange: unknown[] = [row[1], row[2], row[3], row[4], row[5], row[7]].map(v => canonical(String(v)));
      assert.deepEqual([bar.open, bar.high, bar.low, bar.close, bar.volume, bar.quoteVolume, bar.tradeCount], [...exchange, row[8]],
        `exchange kline ${new Date(bar.openTimeMs).toISOString()}`);
      compared++;
    }
    assert.ok(compared >= 2, `at least two fully observed minutes compared with the exchange (got ${compared})`);
    process.stdout.write(`# exchange kline comparisons ${JSON.stringify({ frames: capture.frames.length, bars: bars.length, comparedWithExchange: compared,
      minutes: bars.map(b => ({ open: new Date(b.openTimeMs).toISOString(), trades: b.tradeCount, reasons: b.quality.reasons })) })}
`);
    assert.ok(bars[0]!.quality.reasons.includes('startup_partial'), 'the minute the capture started in is marked partial');
    assert.ok(bars.at(-1)!.quality.reasons.includes('source_gap'), 'the minute the capture ended in is marked partial');
  } finally { h.close(); }
});

test('captured stream with an injected disconnect is repaired from aggTrades history to equal every exchange kline', async () => {
  const capture = JSON.parse(readFileSync(new URL('../fixtures/binance/btcusdt-capture.json', import.meta.url), 'utf8')) as Capture
    & { aggTrades: Record<string, Record<string, HistoryAggregate[]>> };
  const klines = capture.klines.BTCUSDT!;
  const exchange = (row: unknown[]) => [row[1], row[2], row[3], row[4], row[5], row[7]].map(v => canonical(String(v))).concat([row[8] as never]);
  // The history alone reproduces the exchange's klines, including minutes the capture only partly saw.
  for (const row of klines) {
    const bar = barFromHistory('binance', 'BTCUSDT', row[0] as number, capture.aggTrades.BTCUSDT![String(row[0])] ?? []);
    if (!bar) continue;
    assert.deepEqual([bar.open, bar.high, bar.low, bar.close, bar.volume, bar.quoteVolume, bar.tradeCount], exchange(row), `history ${row[0]}`);
  }
  const openedAt = capture.events.find(e => e.type === 'open')!.r;
  const h = harness({ source: 'binance', symbols: ['BTCUSDT'] }, openedAt);
  const sockets: FakeSocket[] = []; const timers = new FakeTimers();
  const source = new BinanceTradeSource(h.coordinator, { symbols: ['BTCUSDT'], timers, random: () => 0,
    socketFactory: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; } });
  const dropFrom = Math.floor(openedAt / 60_000) * 60_000 + 90_000, dropTo = dropFrom + 40_000; // crosses a minute boundary
  try {
    source.start(); sockets[0]!.onopen!();
    let dropped = false; let reconnected = false; let nextTick = openedAt + 1_000;
    const tickUntil = async (t: number) => { for (; nextTick <= t; nextTick += 1_000) { h.coordinator.enqueueTick(nextTick); await h.coordinator.drain(); } };
    for (const [receivedAt, text] of capture.frames) {
      if (!dropped && receivedAt >= dropFrom) {
        await tickUntil(dropFrom); h.clock.advanceTo(dropFrom); sockets.at(-1)!.onclose!({ code: 1006 }); dropped = true;
      }
      if (receivedAt >= dropFrom && receivedAt < dropTo) { await tickUntil(receivedAt); continue; } // lost while disconnected
      if (dropped && !reconnected) {
        await tickUntil(dropTo); h.clock.advanceTo(dropTo); timers.fire(500); sockets.at(-1)!.onopen!(); reconnected = true;
      }
      await tickUntil(receivedAt);
      h.clock.advanceTo(receivedAt); sockets.at(-1)!.send(text);
      await h.coordinator.drain();
    }
    h.clock.advanceTo(capture.events.find(e => e.type === 'close')!.r); sockets.at(-1)!.onclose!({ code: 1000 });
    h.coordinator.enqueueTick(Math.floor(capture.frames.at(-1)![0] / 60_000) * 60_000 + 70_000); await h.coordinator.drain();
    const history = { name: 'fixture-aggTrades', aggregates: async (symbol: string, open: number) => {
      const rows = capture.aggTrades[symbol]?.[String(open)];
      if (!rows) throw new Error(`no recorded history for ${open}`);
      return rows;
    } };
    const reconciler = new Reconciler(h.coordinator, history, { policy: 'flagged' });
    while (await reconciler.runOnce() > 0) { /* all flagged minutes */ }
    const bars = h.store.bars('BTCUSDT', Math.floor(openedAt / 60_000) * 60_000, capture.frames.at(-1)![0] + 60_000, 100).bars;
    assert.equal(bars.length, 4);
    for (const bar of bars) {
      const row = klines.find(k => k[0] === bar.openTimeMs)!;
      assert.deepEqual([bar.open, bar.high, bar.low, bar.close, bar.volume, bar.quoteVolume, bar.tradeCount], exchange(row),
        `after reconciliation ${new Date(bar.openTimeMs).toISOString()} (${bar.quality.reasons})`);
      assert.equal(bar.quality.completeness, 'reconciled');
    }
    const repaired = bars.filter(bar => bar.quality.reasons.includes('repaired')).map(bar => new Date(bar.openTimeMs).toISOString().slice(11, 16));
    process.stdout.write(`# injected-disconnect repair ${JSON.stringify({ droppedFrames: capture.frames.filter(([r]) => r >= dropFrom && r < dropTo).length, repaired })}\n`);
    assert.ok(repaired.length >= 3, 'startup, both gapped minutes and the final partial minute were repaired');
  } finally { h.close(); }
});
