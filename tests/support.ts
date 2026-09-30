import { DEFAULT_CONFIG, type ServiceConfig, type Trade } from '../src/contracts.js';
import { VirtualClock } from '../src/clock.js';
import { Coordinator } from '../src/coordinator.js';
import { SqliteStore } from '../src/sqlite-store.js';

export const M = Date.parse('2026-01-01T12:00:00.000Z');
export const trade = (id: string, offsetMs: number, price = '100', quantity = '1', symbol = 'BTCUSDT'): Trade =>
  ({ venue: 'mock', market: 'spot', symbol, tradeId: id, eventTimeMs: M + offsetMs, price, quantity });

export function harness(overrides: Partial<ServiceConfig> = {}, startMs = M) {
  const config: ServiceConfig = { ...DEFAULT_CONFIG, ...overrides, symbols: overrides.symbols ?? [...DEFAULT_CONFIG.symbols] };
  const store = new SqliteStore(config);
  const clock = new VirtualClock(startMs);
  const coordinator = new Coordinator(store, clock, config, 'test-run');
  return { config, store, clock, coordinator, close: () => store.close() };
}
