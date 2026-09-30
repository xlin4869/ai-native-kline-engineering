import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import test from 'node:test';
import { VirtualClock } from '../src/clock.js';
import { Coordinator } from '../src/coordinator.js';
import { DEFAULT_CONFIG } from '../src/contracts.js';
import { createHttpApi } from '../src/http.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { M, harness, trade } from './support.js';

test('real HTTP exposes committed current, closed, late quality, and coverage', async () => {
  const h = harness();
  const server = createHttpApi(h.coordinator);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const get = async (path: string) => { const response = await fetch(base + path); return { status: response.status, body: await response.json() }; };
  try {
    h.coordinator.enqueueSource('connected', M);
    h.coordinator.enqueueTrade(trade('1', 3_000, '100', '2'), M + 3_100);
    await h.coordinator.drain();
    const current = await get('/v1/klines/current?symbol=BTCUSDT');
    assert.equal(current.status, 200);
    assert.equal(current.body.bars[0].state, 'open');
    assert.equal(current.body.bars[0].volume, '2');
    h.coordinator.enqueueTrade(trade('3', 48_000, '103', '1'), M + 48_100);
    h.coordinator.enqueueTrade(trade('2', 22_000, '99', '3'), M + 48_200);
    h.coordinator.enqueueTick(M + 62_000); await h.coordinator.drain();
    const historical = await get(`/v1/klines?symbol=BTCUSDT&from=${M}&to=${M + 60_000}`);
    const bar = historical.body.bars[0];
    assert.deepEqual([bar.open, bar.high, bar.low, bar.close, bar.volume, bar.quoteVolume, bar.tradeCount, bar.state],
      ['100', '103', '99', '103', '6', '600', 3, 'closed']);
    h.coordinator.enqueueTrade(trade('4', 59_900, '110'), M + 62_001); await h.coordinator.drain();
    const after = await get(`/v1/klines?symbol=BTCUSDT&from=${M}&to=${M + 60_000}`);
    assert.equal(after.body.bars[0].close, '103');
    assert.equal(after.body.bars[0].quality.completeness, 'known_incomplete');
    assert.ok(after.body.bars[0].quality.qualityRevision > bar.quality.qualityRevision);
    const coverage = (await get(`/v1/coverage?symbol=BTCUSDT&from=${M}&to=${M + 60_000}`)).body.events;
    assert.deepEqual(coverage.map((x: { reason: string }) => x.reason), ['startup_partial', 'late_rejected']);
  } finally { server.close(); h.close(); }
});

test('transaction failure keeps committed HTTP bar and readiness reports writer failure', async () => {
  const config = { ...DEFAULT_CONFIG };
  let calls = 0;
  const store = new SqliteStore(config, { beforeCommit: () => { if (++calls === 3) throw new Error('injected write failure'); } });
  const coordinator = new Coordinator(store, new VirtualClock(M), config);
  const server = createHttpApi(coordinator); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    coordinator.enqueueSource('connected', M);
    coordinator.enqueueTrade(trade('1', 1_000, '100', '2'), M + 1_100);
    await coordinator.drain();
    coordinator.enqueueTrade(trade('2', 2_000, '200', '3'), M + 2_100);
    await coordinator.drain();
    assert.match(coordinator.writerFault ?? '', /injected write failure/);
    const bar = await (await fetch(`${base}/v1/klines/current?symbol=BTCUSDT`)).json();
    assert.deepEqual([bar.bars[0].high, bar.bars[0].volume, bar.bars[0].tradeCount], ['100', '2', 1]);
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 503);
    assert.match((await ready.json()).reason, /writer_error/);
  } finally { server.close(); store.close(); }
});

test('HTTP validates query, distinguishes empty data and readiness', async () => {
  const h = harness(); const server = createHttpApi(h.coordinator);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal((await fetch(`${base}/v1/klines?symbol=BAD&from=${M}&to=${M + 60_000}`)).status, 400);
    assert.equal((await fetch(`${base}/v1/klines?symbol=BTCUSDT&from=${M}&to=${M}`)).status, 400);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
    assert.equal((await fetch(`${base}/v1/klines`, { method: 'POST' })).status, 405);
    const body = await (await fetch(`${base}/v1/klines?symbol=BTCUSDT&from=${M}&to=${M + 60_000}`)).json();
    assert.deepEqual(body.bars, []);
  } finally { server.close(); h.close(); }
});

