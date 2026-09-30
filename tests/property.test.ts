// Seeded end-to-end property test over generated mock scenarios (normal activity plus faults).
// Checks, per seed: (1) service bars equal the independent oracle over the actual deliveries, bar for bar;
// (2) every bar is closed after the final advance; (3) whenever a minute differs from market truth for a reason
// the service could observe, that minute carries a quality reason; (4) known_incomplete is never claimed for a
// minute that matches truth; (5) bar reasons and the coverage API agree.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../src/contracts.js';
import { generateScenario } from '../src/mock-generator.js';
import { runScenario } from '../src/mock-source.js';
import { Reconciler, TruthHistory } from '../src/reconciler.js';
import { oracleContent, referenceAccepted, referenceBars } from './oracle.js';
import { harness } from './support.js';

const MINUTE = 60_000;
const SEEDS = Number(process.env.PROPERTY_SEEDS ?? 60);
const { graceMs, futureToleranceMs } = DEFAULT_CONFIG;

test(`generated scenarios keep numeric and quality contracts across ${SEEDS} seeds`, async () => {
  const totals = { trades: 0, deliveries: 0, bars: 0, observableMisses: 0, silentOnlyMinutes: 0, knownIncompleteBars: 0 };
  for (let seed = 1; seed <= SEEDS; seed++) {
    // Mix minute-aligned and mid-minute starts.
    const startMs = Date.parse('2026-03-01T00:00:00Z') + seed * 3_600_000 + (seed % 3 === 0 ? 0 : (seed * 7_919) % MINUTE);
    const scenario = generateScenario({ seed, startMs, minutes: 5 });
    assert.deepEqual(generateScenario({ seed, startMs, minutes: 5 }), scenario, `seed=${seed} generation is deterministic`);
    const h = harness({}, startMs);
    try {
      await runScenario(h.coordinator, scenario);
      const expected = referenceBars(scenario.actions, graceMs, futureToleranceMs);
      const accepted = referenceAccepted(scenario.actions, graceMs, futureToleranceMs);
      const truthByMinute = new Map<string, typeof scenario.truth>();
      for (const t of scenario.truth) {
        const k = `${t.symbol}|${Math.floor(t.eventTimeMs / MINUTE) * MINUTE}`;
        truthByMinute.set(k, [...(truthByMinute.get(k) ?? []), t]);
      }
      const delivered = new Set(scenario.actions.flatMap(a => a.kind === 'trade' ? [`${a.trade.symbol}|${a.trade.tradeId}`] : []));
      const from = Math.floor(startMs / MINUTE) * MINUTE - 3 * MINUTE, to = from + 10 * MINUTE;
      for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
        const bars = h.store.bars(symbol, from, to, 1_000).bars;
        const actualKeys = bars.map(b => b.openTimeMs);
        const expectedKeys = [...expected.keys()].filter(k => k.startsWith(`mock|spot|${symbol}|`)).map(k => Number(k.split('|')[3])).sort((a, b) => a - b);
        assert.deepEqual(actualKeys, expectedKeys, `seed=${seed} ${symbol} bar set`);
        for (const bar of bars) {
          const ref = expected.get(`mock|spot|${symbol}|${bar.openTimeMs}`)!;
          assert.deepEqual([bar.open, bar.high, bar.low, bar.close, bar.volume, bar.quoteVolume, bar.tradeCount],
            [ref.open, ref.high, ref.low, ref.close, ref.volume, ref.quoteVolume, ref.tradeCount], `seed=${seed} ${symbol} ${bar.openTimeMs}`);
          assert.equal(bar.state, 'closed', `seed=${seed} ${symbol} ${bar.openTimeMs} closed after final advance`);
          const coverage = h.store.coverage(symbol, bar.openTimeMs, bar.openTimeMs + MINUTE, 1_000).events;
          assert.deepEqual(bar.quality.reasons, [...new Set(coverage.map(e => e.reason))].sort(), `seed=${seed} bar reasons == coverage`);
        }
        totals.bars += bars.length;
        for (let open = from; open < to; open += MINUTE) {
          const truth = truthByMinute.get(`${symbol}|${open}`) ?? [];
          const missing = truth.filter(t => accepted.get(`mock|spot|${symbol}|${t.tradeId}`) === undefined ||
            oracleContent(accepted.get(`mock|spot|${symbol}|${t.tradeId}`)!) !== oracleContent(t));
          const observable = missing.filter(t => {
            const plan = scenario.plans[`${symbol}|${t.tradeId}`]!;
            if (plan.fate === 'silent_loss') return false;
            if (delivered.has(`${symbol}|${t.tradeId}`)) return true; // received, then rejected or overridden
            return plan.attempts.some(at => at >= open - futureToleranceMs && at < open + MINUTE + graceMs);
          });
          const coverage = h.store.coverage(symbol, open, open + MINUTE, 1_000).events;
          const bar = bars.find(b => b.openTimeMs === open);
          if (observable.length) {
            totals.observableMisses += observable.length;
            assert.ok(coverage.length > 0, `seed=${seed} ${symbol} ${open}: observable miss of ${observable.map(t => t.tradeId)} has no reason`);
          } else if (missing.length && !coverage.length) totals.silentOnlyMinutes++;
          if (bar?.quality.completeness === 'known_incomplete') {
            totals.knownIncompleteBars++;
            assert.ok(missing.length > 0, `seed=${seed} ${symbol} ${open}: known_incomplete but matches truth`);
          }
        }
      }
      totals.trades += scenario.truth.length;
      totals.deliveries += scenario.actions.filter(a => a.kind === 'trade').length;
    } finally { h.close(); }
  }
  // Guard against a generator that stopped exercising the interesting paths.
  assert.ok(totals.observableMisses > 50 && totals.knownIncompleteBars > 10 && totals.silentOnlyMinutes > 0, JSON.stringify(totals));
  process.stdout.write(`# property totals ${JSON.stringify(totals)}\n`);
});

