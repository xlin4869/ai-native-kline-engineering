import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Coordinator } from './coordinator.js';
import { HistoryExpiredError } from './sqlite-store.js';

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}
function safeInt(value: string | null, label: string): number {
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${label} must be a nonnegative integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} must be a safe integer`);
  return number;
}
function query(req: IncomingMessage, coordinator: Coordinator, current = false) {
  if (!req.url || Buffer.byteLength(req.url) > 2_048) throw new Error('URL too long');
  const url = new URL(req.url, 'http://localhost');
  const symbol = url.searchParams.get('symbol');
  if (!symbol || !coordinator.config.symbols.includes(symbol)) throw new Error('unknown or missing symbol');
  if (current) return { url, symbol, from: 0, to: 0, limit: 100 };
  const from = safeInt(url.searchParams.get('from'), 'from');
  const to = safeInt(url.searchParams.get('to'), 'to');
  if (from >= to || to - from > 86_400_000) throw new Error('query range must be positive and at most 24h');
  const limit = url.searchParams.has('limit') ? safeInt(url.searchParams.get('limit'), 'limit') : 100;
  if (limit < 1 || limit > 1_000) throw new Error('limit must be 1..1000');
  return { url, symbol, from, to, limit };
}

export function createHttpApi(coordinator: Coordinator): Server {
  const server = createServer((req, res) => {
    try {
      if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
      if (!req.url || Buffer.byteLength(req.url) > 2_048) return send(res, 400, { error: 'invalid_request', detail: 'URL too long' });
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/healthz') return send(res, 200, { status: 'alive' });
      if (path === '/readyz') {
        const meta = coordinator.store.meta();
        const staleQueue = coordinator.oldestQueuedAt !== null && coordinator.clock.now() - coordinator.oldestQueuedAt > 5_000;
        const fault = coordinator.writerFault ?? (staleQueue ? 'queue_stalled' : null);
        const status = fault ? 'degraded' : meta.sourceState === 'connected' ? 'ready' : meta.sourceState === 'stopped' ? 'stopped' : 'degraded';
        return send(res, status === 'ready' ? 200 : 503,
          { status, reason: fault ?? (status === 'ready' ? null : meta.sourceState), queueDepth: coordinator.queueDepth,
            oldestQueuedAt: coordinator.oldestQueuedAt, asOfCommitSeq: meta.commitSeq });
      }
      if (path === '/v1/klines/current') {
        const q = query(req, coordinator, true);
        return send(res, 200, coordinator.store.current(q.symbol));
      }
      if (path === '/v1/klines') {
        const q = query(req, coordinator);
        return send(res, 200, coordinator.store.bars(q.symbol, q.from, q.to, q.limit));
      }
      if (path === '/v1/coverage') {
        const q = query(req, coordinator);
        const cursor = q.url.searchParams.has('cursor') ? safeInt(q.url.searchParams.get('cursor'), 'cursor') : 0;
        return send(res, 200, coordinator.store.coverage(q.symbol, q.from, q.to, q.limit, cursor));
      }
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof HistoryExpiredError)
        return send(res, 410, { error: 'history_expired', historyFloorMs: error.historyFloorMs });
      if (error instanceof Error && (/must be|unknown|missing|too long|query range|limit/.test(error.message)))
        return send(res, 400, { error: 'invalid_request', detail: error.message });
      return send(res, 500, { error: 'internal_error' });
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 2_000;
  server.maxConnections = 32;
  server.on('connection', socket => { socket.setTimeout(5_000, () => socket.destroy()); });
  return server;
}
