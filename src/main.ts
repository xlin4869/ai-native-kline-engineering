import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createHttpApi } from './http.js';
import { RealClock, VirtualClock } from './clock.js';
import { Coordinator } from './coordinator.js';
import { BinanceTradeSource } from './binance-source.js';
import { DEFAULT_CONFIG, type ServiceConfig } from './contracts.js';
import { generateScenario } from './mock-generator.js';
import { loadScenario, runScenario, type Scenario } from './mock-source.js';
import { BinanceAggTradeHistory, Reconciler, TruthHistory, type ReconcilePolicy } from './reconciler.js';
import { SqliteStore } from './sqlite-store.js';

function arg(name: string, fallback: string): string {
  const match = process.argv.slice(2).find(item => item.startsWith(`--${name}=`));
  return match?.slice(name.length + 3) ?? fallback;
}

function integerArg(name: string, fallback: number): number {
  const value = arg(name, String(fallback));
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}

const log = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);

async function main(): Promise<void> {
  const source = arg('source', 'mock');
  if (source !== 'mock' && source !== 'binance') throw new Error('--source must be mock or binance');
  const port = integerArg('port', DEFAULT_CONFIG.port);
  const common = { dbPath: arg('db', ':memory:'), port,
    graceMs: integerArg('grace-ms', DEFAULT_CONFIG.graceMs),
    futureToleranceMs: integerArg('future-tolerance-ms', DEFAULT_CONFIG.futureToleranceMs),
    maxQueue: integerArg('max-queue', DEFAULT_CONFIG.maxQueue),
    maxTrades: integerArg('max-trades', DEFAULT_CONFIG.maxTrades),
    identityRetentionMs: integerArg('identity-retention-ms', DEFAULT_CONFIG.identityRetentionMs),
    historyRetentionMs: integerArg('history-retention-ms', DEFAULT_CONFIG.historyRetentionMs) };

  let scenario: Scenario | null = null;
  let config: ServiceConfig;
  if (source === 'binance') {
    const endpoint = arg('endpoint', 'wss://data-stream.binance.vision');
    config = { ...DEFAULT_CONFIG, ...common, source: 'binance', clockMode: 'real',
      symbols: arg('symbols', 'BTCUSDT').split(','), scenarioId: `binance-spot-trade:${endpoint}` };
  } else {
    const seed = arg('generate-seed', '');
    scenario = seed
      ? generateScenario({ seed: integerArg('generate-seed', 1), minutes: integerArg('generate-minutes', 5),
          startMs: Date.parse('2026-01-01T12:00:17.250Z') })
      : await loadScenario(resolve(arg('scenario', 'fixtures/golden.json')));
    config = { ...DEFAULT_CONFIG, ...common, scenarioId: createHash('sha256').update(JSON.stringify(scenario)).digest('hex') };
  }

  const store = new SqliteStore(config);
  const coordinator = new Coordinator(store, scenario ? new VirtualClock(scenario.startMs) : new RealClock(), config);
  const server = createHttpApi(coordinator);
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  log({ event: 'listening', port: actualPort, source, scenario: scenario?.name ?? null, symbols: config.symbols });

  let closing = false;
  const abort = new AbortController();
  let live: BinanceTradeSource | null = null;
  let ticker: NodeJS.Timeout | null = null;
  let reconcileTimer: NodeJS.Timeout | null = null;
  const policy = arg('reconcile', source === 'binance' ? 'flagged' : 'off') as ReconcilePolicy;
  if (!['off', 'flagged', 'all'].includes(policy)) throw new Error('--reconcile must be off, flagged or all');
  const reconciler = policy === 'off' ? null : new Reconciler(coordinator,
    source === 'binance' ? new BinanceAggTradeHistory({ endpoint: arg('rest-endpoint', 'https://data-api.binance.vision') }) : new TruthHistory(scenario!.truth),
    { policy, onEvent: ({ event, ...detail }) => log({ event: 'reconcile', what: event, ...detail }) });
  const shutdown = async () => {
    if (closing) return;
    closing = true; abort.abort();
    const hardStop = setTimeout(() => process.exit(1), 5_000); hardStop.unref();
    try {
      if (ticker) clearInterval(ticker);
      if (reconcileTimer) clearInterval(reconcileTimer);
      await reconciler?.stop();
      if (live) { await live.stop(); log({ event: 'live_stopped', counts: live.counts, commitSeq: store.meta().commitSeq }); }
      await coordinator.drain();
      if (!coordinator.writerFault && store.meta().sourceState !== 'stopped') {
        coordinator.enqueueSource('stopped'); await coordinator.drain();
      }
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      store.close(); clearTimeout(hardStop);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  };
  process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });

  if (source === 'binance') {
    live = new BinanceTradeSource(coordinator, { endpoint: arg('endpoint', 'wss://data-stream.binance.vision'), symbols: config.symbols,
      silenceTimeoutMs: integerArg('silence-timeout-ms', 60_000), onEvent: ({ event, ...detail }) => log({ event: 'live', what: event, ...detail }) });
    // Real time drives closure of idle bars; the tick is a no-op when nothing is due.
    ticker = setInterval(() => { coordinator.enqueueTick(); void coordinator.drain(); }, 250);
    live.start();
    if (reconciler) reconcileTimer = setInterval(() => {
      void reconciler.runOnce().catch(error => log({ event: 'reconcile_run_failed',
        error: error instanceof Error ? error.message : String(error) }));
    }, integerArg('reconcile-interval-ms', 15_000));
    const durationS = integerArg('duration-s', 0);
    if (durationS > 0) setTimeout(() => { void shutdown(); }, durationS * 1_000).unref();
    return;
  }
  try {
    await runScenario(coordinator, scenario!, abort.signal);
    if (reconciler) while (await reconciler.runOnce() > 0) { /* mock history: reconcile every candidate now */ }
    log({ event: 'scenario_completed', decisions: coordinator.decisions.length, commitSeq: store.meta().commitSeq,
      ...(reconciler ? { reconcile: reconciler.counts } : {}) });
  } catch (error) {
    if (!closing) {
      process.stderr.write(`${JSON.stringify({ event: 'scenario_failed', error: error instanceof Error ? error.message : String(error) })}\n`);
      process.exitCode = 1;
      await shutdown();
    }
  }
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
