// Regression tests for defects found in the independent review (see results/review.md, findings F1-F6).
// Each test failed on the reviewed 798d29c3 archive and passes after the fix.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { VirtualClock } from '../src/clock.js';
import { Coordinator } from '../src/coordinator.js';
import { DEFAULT_CONFIG } from '../src/contracts.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { M, harness, trade } from './support.js';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'trade-kline-review-'));
  const opened: SqliteStore[] = [];
  const track = (store: SqliteStore) => { opened.push(store); return store; };
  const cleanup = () => {
    // Close even after a failed assertion so the failure, not a Windows EBUSY, is what gets reported.
    for (const store of opened) try { store.close(); } catch { /* the assertion already reported the failure */ }
    const target = resolve(dir), root = resolve(tmpdir()) + sep;
    if (!target.startsWith(root) || !target.includes('trade-kline-review-')) throw new Error('unsafe cleanup path');
    rmSync(target, { recursive: true, force: true });
  };
  return { path: join(dir, 'service.db'), track, cleanup };
}

test('F1 nothing queued behind a failed write commits, and the loss is visible on the bar', async () => {
  let calls = 0;
  const config = { ...DEFAULT_CONFIG };
  const store = new SqliteStore(config, { beforeCommit: () => { if (++calls === 3) throw new Error('injected write failure'); } });
  const coordinator = new Coordinator(store, new VirtualClock(M), config);
  try {
    coordinator.enqueueSource('connected', M);
    coordinator.enqueueTrade(trade('1', 1_000, '100'), M + 1_100);
    coordinator.enqueueTrade(trade('2', 2_000, '90'), M + 2_100); // write fails
    coordinator.enqueueTrade(trade('3', 3_000, '110'), M + 3_100); // queued behind the failure
    await coordinator.drain();
    await coordinator.drain(); // main.ts shutdown drains again; baseline committed trade 3 here
    assert.deepEqual(coordinator.decisions.map(x => x.kind), ['source', 'accepted']);
    assert.equal(coordinator.queueDepth, 1, 'the undelivered trade stays visible as queue depth');
    const bar = store.current('BTCUSDT').bars[0]!;
    assert.deepEqual([bar.tradeCount, bar.low, bar.high], [1, '100', '100']);
    assert.equal(bar.quality.completeness, 'known_incomplete');
    assert.ok(bar.quality.reasons.includes('writer_fault'));
    assert.equal(store.current('BTCUSDT').sourceState, 'faulted');
    const fault = store.coverage('ETHUSDT', M, M + 60_000, 100).events.find(x => x.reason === 'writer_fault')!;
    assert.deepEqual([fault.startMs, fault.endMs, fault.knownIncomplete], [M + 2_100, null, true]);
  } finally { store.close(); }
});

test('F2 a real SQLite FULL error keeps its cause, latches durably and marks the bar', async () => {
  const temp = tempDb(); const config = { ...DEFAULT_CONFIG, dbPath: temp.path };
  try {
    // max_page_count makes SQLite itself raise SQLITE_FULL; it is not an OS ENOSPC test.
    const limitPages = (db: DatabaseSync) => {
      const { page_count: pages } = db.prepare('PRAGMA page_count').get() as { page_count: number };
      db.exec(`PRAGMA max_page_count=${pages + 1}`);
    };
    const store = temp.track(new SqliteStore(config, { afterOpen: limitPages }));
    const coordinator = new Coordinator(store, new VirtualClock(M), config);
    coordinator.enqueueSource('connected', M); await coordinator.drain();
    for (let i = 1; i <= 2_000 && coordinator.enqueueTrade(trade(String(i), 1_000 + i, '100'), M + 1_100 + i); i++)
      await coordinator.drain();
    const accepted = coordinator.decisions.filter(x => x.kind === 'accepted').length;
    assert.ok(accepted > 0 && accepted < 2_000, `page limit should be reached (accepted=${accepted})`);
    assert.match(coordinator.writerFault ?? '', /full/i, 'baseline reported "cannot rollback - no transaction is active"');
    const bar = store.current('BTCUSDT').bars[0]!;
    assert.equal(bar.tradeCount, accepted);
    assert.equal(bar.quality.completeness, 'known_incomplete');
    assert.ok(bar.quality.reasons.includes('writer_fault'));
    store.close();
    const reopened = temp.track(new SqliteStore(config));
    const resumed = new Coordinator(reopened, new VirtualClock(M + 10_000), config);
    assert.match(reopened.meta().writerFault ?? '', /full/i);
    assert.equal(reopened.meta().sourceState, 'faulted', 'baseline reported stopped after reopening a faulted file');
    assert.equal(reopened.current('BTCUSDT').bars[0]?.tradeCount, accepted);
    assert.equal(resumed.enqueueTrade(trade('9999', 9_000), M + 10_100), false);
    reopened.close();
  } finally { temp.cleanup(); }
});

test('F8 coverage of a barless minute includes a gap that touched only its grace period', async () => {
  const h = harness({}, M - 10_000);
  try {
    h.coordinator.enqueueSource('connected', M - 10_000);
    h.coordinator.enqueueSource('disconnected', M + 60_500); // minute M has no trade, but one could still arrive
    h.coordinator.enqueueSource('connected', M + 61_500);
    await h.coordinator.drain();
    const events = h.store.coverage('BTCUSDT', M, M + 60_000, 100).events;
    assert.deepEqual(events.map(x => [x.reason, x.startMs - M, x.endMs! - M]), [['source_gap', 60_500, 61_500]],
      'baseline filtered by minute bounds and returned nothing, while a bar in M would have carried source_gap');
  } finally { h.close(); }
});

