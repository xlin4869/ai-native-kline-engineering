import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir, platform, release } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { VirtualClock } from '../src/clock.ts';
import { Coordinator } from '../src/coordinator.ts';
import { DEFAULT_CONFIG } from '../src/contracts.ts';
import { SqliteStore } from '../src/sqlite-store.ts';

const options = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--') && arg.includes('=')).map(arg => {
  const i = arg.indexOf('='); return [arg.slice(2, i), arg.slice(i + 1)];
}));
const events = Number(options.events ?? '5000');
const seedInput = Number(options.seed ?? '20260925');
const mode = options.storage ?? 'memory';
if (!Number.isSafeInteger(events) || events < 1 || events > 50_000 || !Number.isSafeInteger(seedInput) || !['memory', 'file'].includes(mode))
  throw new Error('usage: --events=1..50000 --seed=<safe integer> --storage=memory|file');
const dbPath = mode === 'file' ? join(mkdtempSync(join(tmpdir(), 'trade-kline-benchmark-')), 'service.db') : ':memory:';
const config = { ...DEFAULT_CONFIG, dbPath };
const M = Date.parse('2026-01-01T12:00:00Z');
const store = new SqliteStore(config); const coordinator = new Coordinator(store, new VirtualClock(M), config, 'benchmark');
let seed = seedInput >>> 0; const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
coordinator.enqueueSource('connected', M); await coordinator.drain();
const beforeRss = process.memoryUsage().rss;
const start = performance.now(); let maxQueueDepth = 0;
for (let i = 0; i < events; i++) {
  const t = { venue: 'mock', market: 'spot', symbol: 'BTCUSDT', tradeId: String(i + 1),
    eventTimeMs: M + (rand() % 60_000), price: `${90 + (rand() % 20)}.${String(rand() % 100).padStart(2, '0')}`,
    quantity: `0.${String(1 + (rand() % 999)).padStart(3, '0')}` };
  if (!coordinator.enqueueTrade(t, M + 61_000)) throw new Error('benchmark ingress rejected a valid trade');
  maxQueueDepth = Math.max(maxQueueDepth, coordinator.queueDepth);
  if (i % 1_000 === 999) await coordinator.drain();
}
await coordinator.drain();
const elapsedMs = performance.now() - start;
const accepted = store.meta().tradeCount;
if (accepted !== events || coordinator.writerFault) throw new Error(`benchmark mismatch: accepted=${accepted} fault=${coordinator.writerFault}`);
const afterRss = process.memoryUsage().rss;
const result = { mode, events, accepted, seed: seedInput, node: process.version, os: `${platform()} ${release()}`,
  elapsedMs: Number(elapsedMs.toFixed(3)), throughputPerSecond: Number((events / (elapsedMs / 1_000)).toFixed(1)),
  maxQueueDepth, rssBeforeBytes: beforeRss, rssAfterBytes: afterRss,
  metricDefinition: 'same-process enqueue plus synchronous SQLite transaction drain; excludes network, reconnect, HTTP clients and initial npm/tsx startup' };
store.close();
if (mode === 'file') {
  try { result.dbBytes = statSync(dbPath).size; } catch { /* Optional size observation. */ }
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
