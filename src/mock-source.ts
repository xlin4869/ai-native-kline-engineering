import { readFile, stat } from 'node:fs/promises';
import type { Trade } from './contracts.js';
import type { Coordinator } from './coordinator.js';

export type MockAction =
  | { kind: 'trade'; atMs: number; trade: Trade }
  | { kind: 'advance'; atMs: number }
  | { kind: 'source'; atMs: number; state: 'connected' | 'disconnected' | 'stopped' }
  | { kind: 'drain'; atMs: number };
export interface Scenario { name: string; startMs: number; truth: Trade[]; actions: MockAction[]; drainEachAction?: boolean }

export async function loadScenario(file: string): Promise<Scenario> {
  if ((await stat(file)).size > 5_000_000) throw new Error('scenario file exceeds 5MB limit');
  const scenario = JSON.parse(await readFile(file, 'utf8')) as Scenario;
  if (!scenario || !Number.isSafeInteger(scenario.startMs) || !Array.isArray(scenario.truth) || !Array.isArray(scenario.actions))
    throw new Error('invalid scenario structure');
  return scenario;
}

export async function runScenario(coordinator: Coordinator, scenario: Scenario, signal?: AbortSignal): Promise<void> {
  let lastAt = scenario.startMs;
  let sourceState: 'connected' | 'disconnected' | 'stopped' = 'stopped';
  for (const action of scenario.actions) {
    if (signal?.aborted) throw new Error('scenario aborted');
    if (!Number.isSafeInteger(action.atMs) || action.atMs < lastAt) throw new Error('scenario actions must be time ordered');
    lastAt = action.atMs;
    if (action.kind === 'trade') {
      if (sourceState !== 'connected') throw new Error(`mock trade delivered while source=${sourceState}`);
      if (!coordinator.hasDataCapacity) await coordinator.drain();
      if (!coordinator.enqueueTrade(action.trade, action.atMs)) throw new Error(`mock trade could not enqueue at ${action.atMs}`);
    } else if (action.kind === 'advance') {
      coordinator.clock.advanceTo?.(action.atMs);
      coordinator.enqueueTick(action.atMs);
    } else if (action.kind === 'source') { coordinator.enqueueSource(action.state, action.atMs); sourceState = action.state; }
    else { coordinator.clock.advanceTo?.(action.atMs); await coordinator.drain(); }
    if (scenario.drainEachAction !== false) await coordinator.drain();
    if (coordinator.writerFault) throw new Error(`mock service fault: ${coordinator.writerFault}`);
  }
  await coordinator.drain();
  if (coordinator.writerFault) throw new Error(`mock service fault: ${coordinator.writerFault}`);
}
