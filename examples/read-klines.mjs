// Thin downstream consumer: reads history (following nextFrom), open bars, coverage (following nextCursor) and
// readiness over HTTP. Usage: node examples/read-klines.mjs --base-url=http://127.0.0.1:3000 --symbol=BTCUSDT
//   [--from=<ms> --to=<ms> --limit=<1..1000>]
const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--') && x.includes('=')).map(x => {
  const index = x.indexOf('='); return [x.slice(2, index), x.slice(index + 1)];
}));
const base = args['base-url'] ?? 'http://127.0.0.1:3000';
const symbol = args.symbol ?? 'BTCUSDT';
const from = args.from ?? String(Date.parse('2026-01-01T12:00:00Z'));
const to = args.to ?? String(Number(from) + 120_000);
const limit = args.limit ?? '100';
async function read(path) {
  const response = await fetch(`${base}${path}`);
  const body = await response.json();
  if (response.status !== 200 && !path.startsWith('/readyz')) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return { httpStatus: response.status, ...body };
}
const s = encodeURIComponent(symbol);
const bars = []; let pages = 0; let asOf = [];
for (let cursor = from; cursor !== null; pages++) {
  const page = await read(`/v1/klines?symbol=${s}&from=${cursor}&to=${to}&limit=${limit}`);
  bars.push(...page.bars); asOf.push(page.asOfCommitSeq); cursor = page.nextFrom;
}
const events = []; let coveragePages = 0;
for (let cursor = 0; cursor !== null; coveragePages++) {
  const page = await read(`/v1/coverage?symbol=${s}&from=${from}&to=${to}&limit=${limit}&cursor=${cursor}`);
  events.push(...page.events); cursor = page.nextCursor;
}
const output = {
  history: { bars, pages, asOfCommitSeq: asOf },
  current: await read(`/v1/klines/current?symbol=${s}`),
  coverage: { events, pages: coveragePages },
  readiness: await read('/readyz'),
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
