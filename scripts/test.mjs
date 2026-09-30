import { spawnSync } from 'node:child_process';

const suiteArg = process.argv.slice(2).find(arg => arg.startsWith('--suite='));
const suite = suiteArg?.slice('--suite='.length) ?? 'all';
const tests = {
  core: ['tests/aggregate.test.ts', 'tests/coordinator.test.ts', 'tests/oracle.test.ts', 'tests/mock.test.ts'],
  api: ['tests/http.test.ts'],
  recovery: ['tests/recovery.test.ts', 'tests/enospc.test.ts'],
  review: ['tests/review.test.ts'],
  property: ['tests/property.test.ts'],
  binance: ['tests/binance.test.ts'],
  hardening: ['tests/hardening.test.ts', 'tests/reconcile.test.ts'],
  retention: ['tests/history-retention.test.ts'],
};
if (suite !== 'all' && !(suite in tests)) throw new Error(`unknown suite: ${suite}`);
const unknown = process.argv.slice(2).filter(arg => !arg.startsWith('--suite='));
if (unknown.length) throw new Error(`unknown test arguments: ${unknown.join(' ')}`);
const files = suite === 'all' ? Object.values(tests).flat() : tests[suite];
const { status, error } = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
if (error) throw error;
process.exit(status ?? 1);
