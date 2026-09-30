import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { barFromHistory, reduceTrade } from './aggregate.js';
import { InputError, MINUTE_MS, minuteOpen, normalizeTrade, sameTrade, validateConfig,
  type BarRow, type Completeness, type InputEvent, type PublicBar, type QualityEvent, type QualityReason,
  type ServiceConfig, type SourceState, type Trade } from './contracts.js';

export type Decision = { kind: 'accepted' | 'duplicate' | 'conflict' | 'late' | 'stale' | 'invalid' | 'future' | 'resource_limit' | 'tick' | 'source' | 'fault'
  | 'reconciled' | 'repaired'; seq: number; commitSeq: number; detail?: string };
// tradeCount = retained identities. identityHorizonMs: identities of minutes before it were pruned.
type Meta = { commitSeq: number; lastProcessedIngressAt: number; tradeCount: number; sourceState: SourceState; writerFault: string | null;
  cleanStop: boolean; sourceStoppedAt: number | null; identityHorizonMs: number; historyFloorMs: number; firstStartAt: number | null };
type QualityRow = { id: number; reason: QualityReason; symbol: string | null; scope: 'minute' | 'observation' | 'source'; startMs: number;
  endMs: number | null; knownIncomplete: number; commitSeq: number; occurrences: number; detail: string | null };
const RECONCILE_REASONS = new Set<QualityReason>(['reconciled', 'repaired']);
// A retracted gap (same-millisecond disconnect/reconnect) is kept as an empty interval: it names no reason but still
// counts toward qualityRevision, so revisions never go backwards.
const isEmptyInterval = (row: QualityRow) => row.scope === 'observation' && row.endMs !== null && row.endMs <= row.startMs;
type Owner = { pid: number; host: string; token: string };
type RuntimeFault = { reason: string; atMs: number; knownIncomplete: boolean; rowPersisted: boolean };
export type StoreHooks = { afterOpen?: (db: DatabaseSync) => void; beforeCommit?: () => void; afterCommitBeforeReply?: () => void };

const SCHEMA_VERSION = '3';
const POLICY_VERSION = 'event-time-id-v1-receive-deadline-v1-quality-v2-retention-v2-reconcile-v1';
const int = (value: unknown): number => Number(value);

export class HistoryExpiredError extends Error {
  constructor(readonly historyFloorMs: number) { super('requested history has expired'); }
}

export class SqliteStore {
  private readonly db: DatabaseSync;
  private readonly config: ServiceConfig;
  private readonly configHash: string;
  private readonly ownerToken: string | null;
  private readonly hooks: StoreHooks;
  private readonly fresh: boolean;
  private closed = false;
  private resumed = false;
  // Set before any attempt to persist a writer fault, so readers see it even if the disk refuses the latch.
  private runtimeFault: RuntimeFault | null = null;

