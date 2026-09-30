import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { VirtualClock } from '../src/clock.js';
import { Coordinator } from '../src/coordinator.js';
import { DEFAULT_CONFIG } from '../src/contracts.js';
import { createHttpApi } from '../src/http.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { M, harness, trade } from './support.js';

const retention = { identityRetentionMs: 70_000, historyRetentionMs: 120_000 };

test('rolling history outlives the quality cap while preserving retained bars and increasing event IDs', async () => {
  const h = harness({ ...retention, maxQualityEvents: 6 }, M - 10_000);
  try {
    h.coordinator.enqueueSource('connected', M - 10_000);
    for (let minute = 0; minute < 20; minute++) {
      const offset = minute * 60_000;
      h.coordinator.enqueueTrade(trade(String(minute + 1), offset + 1_000), M + offset + 3_100);
      h.coordinator.enqueueReconcile('BTCUSDT', M + offset, [{ firstTradeId: String(minute + 1), lastTradeId: String(minute + 1),
        eventTimeMs: M + offset + 1_000, price: '100', quantity: '1' }], 'retention-test', M + offset + 62_000);
      await h.coordinator.drain();
      assert.equal(h.coordinator.writerFault, null, `minute ${minute}: a lifetime cap must not halt a rolling store`);
    }
    const floor = M + 18 * 60_000;
    assert.equal(h.store.meta().historyFloorMs, floor);
    const bars = h.store.bars('BTCUSDT', floor, M + 21 * 60_000, 100);
    assert.deepEqual(bars.bars.map(b => [b.openTimeMs, b.quality.completeness]),
      [[floor, 'reconciled'], [floor + 60_000, 'reconciled']]);
    assert.equal(bars.historyFloorMs, floor);
    const events = h.store.coverage('BTCUSDT', floor, M + 21 * 60_000, 100).events;
    assert.equal(events.length, 2);
    assert.ok(events[0]!.id > 6 && events[1]!.id > events[0]!.id, 'IDs are never recycled after pruning');
  } finally { h.close(); }
});

test('a real retained-window quality overflow still latches a durable writer fault', async () => {
  const h = harness({ ...retention, maxQualityEvents: 3 }, M - 10_000);
  try {
    h.coordinator.enqueueSource('connected', M - 10_000);
    h.coordinator.enqueueTrade({ ...trade('1', 1_000), price: 'bad' }, M + 1_100);
    h.coordinator.enqueueTrade({ ...trade('2', 2_000, '100', '1', 'ETHUSDT'), price: 'bad' }, M + 2_100);
    await h.coordinator.drain();
    assert.match(h.coordinator.writerFault ?? '', /quality event capacity reached/);
    assert.ok(h.store.coverage('BTCUSDT', M, M + 60_000, 100).events.some(e => e.reason === 'writer_fault'));
  } finally { h.close(); }
});

test('pruning retains future-tolerance boundary gaps and retracted-gap quality revisions', async () => {
  const h = harness(retention, M - 60_000);
  try {
    h.coordinator.enqueueSource('connected', M - 60_000);
    h.coordinator.enqueueSource('disconnected', M - 6_000);
    h.coordinator.enqueueSource('connected', M - 5_000);
    h.coordinator.enqueueSource('disconnected', M - 5_000);
    h.coordinator.enqueueSource('connected', M - 5_000); // empty gap exactly at this minute's receive-window start
    h.coordinator.enqueueTrade(trade('1', 1_000), M + 1_100);
    await h.coordinator.drain();
    const before = h.store.current('BTCUSDT').bars[0]!.quality;
    assert.deepEqual(before.reasons, []);
    assert.ok(before.qualityRevision > 0);
    h.coordinator.enqueueTick(M + 120_000); await h.coordinator.drain();
    assert.equal(h.store.meta().historyFloorMs, M);
    assert.deepEqual(h.store.bars('BTCUSDT', M, M + 60_000, 10).bars[0]!.quality, before);
  } finally { h.close(); }
});