test('F7 a corrupt database file is refused without leaking the file handle', () => {
  const temp = tempDb();
  try {
    writeFileSync(temp.path, Buffer.alloc(8_192, 0x5a)); // not an SQLite header
    assert.throws(() => new SqliteStore({ ...DEFAULT_CONFIG, dbPath: temp.path }), /not a database/);
    rmSync(temp.path); // baseline kept the handle open: EBUSY on Windows
    assert.equal(existsSync(temp.path), false);
  } finally { temp.cleanup(); }
});

test('F3 a fresh start flags every minute whose receive window straddles the start, including the previous one', async () => {
  const h = harness();
  try {
    h.coordinator.enqueueSource('connected', M);
    h.coordinator.enqueueTrade(trade('1', -1, '100'), M + 50); // previous minute, inside its grace period
    await h.coordinator.drain();
    assert.equal(h.coordinator.decisions.at(-1)?.kind, 'accepted');
    const bar = h.store.bars('BTCUSDT', M - 60_000, M, 10).bars[0]!;
    assert.deepEqual(bar.quality.reasons, ['startup_partial'], 'baseline reported no reason for a bar observed for 50 ms');
  } finally { h.close(); }
  const later = harness({}, M - 10_000); // window of M starts at M-5s, after this start
  try {
    later.coordinator.enqueueSource('connected', M - 10_000);
    later.coordinator.enqueueTrade(trade('1', 1_000), M + 1_100);
    await later.coordinator.drain();
    assert.deepEqual(later.store.current('BTCUSDT').bars[0]!.quality.reasons, []);
  } finally { later.close(); }
});

test('F4 a store accepts only its configured venue, so paging cannot skip a duplicate minute key', async () => {
  const h = harness();
  try {
    h.coordinator.enqueueSource('connected', M);
    h.coordinator.enqueueTrade(trade('1', 1_000, '100'), M + 1_100);
    h.coordinator.enqueueTrade({ ...trade('1', 1_000, '200'), venue: 'binance' }, M + 1_200);
    h.coordinator.enqueueTrade(trade('2', 61_000, '101'), M + 61_100);
    await h.coordinator.drain();
    assert.deepEqual(h.coordinator.decisions.map(x => x.kind), ['source', 'accepted', 'invalid', 'accepted']);
    const first = h.store.bars('BTCUSDT', M, M + 120_000, 1);
    const second = h.store.bars('BTCUSDT', first.nextFrom!, M + 120_000, 1);
    assert.deepEqual([...first.bars, ...second.bars].map(x => [x.venue, x.openTimeMs - M]), [['mock', 0], ['mock', 60_000]]);
  } finally { h.close(); }
});

test('F5 a clean restart measures downtime from the latest stop, not one before a reconnect', async () => {
  const temp = tempDb(); const config = { ...DEFAULT_CONFIG, dbPath: temp.path };
  try {
    const first = temp.track(new SqliteStore(config)); const one = new Coordinator(first, new VirtualClock(M), config);
    one.enqueueSource('connected', M);
    one.enqueueSource('stopped', M + 1_000);
    one.enqueueSource('connected', M + 2_000);
    one.enqueueTrade(trade('1', 130_000), M + 130_100);
    one.enqueueTick(M + 190_000); // after the bar's receive window [M+115s, M+182s)
    await one.drain();
    first.close(); // closed while connected
    const second = temp.track(new SqliteStore(config)); new Coordinator(second, new VirtualClock(M + 400_000), config);
    const open = second.coverage('BTCUSDT', M, M + 500_000, 100).events.filter(x => x.endMs === null);
    assert.deepEqual(open.map(x => [x.reason, x.startMs - M]), [['source_gap', 190_000]], 'baseline started the gap at +1000');
    assert.deepEqual(second.bars('BTCUSDT', M + 120_000, M + 180_000, 10).bars[0]!.quality.reasons, []);
    second.close();
  } finally { temp.cleanup(); }
});

test('F6 clock and capacity faults attach to every bar that could still receive trades', async () => {
  const config = { ...DEFAULT_CONFIG, clockMode: 'real' as const };
  let at = M; let drift = 0;
  const clock = { mode: 'real' as const, now: () => at, driftMs: () => drift };
  const store = new SqliteStore(config); const coordinator = new Coordinator(store, clock, config);
  try {
    coordinator.enqueueSource('connected');
    at = M + 1_100; coordinator.enqueueTrade(trade('1', 1_000));
    at = M + 30_000; drift = 2_000;
    assert.equal(coordinator.enqueueTrade(trade('2', 29_900)), false);
    await coordinator.drain();
    const bar = store.current('BTCUSDT').bars[0]!;
    assert.equal(bar.state, 'open');
    assert.ok(bar.quality.reasons.includes('clock_untrusted'), 'baseline scoped the clock fault to no bar');
    assert.equal(bar.quality.completeness, 'known_incomplete', 'the refused trade is a known miss');
  } finally { store.close(); }

  const h = harness({ maxTrades: 1 });
  try {
    h.coordinator.enqueueSource('connected', M);
    h.coordinator.enqueueTrade(trade('1', 1_000, '100', '1', 'ETHUSDT'), M + 1_100);
    h.coordinator.enqueueTrade(trade('1', 2_000), M + 2_100);
    await h.coordinator.drain();
    assert.deepEqual(h.coordinator.decisions.map(x => x.kind), ['source', 'accepted', 'resource_limit']);
    const eth = h.store.current('ETHUSDT').bars[0]!;
    assert.equal(eth.quality.completeness, 'known_incomplete', 'intake stopped for ETH too');
    assert.ok(eth.quality.reasons.includes('resource_limit'));
  } finally { h.close(); }
});
