// Records raw Binance Spot @trade frames with local receive times, then, for the same minutes, the official REST 1m
// klines (reference) and aggregate-trade history (backfill input), into one JSON fixture for offline replay.
// Needs network; not part of `npm test`. Run with tsx because it reuses the service's history client.
// Usage: node --import tsx scripts/binance-capture.mjs --symbols=BTCUSDT --seconds=200 --out=fixtures/binance/capture.json
//        node --import tsx scripts/binance-capture.mjs --augment=fixtures/binance/capture.json   (add history to an existing capture)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { BinanceAggTradeHistory } from '../src/reconciler.ts';

const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--') && x.includes('=')).map(x => {
  const i = x.indexOf('='); return [x.slice(2, i), x.slice(i + 1)];
}));
const streamBase = args['stream-endpoint'] ?? 'wss://data-stream.binance.vision';
const restBase = args['rest-endpoint'] ?? 'https://data-api.binance.vision';

async function capture() {
  const symbols = (args.symbols ?? 'BTCUSDT').split(',');
  const seconds = Number(args.seconds ?? '200');
  if (!symbols.every(s => /^[A-Z0-9]{1,20}$/.test(s)) || !Number.isInteger(seconds) || seconds < 10 || seconds > 900) throw new Error('bad arguments');
  const url = `${streamBase}/stream?streams=${symbols.map(s => `${s.toLowerCase()}@trade`).join('/')}`;
  const frames = []; const events = [];
  const socket = new WebSocket(url);
  await new Promise(resolveDone => {
    socket.onopen = () => { events.push({ r: Date.now(), type: 'open' }); setTimeout(() => socket.close(1000, 'capture complete'), seconds * 1_000); };
    socket.onmessage = event => { frames.push([Date.now(), String(event.data)]); };
    socket.onerror = event => { events.push({ r: Date.now(), type: 'error', detail: String(event?.message ?? 'error') }); };
    socket.onclose = event => { events.push({ r: Date.now(), type: 'close', code: event.code, reason: event.reason }); resolveDone(); };
  });
  if (!frames.length) throw new Error(`no frames captured: ${JSON.stringify(events)}`);
  await new Promise(r => setTimeout(r, 3_000)); // let the exchange finalize the last minute before reading REST
  return {
    description: 'Raw Binance Spot combined-stream @trade frames with local receive times, plus REST /api/v3/klines 1m rows and /api/v3/aggTrades history for the same minutes.',
    stream: url, rest: `${restBase}/api/v3/klines`, capturedAt: new Date(frames[0][0]).toISOString(), node: process.version,
    officialDocs: 'binance/binance-spot-api-docs web-socket-streams.md and rest-api.md, master @ 828ca74 (2026-09-18)',
    symbols, events, frameCount: frames.length, frames,
  };
}

const out = resolve(args.augment ?? args.out ?? 'fixtures/binance/capture.json');
const fixture = args.augment ? JSON.parse(await readFile(out, 'utf8')) : await capture();
const symbols = fixture.symbols ?? [...new Set(fixture.frames.map(([, text]) => JSON.parse(text).data?.s).filter(Boolean))];
const firstOpen = Math.floor(fixture.frames[0][0] / 60_000) * 60_000 - 60_000;
const lastOpen = Math.floor(fixture.frames.at(-1)[0] / 60_000) * 60_000;
fixture.klines ??= {};
fixture.aggTrades = {};
const history = new BinanceAggTradeHistory({ endpoint: restBase });
for (const symbol of symbols) {
  if (!fixture.klines[symbol]) {
    const response = await fetch(`${restBase}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${firstOpen}&endTime=${fixture.frames.at(-1)[0]}`);
    if (!response.ok) throw new Error(`klines ${symbol}: HTTP ${response.status}`);
    fixture.klines[symbol] = await response.json();
  }
  fixture.aggTrades[symbol] = {};
  for (let open = firstOpen; open <= lastOpen; open += 60_000) fixture.aggTrades[symbol][open] = await history.aggregates(symbol, open);
}
fixture.aggTradesSource = `${restBase}/api/v3/aggTrades (fetched ${new Date().toISOString()})`;
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(fixture)}\n`);
process.stdout.write(`${JSON.stringify({ out, frames: fixture.frames.length, klineRows: Object.fromEntries(Object.entries(fixture.klines).map(([k, v]) => [k, v.length])),
  aggTrades: Object.fromEntries(Object.entries(fixture.aggTrades).map(([k, v]) => [k, Object.values(v).map(rows => rows.length)])) })}\n`);
