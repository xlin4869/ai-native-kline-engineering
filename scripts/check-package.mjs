import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';

const archiveArg = process.argv.slice(2).find(x => x.startsWith('--archive='));
if (!archiveArg) throw new Error('pass --archive=dist/trade-kline-service.zip');
const archive = resolve(archiveArg.slice('--archive='.length));
const data = new Uint8Array(await readFile(archive));
if (data.length > 25_000_000) throw new Error('archive exceeds 25MB');
const entries = unzipSync(data);
const root = await mkdtemp(join(tmpdir(), 'trade-kline-package-check-'));
let total = 0;
for (const [name, bytes] of Object.entries(entries)) {
  if (!name || name.includes('\\') || name.split('/').includes('..') || isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw new Error(`unsafe ZIP entry: ${name}`);
  const target = resolve(root, name);
  if (!target.startsWith(resolve(root) + sep)) throw new Error(`ZIP escape: ${name}`);
  if (bytes.length > 5_000_000 || (total += bytes.length) > 25_000_000) throw new Error('expanded ZIP exceeds bounds');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
const names = Object.keys(entries);
for (const required of ['.nvmrc', 'package.json', 'package-lock.json', 'README.md', 'ASSIGNMENT.md',
  'AI_NATIVE_CASE_STUDY.md', 'REPORT.md', 'src/main.ts', 'fixtures/golden.json',
  'tests/oracle.ts', 'results/verification.md', 'results/acceptance-windows.txt',
  'results/acceptance-linux.txt', 'AI_HISTORY/INDEX.md'])
  if (!names.includes(required)) throw new Error(`missing required ZIP entry: ${required}`);
if (names.some(name => /(^|\/)(node_modules|\.git|\.env)(\/|$)|\.(db|db-wal|db-shm)$/i.test(name))) throw new Error('forbidden ZIP entry');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const args of [['ci'], ['run', 'typecheck'], ['test'], ['run', 'demo']]) {
  const result = spawnSync(npm, args, { cwd: root, stdio: 'inherit', timeout: 180_000, shell: process.platform === 'win32' });
  if (result.error || result.status !== 0) throw new Error(`${npm} ${args.join(' ')} failed: ${result.error?.message ?? result.status}`);
}
process.stdout.write(`${JSON.stringify({ status: 'passed', archive, extractedTo: root, entries: names.length,
  checks: ['npm ci', 'npm run typecheck', 'npm test', 'npm run demo (includes real HTTP consumer)'] }, null, 2)}\n`);
