// Round 3: reconciliation of closed minutes against a trusted trade history (results/review.md L3).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { BinanceAggTradeHistory, Reconciler, TruthHistory, parseAggTrades } from '../src/reconciler.js';
import { M, harness, trade } from './support.js';

const golden = [trade('1', 3_000, '100', '2'), trade('2', 22_000, '99', '3'), trade('3', 48_000, '103', '1')];

test('L3 a minute with a late trade is repaired from history with an explicit value revision', async () => {
  const h = harness({}, M - 10_000);
  try {
    h.coordinator.enqueueSource('connected', M - 10_000);
    h.coordinator.enqueueTrade(golden[0]!, M + 3_100);
    h.coordinator.enqueueTrade(golden[2]!, M + 48_100);
    h.coordinator.enqueueTrade(golden[1]!, M + 63_000); // after the deadline: late
    h.coordinator.enqueueTick(M + 70_000);
    await h.coordinator.drain();
    const before = h.store.bars('BTCUSDT', M, M + 60_000, 10).bars[0]!;
    assert.deepEqual([before.low, before.volume, before.tradeCount, before.quality.completeness], ['100', '3', 2, 'known_incomplete']);
    const reconciler = new Reconciler(h.coordinator, new TruthHistory(golden), { policy: 'flagged' });
    // Flagged: M-1m for both symbols (startup_partial straddles the start; no trades in history) and BTCUSDT M.
    assert.equal(await reconciler.runOnce(), 3);
    const after = h.store.bars('BTCUSDT', M, M + 60_000, 10).bars[0]!;
    assert.deepEqual([after.open, after.high, after.low, after.close, after.volume, after.quoteVolume, after.tradeCount],
      ['100', '103', '99', '103', '6', '600', 3], 'the hand-calculated golden bar');
    assert.ok(after.valueRevision > before.valueRevision);
    assert.equal(after.quality.completeness, 'reconciled');
    assert.deepEqual(after.quality.reasons, ['late_rejected', 'repaired']);
    h.coordinator.enqueueTrade(golden[1]!, M + 71_000); await h.coordinator.drain(); // redelivered again
    assert.equal(h.coordinator.decisions.at(-1)?.kind, 'duplicate', 'covered by the reconciled ID range');
    assert.equal(await reconciler.runOnce(), 0, 'nothing left to reconcile');
  } finally { h.close(); }
});

test('L3 policy all confirms intact minutes and backfills a minute lost to a disconnect', async () => {
  const h = harness({}, M - 10_000);
  const truth = [...golden, trade('4', 70_000, '104', '1'), trade('5', 80_000, '98', '2')];
  try {
    h.coordinator.enqueueSource('connected', M - 10_000);
    for (const t of golden) h.coordinator.enqueueTrade(t, t.eventTimeMs + 100);
    h.coordinator.enqueueSource('disconnected', M + 65_000);
    h.coordinator.enqueueSource('connected', M + 125_000); // minute M+60s never observed
    h.coordinator.enqueueTick(M + 200_000);
    await h.coordinator.drain();
    const reconciler = new Reconciler(h.coordinator, new TruthHistory(truth), { policy: 'all' });
    while (await reconciler.runOnce() > 0) { /* drain all candidates */ }
    const [m0, m1, m2] = [0, 60_000, 120_000].map(offset => h.store.bars('BTCUSDT', M + offset, M + offset + 60_000, 10).bars[0]);
    assert.deepEqual([m0!.tradeCount, m0!.valueRevision < m1!.valueRevision, m0!.quality.completeness], [3, true, 'reconciled']);
    assert.ok(m0!.quality.reasons.includes('reconciled') && !m0!.quality.reasons.includes('repaired'), 'confirmed, not rewritten');
    assert.deepEqual([m1!.open, m1!.close, m1!.volume, m1!.tradeCount, m1!.quality.completeness], ['104', '98', '3', 2, 'reconciled']);
    assert.ok(m1!.quality.reasons.includes('source_gap') && m1!.quality.reasons.includes('repaired'));
    assert.equal(m2, undefined, 'an empty minute stays barless');
    assert.ok(h.store.coverage('BTCUSDT', M + 120_000, M + 180_000, 10).events.some(x => x.reason === 'reconciled'),
      'coverage shows the empty minute was confirmed by history');
  } finally { h.close(); }
});

test('L3 incomplete or premature history is refused and changes nothing', async () => {
  const h = harness({}, M - 10_000);
  try {
    h.coordinator.enqueueSource('connected', M - 10_000);
    h.coordinator.enqueueTrade(golden[0]!, M + 3_100); await h.coordinator.drain();
    const hole = [golden[0]!, golden[2]!].map(t => ({ firstTradeId: t.tradeId, lastTradeId: t.tradeId, eventTimeMs: t.eventTimeMs, price: t.price, quantity: t.quantity }));
    h.coordinator.enqueueReconcile('BTCUSDT', M, hole, 'test', M + 40_000); // before the deadline
    h.coordinator.enqueueReconcile('BTCUSDT', M, hole, 'test', M + 70_000); // IDs 1 and 3: a hole
    await h.coordinator.drain();
    assert.deepEqual(h.coordinator.decisions.slice(-2).map(x => [x.kind, x.detail]),
      [['invalid', 'minute still open to live trades'], ['invalid', 'history: trade IDs are not contiguous']]);
    const bar = h.store.bars('BTCUSDT', M, M + 60_000, 10).bars[0]!;
    assert.deepEqual([bar.tradeCount, bar.quality.completeness], [1, 'unverified']);
  } finally { h.close(); }
});

