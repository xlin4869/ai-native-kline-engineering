import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadScenario, runScenario, type Scenario } from '../src/mock-source.js';
import { referenceBars } from './oracle.js';
import { M, harness, trade } from './support.js';

test('mock gap fixture exposes startup partial, previous-minute gap and barless coverage', async () => {
  const scenario = await loadScenario(fileURLToPath(new URL('../fixtures/gaps.json', import.meta.url)));
  const h = harness({}, scenario.startMs);
  try {
    await runScenario(h.coordinator, scenario);
    const bar = h.store.bars('BTCUSDT', M, M + 60_000, 100).bars[0]!;
    assert.equal(bar.state, 'closed');
    assert.deepEqual(bar.quality.reasons, ['source_gap', 'startup_partial']);
    assert.equal(bar.quality.completeness, 'unverified');
    assert.equal(h.store.bars('ETHUSDT', M + 60_000, M + 120_000, 100).bars.length, 0);
    assert.equal(h.store.coverage('ETHUSDT', M + 60_000, M + 120_000, 100).events.some(x => x.reason === 'source_gap'), true);
  } finally { h.close(); }
});

test('mock supplier refuses a normal trade while disconnected', async () => {
  const scenario: Scenario = { name: 'bad-disconnect-delivery', startMs: M, truth: [trade('1', 1_000)],
    actions: [{ kind: 'source', atMs: M, state: 'connected' }, { kind: 'source', atMs: M + 500, state: 'disconnected' },
      { kind: 'trade', atMs: M + 1_100, trade: trade('1', 1_000) }] };
  const h = harness();
  try { await assert.rejects(runScenario(h.coordinator, scenario), /while source=disconnected/); }
  finally { h.close(); }
});

test('mock backpressure drains without replacing planned receive timestamps', async () => {
  const one = trade('1', 59_900); const two = trade('2', 59_901);
  const scenario: Scenario = { name: 'backpressure', startMs: M, truth: [one, two], drainEachAction: false,
    actions: [{ kind: 'source', atMs: M, state: 'connected' },
      { kind: 'trade', atMs: M + 61_998, trade: one },
      { kind: 'trade', atMs: M + 61_999, trade: two }] };
  const h = harness({ maxQueue: 1 });
  try {
    await runScenario(h.coordinator, scenario);
    assert.deepEqual(h.coordinator.decisions.map(x => x.kind), ['source', 'accepted', 'accepted']);
    assert.equal(h.store.bars('BTCUSDT', M, M + 60_000, 100).bars[0]?.tradeCount, 2);
    assert.equal(h.store.meta().lastProcessedIngressAt, M + 61_999);
  } finally { h.close(); }
});

test('independent mock truth detects a missing trade without falsely upgrading API completeness', async () => {
  const scenario = await loadScenario(fileURLToPath(new URL('../fixtures/missing-trade.json', import.meta.url)));
  const h = harness({}, scenario.startMs);
  try {
    await runScenario(h.coordinator, scenario);
    const actual = h.store.bars('BTCUSDT', M, M + 60_000, 100).bars[0]!;
    const truth = referenceBars(scenario.truth.map(t => ({ kind: 'trade', atMs: t.eventTimeMs + 100, trade: t })))
      .get(`mock|spot|BTCUSDT|${M}`)!;
    assert.equal(actual.tradeCount, 1);
    assert.equal(truth.tradeCount, 2);
    assert.notEqual(actual.close, truth.close);
    assert.equal(actual.quality.completeness, 'unverified');
    assert.ok(actual.quality.reasons.includes('source_gap'));
  } finally { h.close(); }
});