test('current endpoint returns overlapping grace-period and current-minute bars', async () => {
  const h = harness(); const server = createHttpApi(h.coordinator);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    h.coordinator.enqueueSource('connected', M);
    h.coordinator.enqueueTrade(trade('1', 59_900), M + 59_901);
    h.coordinator.enqueueTrade(trade('2', 60_000), M + 60_100);
    await h.coordinator.drain();
    const current = await (await fetch(`${base}/v1/klines/current?symbol=BTCUSDT`)).json();
    assert.deepEqual(current.bars.map((bar: { openTimeMs: number }) => bar.openTimeMs), [M, M + 60_000]);
    assert.ok(current.bars.every((bar: { state: string }) => bar.state === 'open'));
    const pageOne = await (await fetch(`${base}/v1/klines?symbol=BTCUSDT&from=${M}&to=${M + 120_000}&limit=1`)).json();
    assert.equal(pageOne.bars.length, 1);
    assert.equal(pageOne.nextFrom, M + 60_000);
    const pageTwo = await (await fetch(`${base}/v1/klines?symbol=BTCUSDT&from=${pageOne.nextFrom}&to=${M + 120_000}&limit=1`)).json();
    assert.equal(pageTwo.bars[0].openTimeMs, M + 60_000);
    assert.equal(pageTwo.nextFrom, null);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  } finally { server.close(); h.close(); }
});

test('coverage cursor pages stable event IDs and rejects invalid cursor', async () => {
  const h = harness(); const server = createHttpApi(h.coordinator);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    h.coordinator.enqueueSource('connected', M);
    h.coordinator.enqueueTrade({ ...trade('1', 61_000), price: 'bad' }, M + 61_100);
    h.coordinator.enqueueTrade({ ...trade('2', 121_000), price: 'bad' }, M + 121_100); // next minute: its own row
    await h.coordinator.drain();
    // Query the minutes after the startup minutes so exactly the two invalid-input events are paged.
    const path = `/v1/coverage?symbol=BTCUSDT&from=${M + 60_000}&to=${M + 180_000}&limit=1`;
    const first = await (await fetch(base + path)).json();
    assert.equal(first.events.length, 1);
    assert.ok(first.nextCursor > 0);
    const second = await (await fetch(`${base}${path}&cursor=${first.nextCursor}`)).json();
    assert.equal(second.events.length, 1);
    assert.ok(second.events[0].id > first.events[0].id);
    assert.equal(second.nextCursor, null);
    assert.equal((await fetch(`${base}${path}&cursor=bad`)).status, 400);
  } finally { server.close(); h.close(); }
});

test('HTTP rejects oversized URL and readiness detects stalled queue, not idle source', async () => {
  const h = harness(); const server = createHttpApi(h.coordinator);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    h.coordinator.enqueueSource('connected', M); await h.coordinator.drain();
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    assert.equal((await fetch(`${base}/v1/klines?${'x'.repeat(2_100)}`)).status, 400);
    assert.equal(server.maxConnections, 32);
    h.coordinator.enqueueTrade(trade('1', 1_000), M + 1_100);
    h.clock.advanceTo(M + 7_000);
    const stalled = await fetch(`${base}/readyz`);
    assert.equal(stalled.status, 503);
    assert.equal((await stalled.json()).reason, 'queue_stalled');
    await h.coordinator.drain();
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  } finally { server.close(); h.close(); }
});

test('idle incomplete HTTP request times out and connection cap drops excess socket', async () => {
  const h = harness(); const server = createHttpApi(h.coordinator);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0;
  const sockets: Socket[] = [];
  const connected = async () => {
    const socket = connect(port, '127.0.0.1'); sockets.push(socket);
    await once(socket, 'connect'); return socket;
  };
  const closesWithin = (socket: Socket, ms: number) => new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    socket.once('close', () => { clearTimeout(timer); resolve(true); });
    socket.once('error', () => { /* close follows on socket errors */ });
  });
  try {
    const slow = await connected();
    slow.write('GET /v1/klines HTTP/1.1\r\nHost: localhost\r\n');
    assert.equal(await closesWithin(slow, 8_000), true, 'incomplete headers should not hold a socket indefinitely');
    assert.equal(server.maxConnections, 32);
    server.maxConnections = 4; // Exercise the same cap with fewer test sockets.
    const held = await Promise.all([connected(), connected(), connected(), connected()]);
    const excess = await connected();
    assert.equal(await closesWithin(excess, 3_000), true, 'excess connection should be dropped');
    held.forEach(socket => socket.destroy());
  } finally { sockets.forEach(socket => socket.destroy()); server.close(); h.close(); }
});