test('L3 Binance aggTrades history pages by fromId, keeps exact IDs and refuses truncation', async () => {
  const urls: string[] = [];
  const row = (a: bigint, f: bigint, T: number) => `{"a":${a},"p":"100.00000000","q":"0.50000000","f":${f},"l":${f + 1n},"T":${T},"m":true,"M":true}`;
  const base = 9_007_199_254_740_993n; // above 2^53
  const page1 = `[${Array.from({ length: 1_000 }, (_, i) => row(base + BigInt(i), base * 2n + BigInt(i) * 2n, M + i)).join(',')}]`;
  const page2 = `[${row(base + 1_000n, base * 2n + 2_000n, M + 59_999)},${row(base + 1_001n, base * 2n + 2_002n, M + 60_000)}]`;
  const fetchFake = (async (url: string) => { urls.push(url); return new Response(urls.length === 1 ? page1 : page2); }) as unknown as typeof fetch;
  const aggregates = await new BinanceAggTradeHistory({ fetch: fetchFake }).aggregates('BTCUSDT', M);
  assert.equal(aggregates.length, 1_001, 'the aggregate at the next minute is excluded');
  assert.equal(aggregates[0]!.firstTradeId, String(base * 2n));
  assert.match(urls[0]!, new RegExp(`startTime=${M}&endTime=${M + 59_999}&limit=1000$`));
  assert.match(urls[1]!, new RegExp(`fromId=${base + 1_000n}&limit=1000$`));
  const endless = (async () => new Response(page1)) as unknown as typeof fetch;
  await assert.rejects(new BinanceAggTradeHistory({ fetch: endless, maxPages: 2 }).aggregates('BTCUSDT', M), /truncated/);
  const failing = (async () => new Response('busy', { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(new BinanceAggTradeHistory({ fetch: failing }).aggregates('BTCUSDT', M), /HTTP 429/);
  assert.throws(() => parseAggTrades('{"a":1}'), /not an array/);
});

test('L3 history with realistic multi-digit and above-2^53 trade IDs reconciles', async () => {
  const h = harness({}, M - 10_000);
  try {
    h.coordinator.enqueueSource('connected', M - 10_000); await h.coordinator.drain();
    const ids = ['9007199254740992', '9007199254740993', '9007199254740994'];
    const history = ids.map((id, i) => ({ firstTradeId: id, lastTradeId: id, eventTimeMs: M + 1_000 * (i + 1), price: `${100 + i}`, quantity: '1' }));
    h.coordinator.enqueueReconcile('BTCUSDT', M, history, 'test', M + 70_000); await h.coordinator.drain();
    assert.deepEqual(h.coordinator.decisions.at(-1)?.kind, 'repaired', h.coordinator.decisions.at(-1)?.detail);
    const bar = h.store.bars('BTCUSDT', M, M + 60_000, 10).bars[0]!;
    assert.deepEqual([bar.open, bar.close, bar.tradeCount], ['100', '102', 3]);
  } finally { h.close(); }
});

test('history failures back off and recover after more than three attempts without restarting', async () => {
  const h = harness({ symbols: ['BTCUSDT'] }, M + 10_000);
  let calls = 0;
  try {
    h.clock.advanceTo(M + 70_000);
    const reconciler = new Reconciler(h.coordinator, {
      name: 'transient-history',
      async aggregates() { if (++calls <= 4) throw new Error('temporarily unavailable'); return []; },
    }, { policy: 'all', retryBaseMs: 100, retryMaxMs: 400 });
    assert.equal(await reconciler.runOnce(), 0);
    assert.equal(await reconciler.runOnce(), 0);
    assert.equal(calls, 1, 'an immediate rerun does not hammer the failing source');
    for (const delay of [100, 200, 400]) {
      h.clock.advanceTo(h.clock.now() + delay);
      assert.equal(await reconciler.runOnce(), 0);
    }
    h.clock.advanceTo(h.clock.now() + 400);
    assert.equal(await reconciler.runOnce(), 1, 'the fifth attempt succeeds in this process');
    assert.equal(calls, 5);
    assert.equal(await reconciler.runOnce(), 0, 'successful empty history is durably confirmed');
  } finally { h.close(); }
});

test('poisoned oldest candidates cannot starve later minutes or another symbol', async () => {
  const h = harness({}, M + 10_000);
  const attempted = new Set<string>();
  try {
    h.clock.advanceTo(M + 430_000); // seven closed minutes per symbol
    const reconciler = new Reconciler(h.coordinator, {
      name: 'partly-unavailable-history',
      async aggregates(symbol, openTimeMs) {
        attempted.add(`${symbol}|${openTimeMs}`);
        if (symbol === 'BTCUSDT' && openTimeMs < M + 240_000) throw new Error('poisoned minute');
        return [];
      },
    }, { policy: 'all', maxPerRun: 1, retryBaseMs: 50, retryMaxMs: 50 });
    for (let i = 0; i < 14; i++) {
      await reconciler.runOnce();
      h.clock.advanceTo(h.clock.now() + 100); // even when old failures are already due again
    }
    assert.equal(attempted.size, 14, 'every eligible symbol/minute receives a first attempt');
    assert.equal(reconciler.counts.enqueued, 10);
    assert.ok(h.store.coverage('ETHUSDT', M + 360_000, M + 420_000, 10).events.some(e => e.reason === 'reconciled'));
  } finally { h.close(); }
});

for (const stall of ['headers', 'body'] as const) {
  test(`Binance history times out while waiting for response ${stall}`, { timeout: 3_000 }, async () => {
    const server = createServer((_request, response) => {
      if (stall === 'body') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('['); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const history = new BinanceAggTradeHistory({ endpoint: `http://127.0.0.1:${address.port}`, requestTimeoutMs: 50 });
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(Promise.race([
        history.aggregates('BTCUSDT', M),
        new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error('test guard expired without cancellation')), 1_000); }),
      ]), /timed out|timeout|aborted/i);
    } finally {
      clearTimeout(guard); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}

test('stopping reconciliation aborts its active history request and prevents late enqueue', async () => {
  const h = harness({ symbols: ['BTCUSDT'] }, M + 10_000);
  let announceRequest!: () => void;
  const requested = new Promise<void>(resolve => { announceRequest = resolve; });
  let aborted = false;
  const reconciler = new Reconciler(h.coordinator, {
    name: 'cancel-aware-history',
    aggregates(_symbol, _open, signal) {
      announceRequest();
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => { aborted = true; resolve([]); }, { once: true });
      });
    },
  }, { policy: 'all' });
  try {
    h.clock.advanceTo(M + 70_000);
    const run = reconciler.runOnce();
    await requested;
    await reconciler.stop();
    assert.equal(await run, 0);
    assert.equal(aborted, true);
    assert.equal(reconciler.counts.enqueued, 0, 'even a source resolving on abort cannot enqueue afterward');
    assert.equal(reconciler.counts.historyFailures, 0, 'normal shutdown is not a history failure');
    assert.equal(await reconciler.runOnce(), 0, 'stop also prevents new runs');
  } finally { h.close(); }
});