test('an old open gap continues to describe retained barless minutes after pruning', async () => {
  const h = harness(retention, M - 10_000);
  try {
    h.coordinator.enqueueSource('connected', M - 10_000);
    h.coordinator.enqueueSource('disconnected', M + 1_000);
    h.coordinator.enqueueTick(M + 300_000); await h.coordinator.drain();
    const coverage = h.store.coverage('BTCUSDT', M + 180_000, M + 240_000, 10);
    assert.equal(coverage.historyFloorMs, M + 180_000);
    assert.deepEqual(coverage.events.map(e => [e.reason, e.startMs, e.endMs]), [['source_gap', M + 1_000, null]]);
    h.coordinator.enqueueSource('connected', M + 300_001); await h.coordinator.drain();
    assert.equal(h.store.coverage('BTCUSDT', M + 180_000, M + 240_000, 10).events[0]!.endMs, M + 300_001);
  } finally { h.close(); }
});

test('old trade, invalid trade and history cannot resurrect pruned minute records', async () => {
  const config = { ...DEFAULT_CONFIG, ...retention };
  let db!: DatabaseSync;
  const store = new SqliteStore(config, { afterOpen: handle => { db = handle; } });
  const coordinator = new Coordinator(store, new VirtualClock(M - 10_000), config);
  try {
    coordinator.enqueueSource('connected', M - 10_000);
    coordinator.enqueueTrade(trade('1', 1_000), M + 1_100);
    coordinator.enqueueTick(M + 300_000); await coordinator.drain();
    coordinator.enqueueTrade(trade('1', 1_000), M + 300_001);
    coordinator.enqueueTrade({ ...trade('2', 2_000), price: 'bad' }, M + 300_002);
    coordinator.enqueueReconcile('BTCUSDT', M, [{ firstTradeId: '1', lastTradeId: '1', eventTimeMs: M + 1_000,
      price: '100', quantity: '1' }], 'expired-history', M + 300_003);
    await coordinator.drain();
    assert.deepEqual(coordinator.decisions.slice(-3).map(d => d.kind), ['stale', 'invalid', 'invalid']);
    for (const table of ['bars', 'trades'])
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM quality_events WHERE scope IN ('minute','source') AND startMs<?")
      .get(M + 180_000) as { n: number }).n, 0);
    const events = store.coverage('BTCUSDT', M + 300_000, M + 360_000, 100).events;
    assert.ok(events.some(e => e.reason === 'stale_delivery'));
    assert.ok(events.some(e => e.reason === 'invalid_input'));
    assert.ok(store.reconcileCandidates('all', M + 300_003, 0, 3_600_000, 100).every(c => c.openTimeMs >= M + 180_000));
  } finally { store.close(); }
});

test('HTTP refuses expired history instead of presenting a clean empty interval', async () => {
  const h = harness(retention, M - 10_000);
  const server = createHttpApi(h.coordinator); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    h.coordinator.enqueueTick(M + 300_000); await h.coordinator.drain();
    for (const endpoint of ['klines', 'coverage']) {
      const old = await fetch(`${base}/v1/${endpoint}?symbol=BTCUSDT&from=${M}&to=${M + 240_000}`);
      assert.equal(old.status, 410);
      assert.deepEqual(await old.json(), { error: 'history_expired', historyFloorMs: M + 180_000 });
      const retained = await fetch(`${base}/v1/${endpoint}?symbol=BTCUSDT&from=${M + 180_000}&to=${M + 240_000}`);
      assert.equal(retained.status, 200);
      assert.equal((await retained.json()).historyFloorMs, M + 180_000);
    }
    assert.equal((await (await fetch(`${base}/v1/klines/current?symbol=BTCUSDT`)).json()).historyFloorMs, M + 180_000);
  } finally { server.close(); h.close(); }
});

