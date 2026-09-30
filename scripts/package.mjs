import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { zipSync } from 'fflate';

const root = resolve(process.cwd());
const rootFiles = ['.nvmrc', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'ASSIGNMENT.md', 'AI_NATIVE_CASE_STUDY.md', 'DESIGN.md', 'LIMITATIONS.md', 'REUSE.md', 'AI_USAGE.md', 'REPORT.md'];
const dirRules = new Map([
  ['src', new Set(['.ts'])], ['tests', new Set(['.ts'])], ['fixtures', new Set(['.json'])],
  ['scripts', new Set(['.mjs'])], ['examples', new Set(['.mjs'])], ['results', new Set(['.md', '.json', '.txt'])],
  ['AI_HISTORY', new Set(['.md', '.txt'])],
]);
const files = [...rootFiles];
async function collect(dir, extensions) {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  for (const entry of entries) {
    const name = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await collect(name, extensions);
    else if (entry.isFile() && [...extensions].some(ext => entry.name.endsWith(ext))) files.push(name);
    else throw new Error(`non-allowlisted or linked package entry: ${name}`);
  }
}
for (const [dir, ext] of dirRules) await collect(dir, ext);
files.sort();
if (!files.some(file => file.startsWith('AI_HISTORY/transcripts/')) || !files.includes('results/verification.md'))
  throw new Error('AI transcripts and verification record are required before packaging');
const entries = {};
let totalBytes = 0;
for (const file of files) {
  const absolute = resolve(root, file);
  if (!absolute.startsWith(root + sep)) throw new Error(`unsafe package path: ${file}`);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 5_000_000) throw new Error(`unsafe or oversized package file: ${file}`);
  totalBytes += info.size;
  if (totalBytes > 25_000_000) throw new Error('package exceeds 25MB input limit');
  entries[relative(root, absolute).replaceAll('\\', '/')] = new Uint8Array(await readFile(absolute));
}
const archive = zipSync(entries, { level: 6 });
await mkdir(join(root, 'dist'), { recursive: true });
const target = join(root, 'dist', 'trade-kline-service.zip');
await writeFile(target, archive);
process.stdout.write(`${JSON.stringify({ archive: target, files: files.length, inputBytes: totalBytes, zipBytes: archive.length,
  sha256: createHash('sha256').update(archive).digest('hex') }, null, 2)}\n`);