test('reconciler shutdown cancels a real HTTP body read before the store closes', { timeout: 3_000 }, async () => {
  const h = harness({ symbols: ['BTCUSDT'] }, M + 10_000);
  let announceBody!: () => void;
  const bodyStarted = new Promise<void>(resolve => { announceBody = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('['); announceBody();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const reconciler = new Reconciler(h.coordinator,
    new BinanceAggTradeHistory({ endpoint: `http://127.0.0.1:${address.port}`, requestTimeoutMs: 60_000 }), { policy: 'all' });
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    h.clock.advanceTo(M + 70_000);
    const run = reconciler.runOnce();
    await bodyStarted;
    await Promise.race([
      reconciler.stop(),
      new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error('shutdown failed to cancel HTTP IO')), 1_000); }),
    ]);
    assert.equal(await run, 0);
    assert.equal(reconciler.counts.historyFailures, 0);
    assert.equal(h.coordinator.queueDepth, 0);
  } finally {
    clearTimeout(guard); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await reconciler.stop(); h.close();
  }
});

test('shutdown remains bounded if an injected history ignores cancellation', { timeout: 3_000 }, async () => {
  const h = harness({ symbols: ['BTCUSDT'] }, M + 10_000);
  let finishHistory!: (value: []) => void;
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  const reconciler = new Reconciler(h.coordinator, {
    name: 'noncooperative-history',
    aggregates() { started(); return new Promise<[]>((resolve) => { finishHistory = resolve; }); },
  }, { policy: 'all' });
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    h.clock.advanceTo(M + 70_000);
    const run = reconciler.runOnce();
    await requested;
    await Promise.race([
      reconciler.stop(),
      new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error('shutdown waited for an uncancellable adapter')), 1_000); }),
    ]);
    finishHistory([]);
    assert.equal(await run, 0);
    assert.equal(reconciler.counts.enqueued, 0);
  } finally {
    clearTimeout(guard); finishHistory([]); await reconciler.stop(); h.close();
  }
});

test('an observability callback cannot interrupt reconciliation progress', async () => {
  const h = harness({ symbols: ['BTCUSDT'] }, M + 10_000);
  try {
    h.clock.advanceTo(M + 130_000);
    const reconciler = new Reconciler(h.coordinator, new TruthHistory([]), {
      policy: 'all', onEvent() { throw new Error('observer failed'); },
    });
    assert.equal(await reconciler.runOnce(), 2);
    assert.equal(reconciler.counts.observerFailures, 2);
    assert.equal(await reconciler.runOnce(), 0);
  } finally { h.close(); }
});