test('restart prunes before allocating recovery quality and persists the history floor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trade-kline-retention-'));
  const config = { ...DEFAULT_CONFIG, ...retention, maxQualityEvents: 3, dbPath: join(dir, 'service.db') };
  const stores: SqliteStore[] = [];
  try {
    const first = new SqliteStore(config); stores.push(first);
    const one = new Coordinator(first, new VirtualClock(M - 10_000), config);
    one.enqueueSource('connected', M - 10_000);
    one.enqueueTrade({ ...trade('1', 1_000), price: 'bad' }, M + 1_100); await one.drain();
    first.close();
    const second = new SqliteStore(config); stores.push(second);
    new Coordinator(second, new VirtualClock(M + 300_000), config);
    assert.equal(second.meta().historyFloorMs, M + 180_000);
    assert.equal(second.meta().writerFault, null);
    const gap = second.coverage('BTCUSDT', M + 180_000, M + 240_000, 100).events;
    assert.ok(gap.some(e => e.reason === 'source_gap' && e.id > 3));
    second.close();
    const third = new SqliteStore(config); stores.push(third);
    assert.equal(third.meta().historyFloorMs, M + 180_000, 'available before a new coordinator resumes');
  } finally {
    for (const store of stores) store.close();
    const target = resolve(dir), root = resolve(tmpdir()) + sep;
    if (!target.startsWith(root) || !target.includes('trade-kline-retention-')) throw new Error('unsafe cleanup path');
    rmSync(target, { recursive: true, force: true });
  }
});

test('clock-untrusted fault cannot expire history using its untrusted future timestamp', async () => {
  const h = harness(retention, M - 10_000);
  try {
    h.coordinator.enqueueSource('connected', M - 10_000);
    h.coordinator.enqueueTrade(trade('1', 1_000), M + 1_100); await h.coordinator.drain();
    const floor = h.store.meta().historyFloorMs;
    h.store.process({ kind: 'fault', code: 'clock_untrusted', knownIncomplete: true,
      envelope: { runId: 'clock-fault', seq: 99, receivedAtMs: M + 86_400_000 } });
    assert.equal(h.store.meta().historyFloorMs, floor);
    assert.equal(h.store.bars('BTCUSDT', M, M + 60_000, 10).bars.length, 1);
  } finally { h.close(); }
});

test('a capacity-faulted file can reopen for reads without allocating another normal quality row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trade-kline-retention-fault-'));
  const config = { ...DEFAULT_CONFIG, ...retention, maxQualityEvents: 3, dbPath: join(dir, 'service.db') };
  const stores: SqliteStore[] = [];
  try {
    const first = new SqliteStore(config); stores.push(first);
    const one = new Coordinator(first, new VirtualClock(M - 10_000), config);
    one.enqueueSource('connected', M - 10_000);
    for (const symbol of config.symbols)
      one.enqueueTrade({ ...trade('1', 1_000, '100', '1', symbol), price: 'bad' }, M + 1_100);
    await one.drain();
    assert.match(one.writerFault ?? '', /quality event capacity reached/);
    const floor = first.meta().historyFloorMs;
    first.close();
    const second = new SqliteStore(config); stores.push(second);
    const two = new Coordinator(second, new VirtualClock(M + 300_000), config);
    assert.match(two.writerFault ?? '', /quality event capacity reached/);
    assert.equal(second.meta().historyFloorMs, floor, 'fault recovery does not erase retained evidence');
    assert.ok(second.coverage('BTCUSDT', M, M + 60_000, 100).events.some(e => e.reason === 'writer_fault'));
    assert.equal(two.enqueueTrade(trade('2', 301_000), M + 301_100), false);
  } finally {
    for (const store of stores) store.close();
    const target = resolve(dir), root = resolve(tmpdir()) + sep;
    if (!target.startsWith(root) || !target.includes('trade-kline-retention-fault-')) throw new Error('unsafe cleanup path');
    rmSync(target, { recursive: true, force: true });
  }
});

test('history retention cannot undercut identity retention or exceed the supported bound', () => {
  assert.throws(() => new SqliteStore({ ...DEFAULT_CONFIG, ...retention, historyRetentionMs: 69_999 }), /historyRetentionMs/);
  assert.throws(() => new SqliteStore({ ...DEFAULT_CONFIG, historyRetentionMs: 366 * 86_400_000 }), /historyRetentionMs/);
});