// Round 3: reconciling every observable minute against the scenario's market truth must reproduce truth exactly,
// including minutes whose losses were silent, late, skewed or hidden by a disconnect.
test(`reconciliation against market truth restores every observable minute across ${Math.min(SEEDS, 30)} seeds`, async () => {
  const totals = { minutes: 0, repaired: 0, confirmed: 0, barless: 0 };
  for (let seed = 1; seed <= Math.min(SEEDS, 30); seed++) {
    const startMs = Date.parse('2026-03-01T00:00:00Z') + seed * 3_600_000 + (seed % 3 === 0 ? 0 : (seed * 7_919) % MINUTE);
    const scenario = generateScenario({ seed, startMs, minutes: 5 });
    const h = harness({}, startMs);
    try {
      await runScenario(h.coordinator, scenario);
      const reconciler = new Reconciler(h.coordinator, new TruthHistory(scenario.truth), { policy: 'all', maxPerRun: 50 });
      while (await reconciler.runOnce() > 0) { /* until no candidate is left */ }
      const truth = referenceBars(scenario.truth.map(t => ({ kind: 'trade', atMs: t.eventTimeMs, trade: t })), graceMs, futureToleranceMs);
      // Observable minutes: receive window ends after the start; all are past the final advance.
      const first = Math.floor((startMs - MINUTE - graceMs) / MINUTE) * MINUTE + MINUTE;
      const last = Math.floor((startMs + 5 * MINUTE) / MINUTE) * MINUTE;
      for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
        for (let open = first; open <= last; open += MINUTE) {
          const bar = h.store.bars(symbol, open, open + MINUTE, 1).bars[0];
          const ref = truth.get(`mock|spot|${symbol}|${open}`);
          totals.minutes++;
          if (!ref) {
            assert.equal(bar, undefined, `seed=${seed} ${symbol} ${open}: history has no trades`);
            totals.barless++;
            continue;
          }
          assert.ok(bar, `seed=${seed} ${symbol} ${open}: missing bar`);
          assert.deepEqual([bar.open, bar.high, bar.low, bar.close, bar.volume, bar.quoteVolume, bar.tradeCount],
            [ref.open, ref.high, ref.low, ref.close, ref.volume, ref.quoteVolume, ref.tradeCount], `seed=${seed} ${symbol} ${open}`);
          assert.equal(bar.quality.completeness, 'reconciled', `seed=${seed} ${symbol} ${open}`);
          if (bar.quality.reasons.includes('repaired')) totals.repaired++; else totals.confirmed++;
        }
      }
    } finally { h.close(); }
  }
  assert.ok(totals.repaired > 20 && totals.confirmed > 20, JSON.stringify(totals));
  process.stdout.write(`# reconciliation totals ${JSON.stringify(totals)}\n`);
});
