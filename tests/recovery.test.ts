import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { VirtualClock } from '../src/clock.js';
import { Coordinator } from '../src/coordinator.js';
import { DEFAULT_CONFIG } from '../src/contracts.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { M, trade } from './support.js';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'trade-kline-recovery-'));
  const cleanup = () => {
    const target = resolve(dir), root = resolve(tmpdir()) + sep;
    if (!target.startsWith(root) || !target.includes('trade-kline-recovery-')) throw new Error('unsafe cleanup path');
    rmSync(target, { recursive: true, force: true });
  };
  return { path: join(dir, 'service.db'), cleanup };
}

test('file mode rejects simultaneous writer, semantic config mismatch, and clock rollback', async () => {
  const temp = tempDb();
  const config = { ...DEFAULT_CONFIG, dbPath: temp.path };
  try {
    const first = new SqliteStore(config);
    const a = new Coordinator(first, new VirtualClock(M), config);
    assert.throws(() => new SqliteStore(config), /another writer process is alive/);
    a.enqueueTrade(trade('1', 1_000), M + 1_100); await a.drain();
    first.close();
    assert.throws(() => new SqliteStore({ ...config, futureToleranceMs: 4_999 }), /semantic config mismatch/);
    assert.throws(() => new SqliteStore({ ...config, maxQueue: 4_095 }), /semantic config mismatch/);
    assert.throws(() => new SqliteStore({ ...config, scenarioId: 'different-fixture' }), /semantic config mismatch/);
    const reopened = new SqliteStore(config);
    assert.throws(() => new Coordinator(reopened, new VirtualClock(M), config), /restart clock before persisted frontier/);
    reopened.close();
  } finally { temp.cleanup(); }
});

test('clean file restart restores bar, closes due window, and exposes downtime gap', async () => {
  const temp = tempDb(); const config = { ...DEFAULT_CONFIG, dbPath: temp.path };
  try {
    const first = new SqliteStore(config); const one = new Coordinator(first, new VirtualClock(M), config);
    one.enqueueSource('connected', M);
    one.enqueueTrade(trade('1', 1_000, '100', '2'), M + 1_100); await one.drain();
    first.close();
    const second = new SqliteStore(config); const two = new Coordinator(second, new VirtualClock(M + 63_000), config);
    assert.equal(second.bars('BTCUSDT', M, M + 60_000, 100).bars[0]?.state, 'closed');
    assert.equal(second.coverage('ETHUSDT', M, M + 120_000, 100).events.some(x => x.reason === 'source_gap' && x.endMs === null), true);
    two.enqueueSource('connected', M + 63_001); await two.drain();
    assert.equal(second.coverage('ETHUSDT', M, M + 120_000, 100).events.some(x => x.reason === 'source_gap' && x.endMs === M + 63_001), true);
    second.close();
  } finally { temp.cleanup(); }
});

for (const phase of ['before', 'after'] as const) {
  test(`real child kill ${phase} COMMIT has atomic recovery behavior`, async () => {
    const temp = tempDb(); const config = { ...DEFAULT_CONFIG, dbPath: temp.path };
    try {
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/child-runner.ts', temp.path, phase],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
      assert.match(child.stdout, /armed/);
      assert.match(child.stdout, new RegExp(`hook:${phase}`));
      assert.doesNotMatch(child.stdout, /unexpected_return/);
      assert.notEqual(child.status, 0);
      const store = new SqliteStore(config);
      const coordinator = new Coordinator(store, new VirtualClock(M + 2_000), config);
      const initial = store.bars('BTCUSDT', M, M + 60_000, 100).bars;
      assert.equal(initial.length, phase === 'before' ? 0 : 1);
      assert.equal(store.coverage('ETHUSDT', M, M + 60_000, 100).events.some(x => x.reason === 'recovery_gap'), true);
      coordinator.enqueueTrade(trade('1', 1_000, '100', '2'), M + 2_100); await coordinator.drain();
      assert.equal(coordinator.decisions.at(-1)?.kind, phase === 'before' ? 'accepted' : 'duplicate');
      assert.equal(store.bars('BTCUSDT', M, M + 60_000, 100).bars[0]?.volume, '2');
      coordinator.enqueueSource('connected', M + 2_200); await coordinator.drain();
      assert.equal(store.coverage('ETHUSDT', M, M + 60_000, 100).events.some(x => x.reason === 'recovery_gap' && x.endMs === M + 2_200), true);
      store.close();
    } finally { temp.cleanup(); }
  });
}

test('uncommitted crash trade replayed after deadline is late and leaves recovery gap', async () => {
  const temp = tempDb(); const config = { ...DEFAULT_CONFIG, dbPath: temp.path };
  try {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/child-runner.ts', temp.path, 'before'],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
    assert.match(child.stdout, /hook:before/);
    const store = new SqliteStore(config);
    const coordinator = new Coordinator(store, new VirtualClock(M + 63_000), config);
    coordinator.enqueueTrade(trade('1', 1_000, '100', '2'), M + 63_001); await coordinator.drain();
    assert.equal(coordinator.decisions.at(-1)?.kind, 'late');
    assert.equal(store.bars('BTCUSDT', M, M + 60_000, 100).bars.length, 0);
    const reasons = store.coverage('BTCUSDT', M, M + 60_000, 100).events.map(x => x.reason);
    assert.ok(reasons.includes('recovery_gap') && reasons.includes('late_rejected'));
    store.close();
  } finally { temp.cleanup(); }
});

test('file transaction failure preserves committed bar across clean reopen', async () => {
  const temp = tempDb(); const config = { ...DEFAULT_CONFIG, dbPath: temp.path };
  try {
    let calls = 0;
    const store = new SqliteStore(config, { beforeCommit: () => { if (++calls === 3) throw new Error('simulated file write failure'); } });
    const coordinator = new Coordinator(store, new VirtualClock(M), config);
    coordinator.enqueueSource('connected', M);
    coordinator.enqueueTrade(trade('1', 1_000, '100', '2'), M + 1_100);
    coordinator.enqueueTrade(trade('2', 2_000, '200', '3'), M + 2_100);
    await coordinator.drain();
    assert.match(coordinator.writerFault ?? '', /simulated file write failure/);
    store.close();
    const reopened = new SqliteStore(config);
    const resumed = new Coordinator(reopened, new VirtualClock(M + 3_000), config);
    const bar = reopened.bars('BTCUSDT', M, M + 60_000, 100).bars[0]!;
    assert.deepEqual([bar.high, bar.volume, bar.tradeCount], ['100', '2', 1]);
    assert.match(reopened.meta().writerFault ?? '', /simulated file write failure/);
    assert.equal(resumed.enqueueTrade(trade('3', 3_000), M + 3_100), false);
    reopened.close();
  } finally { temp.cleanup(); }
});