  constructor(config: ServiceConfig, hooks: StoreHooks = {}) {
    validateConfig(config);
    this.config = config;
    this.hooks = hooks;
    this.configHash = createHash('sha256').update(JSON.stringify({
      schema: SCHEMA_VERSION, policy: POLICY_VERSION, numericContract: 'decimal18-18-precision96-id40',
      source: config.source, clockMode: config.clockMode, scenarioId: config.scenarioId,
      symbols: [...config.symbols].sort(), graceMs: config.graceMs,
      futureToleranceMs: config.futureToleranceMs, clockDriftLimitMs: config.clockDriftLimitMs,
      maxQueue: config.maxQueue, maxTrades: config.maxTrades, maxQualityEvents: config.maxQualityEvents,
      identityRetentionMs: config.identityRetentionMs, historyRetentionMs: config.historyRetentionMs,
    })).digest('hex');
    this.db = new DatabaseSync(config.dbPath);
    try {
      if (config.dbPath !== ':memory:') {
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250;');
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS trades (venue TEXT NOT NULL, market TEXT NOT NULL, symbol TEXT NOT NULL, tradeId TEXT NOT NULL, eventTimeMs INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (venue, market, symbol, tradeId));
        CREATE INDEX IF NOT EXISTS trades_time ON trades(eventTimeMs);
        CREATE TABLE IF NOT EXISTS bars (venue TEXT NOT NULL, market TEXT NOT NULL, symbol TEXT NOT NULL, openTimeMs INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (venue, market, symbol, openTimeMs));
        CREATE INDEX IF NOT EXISTS bars_symbol_time ON bars(symbol, openTimeMs);
        CREATE INDEX IF NOT EXISTS bars_state ON bars(state);
        CREATE TABLE IF NOT EXISTS quality_events (id INTEGER PRIMARY KEY AUTOINCREMENT, reason TEXT NOT NULL, symbol TEXT, scope TEXT NOT NULL, startMs INTEGER NOT NULL, endMs INTEGER, knownIncomplete INTEGER NOT NULL, commitSeq INTEGER NOT NULL, occurrences INTEGER NOT NULL DEFAULT 1, detail TEXT);
        CREATE INDEX IF NOT EXISTS quality_scope_time ON quality_events(scope, startMs);
      `);
      const previousSchema = this.readMeta('schemaVersion');
      const previousConfig = this.readMeta('configHash');
      this.fresh = !previousSchema;
      if (previousSchema && previousSchema !== SCHEMA_VERSION) throw new Error('schema version mismatch');
      if (previousConfig && previousConfig !== this.configHash) throw new Error('semantic config mismatch');
      if (!previousSchema) this.writeMeta('schemaVersion', SCHEMA_VERSION);
      if (!previousConfig) this.writeMeta('configHash', this.configHash);
      if (!this.readMeta('state')) this.writeMeta('state', JSON.stringify({ commitSeq: 0, lastProcessedIngressAt: -1, tradeCount: 0,
        sourceState: 'stopped', writerFault: null, cleanStop: false, sourceStoppedAt: null, identityHorizonMs: 0, historyFloorMs: 0, firstStartAt: null } satisfies Meta));
      this.ownerToken = config.dbPath === ':memory:' ? null : randomUUID();
      if (this.ownerToken) this.acquireOwner();
      hooks.afterOpen?.(this.db);
    } catch (error) {
      // Any initialization failure must release the handle; Windows otherwise keeps the file locked.
      try { this.db.close(); } catch { /* already closed by acquireOwner */ }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.ownerToken) this.transaction(() => {
      const meta = this.meta();
      meta.cleanStop = true;
      meta.sourceStoppedAt ??= meta.lastProcessedIngressAt;
      meta.sourceState = meta.writerFault ? 'faulted' : 'stopped';
      meta.commitSeq++;
      this.writeMeta('state', JSON.stringify(meta));
      this.writeMeta('owner', 'null');
    });
    this.db.close(); this.closed = true;
  }
  private readMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  private writeMeta(key: string, value: string): void { this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  meta(): Meta {
    const meta = JSON.parse(this.readMeta('state')!) as Meta;
    if (this.runtimeFault) { meta.writerFault ??= this.runtimeFault.reason; meta.sourceState = 'faulted'; }
    return meta;
  }

  /**
   * Stops intake after a failed write. Readers see the fault immediately; persistence is best effort because the
   * failure may be the disk itself. The open-ended observation row makes every bar still able to receive trades
   * after `atMs` carry `writer_fault`, so a lost delivery never looks like an ordinary bar.
   */
  latchWriterFault(reason: string, atMs: number, knownIncomplete: boolean): void {
    this.runtimeFault ??= { reason: reason.slice(0, 160), atMs, knownIncomplete, rowPersisted: false };
    const fault = this.runtimeFault;
    const persist = (withRow: boolean) => this.transaction(() => {
      const meta = this.meta(); const seq = meta.commitSeq + 1;
      if (withRow) this.quality('writer_fault', null, 'observation', fault.atMs, null, fault.knownIncomplete, seq, fault.reason, true);
      meta.commitSeq = seq;
      this.writeMeta('state', JSON.stringify(meta));
    });
    try { persist(true); fault.rowPersisted = true; }
    catch { try { persist(false); } catch { /* The in-memory latch remains authoritative for this process. */ } }
  }

  private transaction<T>(fn: () => T, beforeCommit?: () => void): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.ownerToken) {
        const owner = JSON.parse(this.readMeta('owner') ?? 'null') as Owner | null;
        if (owner?.token !== this.ownerToken) throw new Error('writer owner lost');
      }
      const result = fn();
      if (result && typeof result === 'object' && 'then' in result) throw new Error('async transaction callback forbidden');
      beforeCommit?.();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      // SQLite may already have rolled back (e.g. SQLITE_FULL); a failing ROLLBACK must not mask the real cause.
      try { this.db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw error;
    }
  }

  private acquireOwner(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = JSON.parse(this.readMeta('owner') ?? 'null') as Owner | null;
      if (old) {
        if (old.host !== hostname()) throw new Error('writer owner belongs to another host');
        try { process.kill(old.pid, 0); throw new Error('another writer process is alive'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      this.writeMeta('owner', JSON.stringify({ pid: process.pid, host: hostname(), token: this.ownerToken! } satisfies Owner));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }

  private findTrade(trade: Trade): Trade | null {
    const row = this.db.prepare('SELECT payload FROM trades WHERE venue=? AND market=? AND symbol=? AND tradeId=?')
      .get(trade.venue, trade.market, trade.symbol, trade.tradeId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Trade : null;
  }
  private findBar(trade: Trade): BarRow | null {
    const row = this.db.prepare('SELECT payload FROM bars WHERE venue=? AND market=? AND symbol=? AND openTimeMs=?')
      .get(trade.venue, trade.market, trade.symbol, minuteOpen(trade.eventTimeMs)) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as BarRow : null;
  }
  private saveBar(bar: BarRow): void {
    this.db.prepare(`INSERT INTO bars(venue,market,symbol,openTimeMs,state,payload) VALUES (?,?,?,?,?,?)
      ON CONFLICT(venue,market,symbol,openTimeMs) DO UPDATE SET state=excluded.state,payload=excluded.payload`)
      .run(bar.venue, bar.market, bar.symbol, bar.openTimeMs, bar.state, JSON.stringify(bar));
  }
  private quality(reason: QualityReason, symbol: string | null, scope: QualityRow['scope'], startMs: number,
    endMs: number | null, knownIncomplete: boolean, commitSeq: number, detail: string | null = null, terminal = false): void {
    // Repeated minute- or source-level events (e.g. a burst of late trades) share one row with an occurrence count,
    // so capacity is spent per minute and reason, not per delivery.
    if (scope !== 'observation') {
      const existing = this.db.prepare('SELECT id FROM quality_events WHERE scope=? AND reason=? AND startMs=? AND symbol IS ?')
        .get(scope, reason, startMs, symbol) as { id: number } | undefined;
      if (existing) {
        this.db.prepare(`UPDATE quality_events SET occurrences=occurrences+1, commitSeq=?, knownIncomplete=MAX(knownIncomplete,?),
          detail=COALESCE(?, detail) WHERE id=?`).run(commitSeq, knownIncomplete ? 1 : 0, detail?.slice(0, 160) ?? null, existing.id);
        return;
      }
    }
    // Capacity bounds retained rows; AUTOINCREMENT IDs stay monotonic after pruning.
    // A terminal fault row may exceed the cap by one.
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM quality_events').get() as { n: number };
    if (!terminal && int(count.n) >= this.config.maxQualityEvents) throw new Error('quality event capacity reached');
    this.db.prepare('INSERT INTO quality_events(reason,symbol,scope,startMs,endMs,knownIncomplete,commitSeq,detail) VALUES (?,?,?,?,?,?,?,?)')
      .run(reason, symbol, scope, startMs, endMs, knownIncomplete ? 1 : 0, commitSeq, detail?.slice(0, 160) ?? null);
  }
  /** Deletes identities of minutes older than the retention horizon; their bars are long closed. */
  private pruneIdentities(meta: Meta, at: number): void {
    const horizon = minuteOpen(at - this.config.identityRetentionMs);
    if (horizon <= meta.identityHorizonMs) return;
    const result = this.db.prepare('DELETE FROM trades WHERE eventTimeMs < ?').run(horizon);
    meta.tradeCount = Math.max(0, meta.tradeCount - int(result.changes));
    meta.identityHorizonMs = horizon;
  }
  /** Expire values and evidence together; readers must never interpret deleted evidence as clean history. */
  private pruneHistory(meta: Meta, at: number): void {
    const floor = Math.max(0, minuteOpen(at - this.config.historyRetentionMs));
    if (floor <= meta.historyFloorMs) return;
    this.db.prepare('DELETE FROM bars WHERE openTimeMs < ?').run(floor);
    this.db.prepare("DELETE FROM quality_events WHERE scope IN ('minute','source') AND startMs < ?").run(floor);
    // Keep open gaps and intervals touching any retained receive window. Strict < also keeps
    // a retracted empty gap exactly at the boundary, which still contributes to qualityRevision.
    this.db.prepare("DELETE FROM quality_events WHERE scope='observation' AND endMs IS NOT NULL AND endMs < ?")
      .run(floor - this.config.futureToleranceMs);
    meta.historyFloorMs = floor;
  }
  private requireHistory(from: number): void {
    const floor = this.meta().historyFloorMs;
    if (from < floor) throw new HistoryExpiredError(floor);
  }
  private closeDue(receivedAtMs: number, commitSeq: number): void {
    const rows = this.db.prepare('SELECT payload FROM bars WHERE state=?').all('open') as Array<{ payload: string }>;
    for (const row of rows) {
      const bar = JSON.parse(row.payload) as BarRow;
      if (receivedAtMs >= bar.endTimeMs + this.config.graceMs) this.saveBar({ ...bar, state: 'closed', valueRevision: commitSeq });
    }
  }

  process(event: InputEvent): Decision {
    const decision = this.transaction(() => {
      const meta = this.meta();
      if (meta.writerFault) throw new Error(`intake halted by latched fault: ${meta.writerFault}`);
      if (event.envelope.receivedAtMs < meta.lastProcessedIngressAt) throw new Error('ingress time moved backwards');
      const commitSeq = meta.commitSeq + 1;
      const at = event.envelope.receivedAtMs;
      let kind: Decision['kind']; let detail: string | undefined;
      if (event.kind === 'fault' && event.code === 'clock_untrusted') {
        // Observation scope: every bar that could still receive trades after `at` is affected, not just the fault.
        meta.writerFault = event.code; meta.sourceState = 'faulted';
        this.quality('clock_untrusted', null, 'observation', at, null, event.knownIncomplete, commitSeq);
        kind = 'fault';
      } else {
        this.closeDue(at, commitSeq);
        this.pruneIdentities(meta, at);
        this.pruneHistory(meta, at);
        if (event.kind === 'reconcile') {
          ({ kind, detail } = this.reconcile(event, at, commitSeq, meta.historyFloorMs));
        } else if (event.kind === 'trade') {
          let trade: Trade | null = null;
          try { trade = normalizeTrade(event.raw, this.config.symbols, this.config.source); }
          catch (error) {
            if (!(error instanceof InputError)) throw error;
            if (error.symbol && this.config.symbols.includes(error.symbol) && error.eventTimeMs !== null &&
                minuteOpen(error.eventTimeMs) >= meta.historyFloorMs) {
              const open = minuteOpen(error.eventTimeMs);
              this.quality('invalid_input', error.symbol, 'minute', open, open + MINUTE_MS, false, commitSeq, error.message);
            } else {
              const receiveMinute = minuteOpen(at); // aggregated per receive minute
              this.quality('invalid_input', null, 'source', receiveMinute, receiveMinute + MINUTE_MS, false, commitSeq, error.message);
            }
            kind = 'invalid'; detail = error.message;
          }
          if (trade) {
            const existing = this.findTrade(trade);
            const open = minuteOpen(trade.eventTimeMs);
            const reconciled = existing ? null : this.findBar(trade)?.reconciledRange ?? null;
            if (open < meta.historyFloorMs) {
              kind = 'stale'; detail = 'minute before retained history floor';
              const receiveMinute = minuteOpen(at);
              this.quality('stale_delivery', trade.symbol, 'source', receiveMinute, receiveMinute + MINUTE_MS, false, commitSeq, detail);
            } else if (existing) {
              if (sameTrade(existing, trade)) kind = 'duplicate';
              else {
                this.quality('conflicting_identity', trade.symbol, 'minute', open, open + MINUTE_MS, false, commitSeq);
                kind = 'conflict';
              }
            } else if (reconciled && BigInt(trade.tradeId) >= BigInt(reconciled.firstTradeId) && BigInt(trade.tradeId) <= BigInt(reconciled.lastTradeId)) {
              kind = 'duplicate'; detail = 'covered by reconciled history';
            } else if (open < meta.identityHorizonMs) {
              // Its identity may have been pruned: a duplicate and a genuinely missed trade are indistinguishable.
              kind = 'stale';
              this.quality('stale_delivery', trade.symbol, 'minute', open, open + MINUTE_MS, false, commitSeq);
            } else if (trade.eventTimeMs > at + this.config.futureToleranceMs) {
              kind = 'future'; detail = 'event time beyond receive-time tolerance';
              this.quality('invalid_input', trade.symbol, 'minute', open, open + MINUTE_MS, false, commitSeq, detail);
            } else if (at >= open + MINUTE_MS + this.config.graceMs) {
              kind = 'late';
              this.quality('late_rejected', trade.symbol, 'minute', open, open + MINUTE_MS, true, commitSeq);
            } else if (meta.tradeCount >= this.config.maxTrades) {
              // Intake stops for every symbol, so the rejected trade's minute and all later windows are incomplete.
              kind = 'resource_limit'; meta.writerFault = 'resource_limit'; meta.sourceState = 'faulted';
              this.quality('resource_limit', null, 'observation', at, null, true, commitSeq);
            } else {
              const prior = this.findBar(trade);
              if (prior?.state === 'closed') throw new Error('eligible trade found closed bar');
              const next = reduceTrade(prior, trade);
              next.valueRevision = commitSeq;
              this.db.prepare('INSERT INTO trades(venue,market,symbol,tradeId,eventTimeMs,payload) VALUES (?,?,?,?,?,?)')
                .run(trade.venue, trade.market, trade.symbol, trade.tradeId, trade.eventTimeMs, JSON.stringify(trade));
              this.saveBar(next); meta.tradeCount++; kind = 'accepted';
            }
          }
        } else if (event.kind === 'source') {
          if (event.state === 'disconnected' || event.state === 'stopped') {
            if (meta.sourceState === 'connected')
              this.quality('source_gap', null, 'observation', Math.min(at, event.observedUntilMs ?? at), null, false, commitSeq);
          } else if (event.state === 'connected') {
            // A gap closed in the millisecond it opened becomes an empty interval (see isEmptyInterval), not a deletion.
            this.db.prepare("UPDATE quality_events SET endMs=?,commitSeq=? WHERE scope='observation' AND reason IN ('source_gap','recovery_gap') AND endMs IS NULL")
              .run(at, commitSeq);
          }
          meta.sourceState = event.state; kind = 'source';
          // A later clean stop must measure downtime from the latest stop, not one that preceded a reconnect.
          if (event.state === 'stopped') meta.sourceStoppedAt = at;
          else if (event.state === 'connected') meta.sourceStoppedAt = null;
        } else if (event.kind === 'fault') {
          meta.writerFault = event.code; meta.sourceState = 'faulted';
          this.quality('overflow', null, 'observation', at, null, event.knownIncomplete, commitSeq);
          kind = 'fault';
        } else kind = 'tick';
      }
      meta.commitSeq = commitSeq; meta.lastProcessedIngressAt = at;
      this.writeMeta('state', JSON.stringify(meta));
      return { kind: kind!, seq: event.envelope.seq, commitSeq, detail };
    }, this.hooks.beforeCommit);
    this.hooks.afterCommitBeforeReply?.();
    return decision;
  }

  resume(at: number): void {
    if (this.resumed) throw new Error('store already resumed by a coordinator');
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('invalid resume time');
    const meta = this.meta();
    if (at < meta.lastProcessedIngressAt) throw new Error('restart clock before persisted frontier');
    this.transaction(() => {
      const current = this.meta(); const seq = current.commitSeq + 1;
      if (!current.writerFault) {
        this.closeDue(at, seq);
        this.pruneIdentities(current, at);
        this.pruneHistory(current, at);
      }
      if (this.fresh) {
        // Nothing before `at` was observed. As an observation interval [0, at) it marks every minute whose receive
        // window starts before `at` (including the previous minute still in its grace period) and lets coverage
        // distinguish "not yet running" from an observed empty minute.
        this.quality('startup_partial', null, 'observation', 0, at, false, seq);
        this.quality('source_gap', null, 'observation', at, null, false, seq);
        current.firstStartAt = at;
      } else if (!current.writerFault) {
        // A latched fault already covers unavailable observation and keeps intake closed.
        // Allocating a normal recovery row could prevent read-only reopening at the cap.
        const gapStart = current.cleanStop ? (current.sourceStoppedAt ?? current.lastProcessedIngressAt) : current.lastProcessedIngressAt;
        this.quality(current.cleanStop ? 'source_gap' : 'recovery_gap', null, 'observation', Math.max(0, gapStart), null, false, seq);
      }
      current.commitSeq = seq; current.lastProcessedIngressAt = at; current.cleanStop = false;
      current.sourceState = current.writerFault ? 'faulted' : 'stopped';
      this.writeMeta('state', JSON.stringify(current));
    });
    this.resumed = true;
  }


  /**
   * Applies a closed minute's complete trade history. Equal values confirm the bar ('reconciled'); different values
   * replace it with an explicit value revision ('repaired'). Only minutes past their deadline can be reconciled.
   */
  private reconcile(event: Extract<InputEvent, { kind: 'reconcile' }>, at: number, commitSeq: number, historyFloorMs: number): { kind: Decision['kind']; detail?: string } {
    const { symbol, openTimeMs } = event;
    const invalid = (message: string) => {
      const receiveMinute = minuteOpen(at);
      this.quality('invalid_input', null, 'source', receiveMinute, receiveMinute + MINUTE_MS, false, commitSeq, `reconcile: ${message}`);
      return { kind: 'invalid' as const, detail: message };
    };
    if (!this.config.symbols.includes(symbol) || !Number.isSafeInteger(openTimeMs) || openTimeMs % MINUTE_MS !== 0) return invalid('unknown symbol or unaligned minute');
    if (openTimeMs < historyFloorMs) return invalid('minute before retained history floor');
    if (at < this.receiveWindow(openTimeMs).end) return invalid('minute still open to live trades');
    let history: BarRow | null;
    try { history = barFromHistory(this.config.source, symbol, openTimeMs, event.aggregates); }
    catch (error) { if (error instanceof InputError) return invalid(error.message); throw error; }
    const row = this.db.prepare('SELECT payload FROM bars WHERE venue=? AND market=? AND symbol=? AND openTimeMs=?')
      .get(this.config.source, 'spot', symbol, openTimeMs) as { payload: string } | undefined;
    const prior = row ? JSON.parse(row.payload) as BarRow : null;
    const provenance = event.provenance.slice(0, 80);
    if (!history && !prior) {
      this.quality('reconciled', symbol, 'minute', openTimeMs, openTimeMs + MINUTE_MS, false, commitSeq, `${provenance}: no trades`);
      return { kind: 'reconciled' };
    }
    if (!history) {
      this.quality('conflicting_identity', symbol, 'minute', openTimeMs, openTimeMs + MINUTE_MS, false, commitSeq, `${provenance}: history has no trades`);
      return { kind: 'invalid', detail: 'history has no trades for an existing bar' };
    }
    const range = { firstTradeId: history.firstTradeId, lastTradeId: history.lastTradeId };
    const values = (bar: BarRow) => [bar.open, bar.high, bar.low, bar.close, bar.volume, bar.quoteVolume, bar.tradeCount].join('|');
    if (prior && values(prior) === values(history)) {
      this.saveBar({ ...prior, state: 'closed', reconciledRange: range });
      this.quality('reconciled', symbol, 'minute', openTimeMs, openTimeMs + MINUTE_MS, false, commitSeq, `${provenance}: ${history.tradeCount} trades`);
      return { kind: 'reconciled' };
    }
    this.saveBar({ ...history, state: 'closed', valueRevision: commitSeq, reconciledRange: range });
    this.quality('repaired', symbol, 'minute', openTimeMs, openTimeMs + MINUTE_MS, false, commitSeq,
      `${provenance}: ${prior?.tradeCount ?? 0} -> ${history.tradeCount} trades`);
    return { kind: 'repaired', detail: `${prior?.tradeCount ?? 0} -> ${history.tradeCount} trades` };
  }

  /**
   * Minutes a history source may reconcile now: past deadline + settleMs, not before the first start, not yet
   * reconciled, and, for policy 'flagged', affected by at least one quality reason. Oldest first.
   */
  reconcileCandidates(policy: 'flagged' | 'all', nowMs: number, settleMs: number, lookbackMs: number, limit: number): Array<{ symbol: string; openTimeMs: number }> {
    const meta = this.meta();
    if (meta.firstStartAt === null || meta.writerFault) return [];
    const latest = minuteOpen(nowMs - settleMs - this.config.graceMs) - MINUTE_MS;
    // The minute before the first start can still hold in-grace trades; earlier minutes were never observed.
    const earliest = Math.max(meta.historyFloorMs, minuteOpen(meta.firstStartAt) - MINUTE_MS, minuteOpen(nowMs - lookbackMs));
    const out: Array<{ symbol: string; openTimeMs: number }> = [];
    if (latest < earliest) return out;
    for (const symbol of this.config.symbols) {
      const done = new Set((this.db.prepare(`SELECT startMs FROM quality_events WHERE scope='minute' AND symbol=?
        AND reason IN ('reconciled','repaired') AND startMs>=? AND startMs<=?`).all(symbol, earliest, latest) as Array<{ startMs: number }>)
        .map(row => int(row.startMs)));
      const rows = this.qualityRowsFor(symbol, this.receiveWindow(earliest).start, this.receiveWindow(latest).end);
      for (let open = earliest; open <= latest && out.length < limit; open += MINUTE_MS) {
        if (done.has(open) || this.receiveWindow(open).end <= meta.firstStartAt) continue; // never observable
        if (policy === 'all' || rows.some(row => this.relation(row, symbol, open) === 'reason')) out.push({ symbol, openTimeMs: open });
      }
    }
    return out.sort((a, b) => a.openTimeMs - b.openTimeMs).slice(0, limit);
  }

  /** Quality rows that can affect minutes whose receive windows intersect [windowStart, windowEnd), by index. */
  private qualityRowsFor(symbol: string, windowStart: number, windowEnd: number): QualityRow[] {
    const pointRows = this.db.prepare(`SELECT * FROM quality_events WHERE scope IN ('minute','source') AND startMs>=? AND startMs<?
      AND (symbol IS NULL OR symbol=?)`).all(windowStart - MINUTE_MS, windowEnd, symbol) as unknown as QualityRow[];
    const intervalRows = this.db.prepare(`SELECT * FROM quality_events WHERE scope='observation' AND startMs<?
      AND (endMs IS NULL OR endMs>=?) AND (symbol IS NULL OR symbol=?)`).all(windowEnd, windowStart, symbol) as unknown as QualityRow[];
    const rows = [...pointRows, ...intervalRows].sort((a, b) => a.id - b.id);
    const fault = this.runtimeFault;
    if (fault && !fault.rowPersisted) {
      const lastId = (this.db.prepare("SELECT seq AS n FROM sqlite_sequence WHERE name='quality_events'").get() as { n: number } | undefined)?.n ?? 0;
      rows.push({ id: int(lastId) + 1, reason: 'writer_fault', symbol: null, scope: 'observation', startMs: fault.atMs, endMs: null,
        knownIncomplete: fault.knownIncomplete ? 1 : 0, commitSeq: this.meta().commitSeq + 1, occurrences: 1,
        detail: `${fault.reason} (not persisted)`.slice(0, 160) });
    }
    return rows;
  }
  /** Receive times at which a trade of this minute could be admitted: [open - futureTolerance, end + grace). */
  private receiveWindow(openTimeMs: number): { start: number; end: number } {
    return { start: openTimeMs - this.config.futureToleranceMs, end: openTimeMs + MINUTE_MS + this.config.graceMs };
  }
  /** 'reason': the row applies to the minute. 'revision': a retracted empty gap inside its window (revision only). */
  private relation(row: QualityRow, symbol: string, openTimeMs: number): 'reason' | 'revision' | null {
    if (row.symbol && row.symbol !== symbol) return null;
    if (row.scope === 'minute') return row.startMs === openTimeMs ? 'reason' : null;
    if (row.scope === 'source') return null;
    const window = this.receiveWindow(openTimeMs);
    if (isEmptyInterval(row)) return row.startMs >= window.start && row.startMs < window.end ? 'revision' : null;
    return row.startMs < window.end && (row.endMs === null || row.endMs > window.start) ? 'reason' : null;
  }
  private publicBar(bar: BarRow, quality: QualityRow[]): PublicBar {
    const related = quality.filter(row => this.relation(row, bar.symbol, bar.openTimeMs) !== null);
    const reasonRows = related.filter(row => this.relation(row, bar.symbol, bar.openTimeMs) === 'reason');
    const reconciledAt = reasonRows.filter(row => RECONCILE_REASONS.has(row.reason)).reduce((max, row) => Math.max(max, int(row.commitSeq)), 0);
    // A reconciliation supersedes earlier known gaps; a known loss recorded after it still counts.
    const knownLossAfter = reasonRows.some(row => row.knownIncomplete && int(row.commitSeq) > reconciledAt);
    const completeness: Completeness = knownLossAfter ? 'known_incomplete' : reconciledAt ? 'reconciled' : 'unverified';
    const { firstTimeMs: _a, firstTradeId: _b, lastTimeMs: _c, lastTradeId: _d, reconciledRange: _e, ...visible } = bar;
    return { ...visible, quality: {
      completeness,
      reasons: [...new Set(reasonRows.map(row => row.reason))].sort(),
      qualityRevision: related.reduce((max, row) => Math.max(max, int(row.commitSeq)), 0),
    } };
  }
  private publicBars(symbol: string, rows: Array<{ payload: string }>): PublicBar[] {
    const bars = rows.map(row => JSON.parse(row.payload) as BarRow);
    if (!bars.length) return [];
    const opens = bars.map(bar => bar.openTimeMs);
    const quality = this.qualityRowsFor(symbol, this.receiveWindow(Math.min(...opens)).start, this.receiveWindow(Math.max(...opens)).end);
    return bars.map(bar => this.publicBar(bar, quality));
  }
  bars(symbol: string, from: number, to: number, limit: number): { bars: PublicBar[]; nextFrom: number | null; asOfCommitSeq: number; sourceState: SourceState; historyFloorMs: number } {
    this.requireHistory(from);
    const rows = this.db.prepare('SELECT payload FROM bars WHERE symbol=? AND openTimeMs>=? AND openTimeMs<? ORDER BY openTimeMs LIMIT ?')
      .all(symbol, from, to, limit + 1) as Array<{ payload: string }>;
    const more = rows.length > limit;
    const selected = this.publicBars(symbol, rows.slice(0, limit));
    const meta = this.meta();
    return { bars: selected, nextFrom: more ? (selected.at(-1)!.openTimeMs + MINUTE_MS) : null, asOfCommitSeq: meta.commitSeq, sourceState: meta.sourceState, historyFloorMs: meta.historyFloorMs };
  }
  current(symbol: string): { bars: PublicBar[]; asOfCommitSeq: number; sourceState: SourceState; historyFloorMs: number } {
    const rows = this.db.prepare("SELECT payload FROM bars WHERE symbol=? AND state='open' ORDER BY openTimeMs")
      .all(symbol) as Array<{ payload: string }>;
    const meta = this.meta();
    return { bars: this.publicBars(symbol, rows), asOfCommitSeq: meta.commitSeq, sourceState: meta.sourceState, historyFloorMs: meta.historyFloorMs };
  }
  coverage(symbol: string, from: number, to: number, limit: number, cursor = 0): { events: QualityEvent[]; nextCursor: number | null; asOfCommitSeq: number; sourceState: SourceState; historyFloorMs: number } {
    this.requireHistory(from);
    // Events that affect any minute opening in [from,to): the same receive-window rule as bar quality, so a
    // barless minute's coverage and an existing bar's reasons agree. Retracted empty gaps are not events.
    const firstOpen = Math.ceil(from / MINUTE_MS) * MINUTE_MS, lastOpen = minuteOpen(to - 1);
    const windowStart = this.receiveWindow(firstOpen).start, windowEnd = this.receiveWindow(lastOpen).end;
    const rows = firstOpen > lastOpen ? [] : this.qualityRowsFor(symbol, windowStart, windowEnd).filter(row => row.id > cursor &&
      (row.scope === 'minute' || row.scope === 'source' ? row.startMs >= from && row.startMs < to
        : !isEmptyInterval(row) && row.startMs < windowEnd && (row.endMs === null || row.endMs > windowStart)));
    const more = rows.length > limit;
    const selected = rows.slice(0, limit).map(row => ({ id: row.id, reason: row.reason, symbol: row.symbol, startMs: row.startMs,
      endMs: row.endMs, knownIncomplete: Boolean(row.knownIncomplete), commitSeq: row.commitSeq, occurrences: int(row.occurrences), detail: row.detail }));
    const meta = this.meta();
    return { events: selected, nextCursor: more ? selected.at(-1)!.id : null, asOfCommitSeq: meta.commitSeq, sourceState: meta.sourceState, historyFloorMs: meta.historyFloorMs };
  }
}
