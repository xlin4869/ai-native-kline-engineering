import { writeSync } from 'node:fs';
import { VirtualClock } from '../src/clock.js';
import { Coordinator } from '../src/coordinator.js';
import { DEFAULT_CONFIG } from '../src/contracts.js';
import { SqliteStore, type StoreHooks } from '../src/sqlite-store.js';
import { M, trade } from './support.js';

const [dbPath, phase] = process.argv.slice(2);
if (!dbPath || !['before', 'after'].includes(phase ?? '')) throw new Error('usage: child-runner <db> <before|after>');
const kill = () => { writeSync(1, `hook:${phase}\n`); process.kill(process.pid, 'SIGKILL'); };
const hooks: StoreHooks = phase === 'before' ? { beforeCommit: kill } : { afterCommitBeforeReply: kill };
const config = { ...DEFAULT_CONFIG, dbPath };
const store = new SqliteStore(config, hooks);
const coordinator = new Coordinator(store, new VirtualClock(M), config);
writeSync(1, 'armed\n');
coordinator.enqueueTrade(trade('1', 1_000, '100', '2'), M + 1_100);
await coordinator.drain();
writeSync(1, 'unexpected_return\n');
store.close();
