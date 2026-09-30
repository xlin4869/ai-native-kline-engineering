import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { normalizeTrade, minuteOpen } from '../src/contracts.js';
import { reduceTrade } from '../src/aggregate.js';

const M = Date.parse('2026-01-01T12:00:00Z');
const raw = (id: string, offset: number, price: string, quantity = '1') =>
  ({ venue: 'mock', market: 'spot', symbol: 'BTCUSDT', tradeId: id, eventTimeMs: M + offset, price, quantity });

test('golden out-of-order trades use event order and exact quote volume', () => {
  let bar = null;
  for (const trade of [raw('1', 3_000, '100', '2'), raw('3', 48_000, '103', '1'), raw('2', 22_000, '99', '3')])
    bar = reduceTrade(bar, normalizeTrade(trade, ['BTCUSDT'], 'mock'));
  assert.deepEqual([bar!.open, bar!.high, bar!.low, bar!.close, bar!.volume, bar!.quoteVolume, bar!.tradeCount], ['100', '103', '99', '103', '6', '600', 3]);
});

test('same-millisecond IDs compare numerically and extreme valid price survives', () => {
  let bar = reduceTrade(null, normalizeTrade(raw('10', 2, '100'), ['BTCUSDT'], 'mock'));
  bar = reduceTrade(bar, normalizeTrade(raw('2', 2, '10000'), ['BTCUSDT'], 'mock'));
  bar = reduceTrade(bar, normalizeTrade(raw('11', 2, '101'), ['BTCUSDT'], 'mock'));
  assert.deepEqual([bar.open, bar.high, bar.close], ['10000', '10000', '101']);
});

test('UTC half-open bucket and canonical decimals', () => {
  assert.equal(minuteOpen(M + 59_999), M);
  assert.equal(minuteOpen(M + 60_000), M + 60_000);
  assert.throws(() => normalizeTrade(raw('1', 0, '01'), ['BTCUSDT'], 'mock'), /plain decimal/);
});

test('UTC minute alignment is independent of host timezone', () => {
  const code = `import { minuteOpen } from './src/contracts.ts'; process.stdout.write(String(minuteOpen(${M + 59_999})));`;
  for (const zone of ['UTC', 'America/New_York']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
      { cwd: process.cwd(), env: { ...process.env, TZ: zone }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${zone}: ${result.stderr}`);
    assert.equal(result.stdout, String(M));
  }
});
