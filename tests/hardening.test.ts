// Round 3: tests for the remaining risks listed after the independent review (results/review.md L1-L3).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { VirtualClock } from '../src/clock.js';
import { Coordinator } from '../src/coordinator.js';
import { DEFAULT_CONFIG } from '../src/contracts.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { M, harness, trade } from './support.js';

test('L1 a same-millisecond disconnect/reconnect never lowers qualityRevision', async () => {
  const h = harness({}, M - 10_000);
  try {
    h.coordinator.enqueueSource('connected', M - 10_000);
    h.coordinator.enqueueTrade(trade('1', 1_000), M + 1_100); await h.coordinator.drain();
    const r0 = h.store.current('BTCUSDT').bars[0]!.quality;
    h.coordinator.enqueueSource('disconnected', M + 5_000); await h.coordinator.drain();
    const r1 = h.store.current('BTCUSDT').bars[0]!.quality;
    h.coordinator.enqueueSource('connected', M + 5_000); await h.coordinator.drain();
    const r2 = h.store.current('BTCUSDT').bars[0]!.quality;
    assert.deepEqual([r0.reasons, r1.reasons, r2.reasons], [[], ['source_gap'], []]);
    assert.ok(r1.qualityRevision > r0.qualityRevision && r2.qualityRevision > r1.qualityRevision,
      `revisions ${r0.qualityRevision} -> ${r1.qualityRevision} -> ${r2.qualityRevision} (round 2 fell back to 0)`);
    assert.equal(h.store.coverage('BTCUSDT', M, M + 60_000, 100).events.length, 0, 'a retracted gap is not an event');
  } finally { h.close(); }
});

test('L2 a burst of late trades costs one quality row per minute, with an occurrence count', async () => {
  const h = harness({ maxQualityEvents: 4 }, M - 10_000);
  try {
    h.coordinator.enqueueSource('connected', M - 10_000);
    for (let i = 0; i < 300; i++) h.coordinator.enqueueTrade(trade(String(i + 1), 1_000 + i), M + 62_000 + i);
    await h.coordinator.drain();
    assert.equal(h.coordinator.writerFault, null, 'round 2 wrote one row per late trade and hit the cap');
    assert.deepEqual(h.coordinator.decisions.filter(x => x.kind === 'late').length, 300);
    const late = h.store.coverage('BTCUSDT', M, M + 60_000, 100).events.filter(x => x.reason === 'late_rejected');
    assert.deepEqual(late.map(x => [x.occurrences, x.knownIncomplete]), [[300, true]]);
  } finally { h.close(); }
});

test('L2 identities older than the retention horizon are pruned; later deliveries there are stale, not late', async () => {
  const h = harness({ maxTrades: 3, identityRetentionMs: 70_000 }, M - 10_000);
  try {
    h.coordinator.enqueueSource('connected', M - 10_000);
    for (let k = 0; k < 8; k++) {
      h.coordinator.enqueueTrade(trade(String(k + 1), k * 60_000 + 1_000), M + k * 60_000 + 1_100);
      h.coordinator.enqueueTick(M + k * 60_000 + 30_000);
      await h.coordinator.drain();
    }
    assert.equal(h.coordinator.writerFault, null, 'round 2 counted lifetime trades and stopped at the 4th');
    assert.equal(h.coordinator.decisions.filter(x => x.kind === 'accepted').length, 8);
    assert.ok(h.store.meta().tradeCount <= 3);
    h.coordinator.enqueueTrade(trade('7', 6 * 60_000 + 1_000), M + 7 * 60_000 + 40_000); // retained: still a duplicate
    h.coordinator.enqueueTrade(trade('1', 1_000), M + 7 * 60_000 + 40_001); // pruned: indistinguishable
    await h.coordinator.drain();
    assert.deepEqual(h.coordinator.decisions.slice(-2).map(x => x.kind), ['duplicate', 'stale']);
    const first = h.store.bars('BTCUSDT', M, M + 60_000, 10).bars[0]!;
    assert.ok(first.quality.reasons.includes('stale_delivery'));
    assert.equal(first.quality.completeness, 'unverified', 'a possible duplicate is not a known loss');
  } finally { h.close(); }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'trade-kline-hardening-'));
  const opened: SqliteStore[] = [];
  return {
    path: join(dir, 'service.db'),
    track: (store: SqliteStore) => { opened.push(store); return store; },
    cleanup: () => {
      for (const store of opened) try { store.close(); } catch { /* already reported */ }
      const target = resolve(dir), root = resolve(tmpdir()) + sep;
      if (!target.startsWith(root) || !target.includes('trade-kline-hardening-')) throw new Error('unsafe cleanup path');
      rmSync(target, { recursive: true, force: true });
    },
  };
}

test('L2 the retention horizon survives a restart', async () => {
  const temp = tempDb(); const config = { ...DEFAULT_CONFIG, dbPath: temp.path, identityRetentionMs: 70_000 };
  try {
    const first = temp.track(new SqliteStore(config)); const one = new Coordinator(first, new VirtualClock(M - 10_000), config);
    one.enqueueSource('connected', M - 10_000);
    one.enqueueTrade(trade('1', 1_000), M + 1_100); await one.drain();
    first.close();
    const second = temp.track(new SqliteStore(config)); const two = new Coordinator(second, new VirtualClock(M + 600_000), config);
    assert.equal(second.meta().tradeCount, 0, 'resume pruned the old identity');
    assert.ok(second.meta().identityHorizonMs > M);
    two.enqueueTrade(trade('1', 1_000), M + 600_100); await two.drain();
    assert.equal(two.decisions.at(-1)?.kind, 'stale');
  } finally { temp.cleanup(); }
});
