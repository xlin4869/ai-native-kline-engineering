import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../src/contracts.js';
import { Coordinator } from '../src/coordinator.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { M, harness, trade } from './support.js';

test('deadline before/at/after, delayed queue processing, duplicate after close', async () => {
  const h = harness();
  try {
    h.coordinator.enqueueTrade(trade('1', 59_900), M + 61_999);
    h.clock.advanceTo(M + 64_000);
    await h.coordinator.drain();
    assert.equal(h.coordinator.decisions.at(-1)?.kind, 'accepted');
    h.coordinator.enqueueTrade(trade('2', 59_901), M + 64_000);
    h.coordinator.enqueueTrade(trade('1', 59_900), M + 64_001);
    await h.coordinator.drain();
    assert.deepEqual(h.coordinator.decisions.slice(-2).map(x => x.kind), ['late', 'duplicate']);
    const bar = h.store.bars('BTCUSDT', M, M + 60_000, 100).bars[0]!;
    assert.equal(bar.state, 'closed');
    assert.equal(bar.tradeCount, 1);
    assert.equal(bar.quality.completeness, 'known_incomplete');
    assert.deepEqual(bar.quality.reasons, ['late_rejected', 'source_gap', 'startup_partial']);
  } finally { h.close(); }
});

test('conflict preserves first fact; equivalent decimal duplicate is idempotent', async () => {
  const h = harness();
  try {
    h.coordinator.enqueueTrade(trade('1', 1_000, '100', '2'), M + 1_100);
    h.coordinator.enqueueTrade(trade('1', 1_000, '100.0', '2.00'), M + 1_200);
    h.coordinator.enqueueTrade(trade('1', 1_000, '101', '2'), M + 1_300);
    await h.coordinator.drain();
    assert.deepEqual(h.coordinator.decisions.map(x => x.kind), ['accepted', 'duplicate', 'conflict']);
    const bar = h.store.current('BTCUSDT').bars[0]!;
    assert.equal(bar.volume, '2');
    assert.equal(bar.open, '100');
    assert.deepEqual(bar.quality.reasons, ['conflicting_identity', 'source_gap', 'startup_partial']);
    assert.equal(bar.quality.completeness, 'unverified');
  } finally { h.close(); }
});

test('future rejection does not occupy identity; tick is immutable and closes only at deadline', async () => {
  const h = harness();
  try {
    h.coordinator.enqueueTrade(trade('1', 20_000), M + 1_000);
    h.coordinator.enqueueTick(M + 1_100);
    assert.equal(h.coordinator.enqueueTick(M + 62_000), false);
    await h.coordinator.drain();
    assert.deepEqual(h.coordinator.decisions.map(x => x.kind), ['future', 'tick']);
    h.coordinator.enqueueTrade(trade('1', 20_000), M + 20_100);
    await h.coordinator.drain();
    assert.equal(h.coordinator.decisions.at(-1)?.kind, 'accepted');
    assert.equal(h.store.current('BTCUSDT').bars.length, 1);
    h.coordinator.enqueueTick(M + 62_000); await h.coordinator.drain();
    assert.equal(h.store.current('BTCUSDT').bars.length, 0);
  } finally { h.close(); }
});

test('queue saturation preserves queued trade and surfaces a fault', async () => {
  const h = harness({ maxQueue: 1 });
  try {
    assert.equal(h.coordinator.enqueueTrade(trade('1', 1_000), M + 1_100), true);
    assert.equal(h.coordinator.enqueueTrade(trade('2', 1_200), M + 1_300), false);
    await h.coordinator.drain();
    assert.deepEqual(h.coordinator.decisions.map(x => x.kind), ['accepted', 'fault']);
    assert.equal(h.store.current('BTCUSDT').bars[0]?.tradeCount, 1);
    assert.equal(h.coordinator.writerFault, 'overflow');
  } finally { h.close(); }
});

test('source gap during grace contaminates previous minute and exists without a bar', async () => {
  const h = harness();
  try {
    h.coordinator.enqueueSource('connected', M);
    h.coordinator.enqueueTrade(trade('1', 10_000), M + 10_100);
    h.coordinator.enqueueSource('disconnected', M + 61_000);
    h.coordinator.enqueueSource('connected', M + 62_000);
    await h.coordinator.drain();
    const bar = h.store.bars('BTCUSDT', M, M + 60_000, 100).bars[0]!;
    // M is also a start minute: a trade stamped just after M could have been received before the service existed.
    assert.deepEqual(bar.quality.reasons, ['source_gap', 'startup_partial']);
    assert.equal(bar.quality.completeness, 'unverified');
    assert.equal(h.store.coverage('ETHUSDT', M + 60_000, M + 120_000, 100).events.some(x => x.reason === 'source_gap'), true);
  } finally { h.close(); }
});

