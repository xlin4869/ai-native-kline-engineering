import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

// Starts the real service process on a random port and resolves once the mock scenario has been fully ingested.
async function startService(extraArgs) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--source=mock', '--db=:memory:', '--port=0', ...extraArgs],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => { child.kill(); }, 60_000);
  let port = null; let completed = false;
  for await (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.event === 'listening') port = event.port;
    if (event.event === 'scenario_completed') { completed = true; break; }
  }
  clearTimeout(timeout);
  assert.ok(completed && port, `mock scenario did not finish: ${stderr}`);
  return { base: `http://127.0.0.1:${port}`, stop: () => child.kill('SIGTERM') };
}
const consume = (base, extra) => {
  const result = spawnSync(process.execPath, ['examples/read-klines.mjs', `--base-url=${base}`, ...extra], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

// Phase 1: golden fixture with a hand-calculated expected bar.
const M = Date.parse('2026-01-01T12:00:00Z');
const golden = await startService(['--scenario=fixtures/golden.json']);
let summary;
try {
  const response = await fetch(`${golden.base}/v1/klines?symbol=BTCUSDT&from=${M}&to=${M + 60_000}`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  const bar = payload.bars[0];
  assert.deepEqual([bar.open, bar.high, bar.low, bar.close, bar.volume, bar.quoteVolume, bar.tradeCount, bar.state],
    ['100', '103', '99', '103', '6', '600', 3, 'closed']);
  assert.equal(bar.quality.completeness, 'unverified');
  assert.deepEqual(bar.quality.reasons, [], 'the golden minute is fully observed');
  const consumed = consume(golden.base, ['--symbol=BTCUSDT']);
  assert.equal(consumed.history.bars[0].quoteVolume, '600');
  summary = { golden: { bar, asOfCommitSeq: payload.asOfCommitSeq, sourceState: payload.sourceState } };
} finally { golden.stop(); }

// Phase 2: seeded normal-activity-plus-faults scenario, reconciled against its market truth, then read through
// paginated HTTP by the consumer.
const generated = await startService(['--generate-seed=7', '--generate-minutes=5', '--reconcile=all']);
try {
  const from = M - 3 * 60_000, to = M + 8 * 60_000;
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    const paged = consume(generated.base, [`--symbol=${symbol}`, `--from=${from}`, `--to=${to}`, '--limit=2']);
    const whole = await (await fetch(`${generated.base}/v1/klines?symbol=${symbol}&from=${from}&to=${to}&limit=1000`)).json();
    assert.ok(paged.history.pages > 2, 'the consumer really paged');
    assert.deepEqual(paged.history.bars, whole.bars, `${symbol}: paged history equals one unpaged read`);
    assert.ok(whole.bars.length >= 5 && whole.bars.every(bar => bar.state === 'closed'));
    assert.ok(whole.bars.every(bar => bar.quality.completeness === 'reconciled'), 'every closed minute was reconciled');
    assert.ok(paged.coverage.events.some(event => event.reason === 'startup_partial'), 'pre-start period is reported');
    summary[`generated_${symbol}`] = { bars: whole.bars.length, pages: paged.history.pages, coverageEvents: paged.coverage.events.length,
      coveragePages: paged.coverage.pages, reasons: [...new Set(whole.bars.flatMap(bar => bar.quality.reasons))].sort(),
      repairedBars: whole.bars.filter(bar => bar.quality.reasons.includes('repaired')).length };
  }
} finally { generated.stop(); }
process.stdout.write(`${JSON.stringify({ demo: 'passed', ...summary }, null, 2)}\n`);
