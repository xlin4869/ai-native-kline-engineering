import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { referenceBars } from './oracle.js';
import { M, harness, trade } from './support.js';

test('independent BigInt oracle matches hand-calculated golden constant', () => {
  const scenario = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));
  const bar = referenceBars(scenario.actions).get(`mock|spot|BTCUSDT|${M}`);
  assert.deepEqual(bar, { open: '100', high: '103', low: '99', close: '103', volume: '6', quoteVolume: '600', tradeCount: 3 });
});

test('independent oracle agrees with production across fixed-seed out-of-order corpus', async () => {
  const h = harness();
  try {
    let seed = 20260925;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const actions: Array<{ kind: 'trade'; atMs: number; trade: ReturnType<typeof trade> }> = [];
    for (let i = 0; i < 150; i++) {
      const eventOffset = Math.floor(random() * 55_000);
      const price = `${90 + Math.floor(random() * 20)}.${String(Math.floor(random() * 100)).padStart(2, '0')}`;
      const quantity = `${1 + Math.floor(random() * 5)}.${String(Math.floor(random() * 100)).padStart(2, '0')}`;
      const t = trade(String(i + 1), eventOffset, price, quantity);
      actions.push({ kind: 'trade', atMs: M + 59_000 + i, trade: t });
      if (i % 13 === 0) actions.push({ kind: 'trade', atMs: M + 59_000 + i, trade: t });
    }
    for (const action of actions) h.coordinator.enqueueTrade(action.trade, action.atMs);
    await h.coordinator.drain();
    const expected = referenceBars(actions).get(`mock|spot|BTCUSDT|${M}`)!;
    const actual = h.store.bars('BTCUSDT', M, M + 60_000, 100).bars[0]!;
    for (const key of ['open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'tradeCount'] as const) assert.equal(actual[key], expected[key], `${key} seed=20260925`);
  } finally { h.close(); }
});

test('doubling every eligible quantity and duplicate copy doubles V/Q only', async () => {
  const baseline = harness(); const doubled = harness();
  try {
    const inputs = [trade('10', 1_000, '100', '0.125'), trade('2', 1_000, '10000', '2.3'), trade('11', 2_000, '101', '1')];
    const scaled = [trade('10', 1_000, '100', '0.25'), trade('2', 1_000, '10000', '4.6'), trade('11', 2_000, '101', '2')];
    for (const [h, set] of [[baseline, inputs], [doubled, scaled]] as const) {
      h.coordinator.enqueueSource('connected', M);
      for (const t of [...set, set[0]!]) h.coordinator.enqueueTrade(t, M + 3_000);
      await h.coordinator.drain();
    }
    const a = baseline.store.current('BTCUSDT').bars[0]!;
    const b = doubled.store.current('BTCUSDT').bars[0]!;
    assert.deepEqual([a.open, a.high, a.low, a.close, a.tradeCount], [b.open, b.high, b.low, b.close, b.tradeCount]);
    const oracleA = referenceBars([...inputs, inputs[0]!].map(t => ({ kind: 'trade', atMs: M + 3_000, trade: t }))).get(`mock|spot|BTCUSDT|${M}`)!;
    const oracleB = referenceBars([...scaled, scaled[0]!].map(t => ({ kind: 'trade', atMs: M + 3_000, trade: t }))).get(`mock|spot|BTCUSDT|${M}`)!;
    assert.deepEqual([a.volume, a.quoteVolume], [oracleA.volume, oracleA.quoteVolume]);
    assert.deepEqual([b.volume, b.quoteVolume], [oracleB.volume, oracleB.quoteVolume]);
    assert.deepEqual([a.volume, a.quoteVolume, b.volume, b.quoteVolume], ['3.425', '23113.5', '6.85', '46227']);
  } finally { baseline.close(); doubled.close(); }
});

test('maximum declared decimal and 40-digit trade ID remain exact', async () => {
  const h = harness();
  try {
    const extreme = trade('9999999999999999999999999999999999999999', 1_000,
      '999999999999999999.999999999999999999', '999999999999999999.999999999999999999');
    const action = { kind: 'trade', atMs: M + 1_100, trade: extreme };
    h.coordinator.enqueueTrade(extreme, action.atMs); await h.coordinator.drain();
    const expected = referenceBars([action]).get(`mock|spot|BTCUSDT|${M}`)!;
    const actual = h.store.current('BTCUSDT').bars[0]!;
    assert.deepEqual([actual.open, actual.volume, actual.quoteVolume], [expected.open, expected.volume, expected.quoteVolume]);
    assert.equal(actual.tradeCount, 1);
  } finally { h.close(); }
});