test('strict deadline equality, minute boundary, and cross-symbol identity', async () => {
  const h = harness();
  try {
    h.coordinator.enqueueSource('connected', M);
    h.coordinator.enqueueTrade(trade('1', 59_999, '100'), M + 61_999);
    h.coordinator.enqueueTrade(trade('2', 59_999, '99'), M + 62_000);
    h.coordinator.enqueueTrade(trade('1', 60_000, '101', '1', 'ETHUSDT'), M + 62_001);
    await h.coordinator.drain();
    assert.deepEqual(h.coordinator.decisions.filter(x => !['source'].includes(x.kind)).map(x => x.kind), ['accepted', 'late', 'accepted']);
    assert.equal(h.store.bars('BTCUSDT', M, M + 60_000, 100).bars[0]?.tradeCount, 1);
    assert.equal(h.store.bars('ETHUSDT', M + 60_000, M + 120_000, 100).bars[0]?.open, '101');
  } finally { h.close(); }
});

test('invalid decimal does not reserve trade ID; capacity fault retains old bar', async () => {
  const h = harness({ maxTrades: 1 });
  try {
    h.coordinator.enqueueSource('connected', M);
    h.coordinator.enqueueTrade({ ...trade('1', 1_000), price: '1e2' }, M + 1_100);
    h.coordinator.enqueueTrade(trade('1', 1_000), M + 1_200);
    h.coordinator.enqueueTrade(trade('2', 2_000), M + 2_100);
    await h.coordinator.drain();
    assert.deepEqual(h.coordinator.decisions.map(x => x.kind), ['source', 'invalid', 'accepted', 'resource_limit']);
    assert.equal(h.store.current('BTCUSDT').bars[0]?.tradeCount, 1);
    assert.equal(h.coordinator.writerFault, 'resource_limit');
  } finally { h.close(); }
});

test('clock fault freezes close, while earlier queued trade commits', async () => {
  const config = { ...DEFAULT_CONFIG, clockMode: 'real' as const };
  let at = M; let drift = 0;
  const clock = { mode: 'real' as const, now: () => at, driftMs: () => drift };
  const store = new SqliteStore(config); const coordinator = new Coordinator(store, clock, config);
  try {
    at = M + 1_100; coordinator.enqueueTrade(trade('1', 1_000));
    at = M + 62_000; drift = 2_000; assert.equal(coordinator.enqueueTick(), false);
    await coordinator.drain();
    assert.deepEqual(coordinator.decisions.map(x => x.kind), ['accepted', 'fault']);
    assert.equal(store.current('BTCUSDT').bars[0]?.state, 'open');
    assert.equal(coordinator.writerFault, 'clock_untrusted');
  } finally { store.close(); }
});

test('quality capacity failure becomes a durable fault instead of silent truncation', async () => {
  // Rows: startup_partial, the retracted start gap, then one invalid_input row per minute.
  const h = harness({ maxQualityEvents: 4 });
  try {
    h.coordinator.enqueueSource('connected', M); await h.coordinator.drain();
    for (let i = 1; i <= 3; i++) {
      h.coordinator.enqueueTrade({ ...trade(String(i), i * 60_000 + 1_000), price: 'bad' }, M + i * 60_000 + 1_100); // distinct minutes
      await h.coordinator.drain();
    }
    assert.match(h.coordinator.writerFault ?? '', /quality event capacity reached/);
    assert.match(h.store.meta().writerFault ?? '', /quality event capacity reached/);
    const events = h.store.coverage('BTCUSDT', M - 60_000, M + 240_000, 100).events;
    assert.deepEqual(events.map(x => x.reason), ['startup_partial', 'invalid_input', 'invalid_input', 'writer_fault']);
    assert.equal(events.at(-1)!.knownIncomplete, true, 'the refused delivery is a known miss');
    assert.equal(h.coordinator.enqueueTrade(trade('4', 185_000), M + 185_100), false);
  } finally { h.close(); }
});

test('semantic limits reject invalid service configuration', () => {
  assert.throws(() => new SqliteStore({ ...DEFAULT_CONFIG, symbols: ['BTCUSDT', 'BTCUSDT'] }), /distinct/);
  assert.throws(() => new SqliteStore({ ...DEFAULT_CONFIG, graceMs: 10_001 }), /graceMs/);
  assert.throws(() => new SqliteStore({ ...DEFAULT_CONFIG, maxTrades: 500_001 }), /maxTrades/);
});

test('source EOF before grace does not force numeric closure or invent empty bars', async () => {
  const h = harness();
  try {
    h.coordinator.enqueueSource('connected', M);
    h.coordinator.enqueueTrade(trade('1', 1_000), M + 1_100);
    h.coordinator.enqueueSource('stopped', M + 10_000);
    await h.coordinator.drain();
    assert.equal(h.store.current('BTCUSDT').bars[0]?.state, 'open');
    assert.equal(h.store.bars('ETHUSDT', M, M + 120_000, 100).bars.length, 0);
  } finally { h.close(); }
});

test('control event limit keeps first eight events and reserves visible fault', async () => {
  const h = harness();
  try {
    for (let i = 0; i < 8; i++) assert.equal(h.coordinator.enqueueSource(i % 2 ? 'disconnected' : 'connected', M + i), true);
    assert.equal(h.coordinator.enqueueSource('connected', M + 8), false);
    await h.coordinator.drain();
    assert.deepEqual(h.coordinator.decisions.map(x => x.kind), [...Array(8).fill('source'), 'fault']);
    assert.equal(h.coordinator.writerFault, 'overflow');
    assert.equal(h.store.coverage('BTCUSDT', M, M + 60_000, 100).events.some(x => x.reason === 'overflow'), true);
  } finally { h.close(); }
});
