// Live end-to-end check (needs network; not part of `npm test`): runs the real service with --source=binance, reads it
// through its HTTP API like a consumer, and compares closed bars with the exchange's own REST 1m klines.
// --drop-after-s=N routes the stream through a local relay that cuts every connection at N s and refuses new ones
// for --drop-for-s (default 20), so the service sees a real network drop, reconnects and reconciles the gap.
// Usage: node scripts/binance-live-check.mjs --symbols=BTCUSDT,ETHUSDT --full-minutes=2 [--drop-after-s=70]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import { createInterface } from 'node:readline';

const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--') && x.includes('=')).map(x => {
  const i = x.indexOf('='); return [x.slice(2, i), x.slice(i + 1)];
}));
const symbols = args.symbols ?? 'BTCUSDT,ETHUSDT';
const fullMinutes = Number(args['full-minutes'] ?? '2');
const rest = args['rest-endpoint'] ?? 'https://data-api.binance.vision';
const dropAfterS = Number(args['drop-after-s'] ?? '0'), dropForS = Number(args['drop-for-s'] ?? '20');
const canonical = value => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;

// Test relay: plain ws on localhost -> TLS to the market-data stream, with the Host header rewritten.
const upstreamHost = 'data-stream.binance.vision';
let blocked = false; const sockets = new Set(); const relayLog = [];
const relay = net.createServer(client => {
  if (blocked) { relayLog.push({ at: new Date().toISOString(), event: 'refused' }); client.destroy(); return; }
  sockets.add(client);
  client.once('data', head => {
    const request = head.toString('latin1').replace(/\r\nHost: [^\r\n]+/i, `\r\nHost: ${upstreamHost}`);
    const upstream = tls.connect({ host: upstreamHost, port: 443, servername: upstreamHost }, () => {
      upstream.write(Buffer.from(request, 'latin1')); client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream);
    const end = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    upstream.on('error', end); upstream.on('close', end); client.on('error', end); client.on('close', end);
  });
});
if (dropAfterS > 0) await new Promise(resolveListen => relay.listen(0, '127.0.0.1', resolveListen));
const endpoint = dropAfterS > 0 ? `ws://127.0.0.1:${relay.address().port}` : 'wss://data-stream.binance.vision';

const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--source=binance', `--symbols=${symbols}`, '--db=:memory:', '--port=0',
  `--endpoint=${endpoint}`, `--reconcile=${args.reconcile ?? 'flagged'}`, '--reconcile-interval-ms=5000'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
const liveEvents = []; const reconcileEvents = [];
let port = null;
const listening = new Promise((resolveListen, reject) => {
  createInterface({ input: child.stdout }).on('line', line => {
    let event; try { event = JSON.parse(line); } catch { return; }
    if (event.event === 'listening') { port = event.port; resolveListen(); }
    if (event.event === 'live') liveEvents.push({ at: new Date(event.at).toISOString(), what: event.what, reason: event.reason });
    if (event.event === 'reconcile') reconcileEvents.push({ symbol: event.symbol, open: new Date(event.openTimeMs).toISOString(), decision: event.decision, detail: event.detail });
  });
  child.once('exit', code => reject(new Error(`service exited early (${code}): ${stderr}`)));
});
try {
  await listening;
  const base = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  if (dropAfterS > 0) setTimeout(() => {
    blocked = true; relayLog.push({ at: new Date().toISOString(), event: 'drop', sockets: sockets.size });
    for (const socket of sockets) socket.destroy();
    setTimeout(() => { blocked = false; relayLog.push({ at: new Date().toISOString(), event: 'restore' }); }, dropForS * 1_000);
  }, dropAfterS * 1_000);
  // Enough full minutes after the start (and after the drop), plus grace, settle and one reconcile interval.
  const firstFull = Math.ceil((startedAt + 5_000) / 60_000) * 60_000;
  const waitUntil = Math.max(firstFull + fullMinutes * 60_000, startedAt + (dropAfterS + dropForS + 60) * 1_000) + 25_000;
  process.stderr.write(`waiting ${Math.round((waitUntil - Date.now()) / 1000)} s...\n`);
  await new Promise(r => setTimeout(r, waitUntil - Date.now()));
  const ready = await (await fetch(`${base}/readyz`)).json();
  const report = { startedAt: new Date(startedAt).toISOString(), endpoint, relayLog, readiness: ready, liveEvents, reconcileEvents, symbols: {} };
  for (const symbol of symbols.split(',')) {
    const from = Math.floor(startedAt / 60_000) * 60_000;
    const ours = await (await fetch(`${base}/v1/klines?symbol=${symbol}&from=${from}&to=${Date.now()}&limit=1000`)).json();
    const exchange = await (await fetch(`${rest}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${Date.now()}`)).json();
    const rows = ours.bars.map(bar => {
      const k = exchange.find(row => row[0] === bar.openTimeMs);
      const mine = [bar.open, bar.high, bar.low, bar.close, bar.volume, bar.quoteVolume, bar.tradeCount];
      const theirs = k ? [k[1], k[2], k[3], k[4], k[5], k[7]].map(canonical).concat([k[8]]) : null;
      const equal = JSON.stringify(mine) === JSON.stringify(theirs);
      // Comparable: closed and either reconciled against history or carrying no reason at all.
      const comparable = bar.state === 'closed' && (bar.quality.completeness === 'reconciled' || bar.quality.reasons.length === 0);
      return { open: new Date(bar.openTimeMs).toISOString(), state: bar.state, completeness: bar.quality.completeness, reasons: bar.quality.reasons,
        trades: bar.tradeCount, valueRevision: bar.valueRevision, comparable, equal, ...(equal ? {} : { ours: mine, exchange: theirs }) };
    });
    report.symbols[symbol] = { comparable: rows.filter(r => r.comparable).length, matched: rows.filter(r => r.comparable && r.equal).length,
      reconciledGapMinutes: rows.filter(r => r.completeness === 'reconciled' && r.reasons.includes('source_gap')).length, rows };
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  for (const [symbol, result] of Object.entries(report.symbols)) {
    assert.ok(result.comparable >= 1, `${symbol}: nothing comparable`);
    assert.equal(result.matched, result.comparable, `${symbol}: every reconciled or unflagged closed minute must equal the exchange kline`);
    for (const row of result.rows.filter(r => r.state === 'closed' && r.completeness === 'known_incomplete'))
      assert.equal(row.equal, false, `${symbol} ${row.open}: known_incomplete but equal to the exchange kline`);
    if (dropAfterS > 0) assert.ok(result.reconciledGapMinutes >= 1, `${symbol}: no gap minute was reconciled`);
  }
  if (dropAfterS > 0) assert.ok(liveEvents.filter(e => e.what === 'connected').length >= 2, 'the service reconnected after the drop');
  assert.equal(ready.status, 'ready');
  process.stderr.write('live check passed\n');
} finally { child.kill(); relay.close(); for (const socket of sockets) socket.destroy(); }
