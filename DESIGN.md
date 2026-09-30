# Design and assumptions

## Data flow

```text
mock fixture | seeded mock generator | optional Binance raw @trade adapter
    -> synchronous ingress stamp -> bounded immutable FIFO
    -> one coordinator/writer -> SQLite transaction (identity, bar, quality, frontier)
    -> read-only HTTP -> example consumer
```

This is deliberately one process and one writer. A small service benefits more from a precise admission contract and a credible failure demonstration than from Redis/Kafka or distributed leadership without an upstream replay protocol. Source, clock, store, aggregator and HTTP have narrow interfaces. The reducer is pure; it has no wall-clock or I/O dependency.

## Trade and bar contract

The service accepts spot trades for one or two configured symbols (BTCUSDT/ETHUSDT by default) from exactly one configured source; a store rejects any other venue, so `(symbol, minute)` is a unique bar key for readers and paging. A trade identity is `(venue, market, symbol, tradeId)`. A normalized trade has a nonnegative safe-integer UTC millisecond event time; a numeric string ID of at most 40 digits; and strictly positive plain-decimal string price and quantity with at most 18 integer and 18 fractional digits. Decimal arithmetic uses a private 96-significant-digit `decimal.js` clone. No percentage-change filter removes a legal extreme price.

Bar key: `(venue,market,symbol,floor(eventTimeMs/60000)*60000)`. The UTC minute is half-open `[open,end)`. Open and close come from the earliest/latest `(eventTimeMs, numeric tradeId)`; high/low are exact price extrema; volume is the sum of quantities; quoteVolume is the sum of price × quantity; count is accepted unique raw trades. IDs compare with `BigInt`, not string or IEEE-754 numeric order. Empty minutes do not create synthetic bars.

Ingress stamps `receivedAtMs` once before queuing; a virtual clock supplies that stamp in mock mode. A new identity is admitted only when `receivedAtMs < minuteEnd + graceMs` (default 2 seconds) and `eventTimeMs <= receivedAtMs + futureToleranceMs` (default 5 seconds). Thus an event queued at deadline minus 1 ms remains eligible even if the writer runs later; one queued exactly at deadline is late even if a timer has not closed the bar. An already accepted identical identity is a duplicate even after closure; the identity check precedes late rejection. Same identity with different normalized content is a conflict and does not overwrite the first committed fact. Invalid/future-rejected deliveries do not reserve an identity.

Trade, tick and source events share FIFO order. Only one tick may be pending and an existing tick's timestamp is never moved forward in place. The coordinator yields every 256 events. The data queue has at most 4,096 slots by default, plus finite control slots and a reserved first fault event. Saturation stops new input and becomes a visible fault. A clock-drift fault does not itself advance bar closure; the trusted queued prefix can commit before the fault. Once a fault event commits or a write fails, the coordinator halts: nothing queued behind it is committed, even by a later `drain()` such as shutdown. Mock mode uses a virtual clock; `--source=binance` uses the real monotonic-anchored clock with a 250 ms tick.

## Quality and failure meaning

`open/closed` is numeric finality, independent of quality. Every bar starts `unverified`: a socket connection cannot prove complete market capture. A known excluded legal trade, a dropped ingress message or a delivery lost to a failed write marks `known_incomplete` for the affected interval. Conflicting identities, startup partial minutes and observation gaps add reasons but do not assert a missed trade. Quality revisions may increase after numeric closure and never decrease: a disconnect and reconnect within one millisecond leaves an empty interval that names no reason but still counts toward the revision. Repeated minute-level events (for example a burst of late trades) share one quality row per reason and minute, with an occurrence count, so a burst costs one row.

## Retention, reconciliation and value revisions

**Linked history retention.** Bars and minute/source quality rows share a persisted, monotonic `historyFloorMs`, advanced by committed trusted ingress time. The default horizon is seven days (`--history-retention-ms`), at least as long as identity retention. Old bars and their minute evidence are pruned together; observation intervals intersecting retained receive windows, including empty intervals contributing to quality revision, remain. Historical and coverage queries starting before the floor return HTTP 410 with the floor, rather than presenting deleted history as observed-empty. Old deliveries and reconciliation cannot resurrect expired minutes. The quality capacity limit counts retained rows, not lifetime IDs. SQLite can reuse deleted pages but does not necessarily shrink its files. The schema version changes; old stores are refused rather than silently migrated.

**Identity retention.** Accepted identities are kept for `identityRetentionMs` (default 1 h, at least one minute plus both tolerances), then pruned together with a persisted horizon. `maxTrades` limits *retained* identities, not lifetime trades, so a live run is no longer capped at a few hours. After pruning, a duplicate and a genuinely missed trade are indistinguishable, so a delivery for a minute behind the horizon is classified `stale` (`stale_delivery`, not `known_incomplete`).

**Reconciliation.** A closed minute can be reconciled against a trusted trade history:
- Sources: Binance `GET /api/v3/aggTrades` on the market-data endpoint, or the mock scenario's truth list.
- One aggregate is one taker order's fills at one price and time, covering raw trade IDs `f..l`. It therefore rebuilds OHLC, volume, quote volume (price × total quantity) and the raw trade count exactly, with the same ordering and decimal rules as live aggregation.
- The history is accepted only if its raw IDs are contiguous and every trade falls inside the minute; the client refuses to return a truncated minute. A minute still open to live trades is refused.
- The reconcile event goes through the same FIFO and single writer as live trades.

Outcomes:
- **Equal values** confirm the bar (reason `reconciled`; values untouched).
- **Different values** replace it (reason `repaired`; `valueRevision` increases).
- **An empty history** confirms a barless minute.

Either way the bar's completeness becomes `reconciled`, unless a known loss is recorded after the reconciliation. Its reconciled raw-ID range is kept, so a later redelivery inside it is a duplicate, not a late trade.

**Revisions.** Closed values therefore change only through this explicit, provenance-carrying revision. Consumers that need immutable history can pin the first `valueRevision` of a closed bar.

**Scheduling.** The service reconciles flagged minutes every 15 s in Binance mode (`--reconcile=flagged`, the default there), or every closed minute with `--reconcile=all`. It is off by default for mock scenarios. Reconciliation is attempted only after the deadline plus a settle period, and minutes whose receive window ended before the first start are never reconciled.

The scheduler inspects the complete bounded six-hour lookback, filters cooling-down candidates, prioritizes unattempted or least-recently attempted minutes, then applies its per-run work limit. Failures retry with exponential delay from 15 seconds to five minutes, without a lifetime attempt cap; retry state is in memory and expires outside the lookback. Binance requests have a ten-second per-page deadline covering headers and body; the existing 60-page limit remains. Shutdown cancels the active request and waits before closing the store. A pathological full history request can therefore occupy a run for up to about ten minutes; the live trade writer remains independent.

Observation intervals are half-open. A gap intersects a minute's possible receive window `[minuteOpen-futureTolerance, minuteEnd+grace)` to conservatively attach `source_gap` or `recovery_gap`; this includes a disconnect just after a minute ends but before its deadline. The coverage API retains gaps without bars and applies the same receive-window rule, so a barless minute's coverage equals what its bar's reasons would be. A fresh store records `startup_partial` as the observation interval `[0, start)`: it marks every minute whose window begins before the start (including the previous minute still in its grace period and, by the future-tolerance rule, a minute starting exactly at the start) and makes "not yet running" distinguishable from an observed empty minute. Clock, capacity and writer faults are open observation intervals `[fault, ∞)` because intake stops for every symbol. A live disconnect's gap starts at the last received frame (`observedUntilMs`), not at detection. EOF never skips grace to force numeric closure: the fixture explicitly advances the virtual clock.

SQLite transactions atomically store accepted identity, updated bar, quality/control events and a commit sequence. HTTP handlers are synchronous over one process connection, so a request sees a committed snapshot without an intervening writer callback. There is no asynchronously updated in-memory OHLCV cache. A write failure rolls back its trade/bar and keeps its original cause (a `ROLLBACK` after SQLite's own automatic rollback no longer masks it). The fault is latched in memory first, so readers see `faulted` even if the disk refuses more writes, then persisted as an open `writer_fault` observation row, falling back to the meta row alone. Intake stops and previously committed history stays readable. Reopening a faulted file reports `faulted`; a store that fails initialization (e.g. a corrupt file) releases its handle.

File mode uses WAL/FULL and a same-host owner token with PID liveness, refusing a second active writer or mismatched semantic config. It recovers committed state and marks observation downtime until `connected`; clean and unclean restart use distinct gap reasons. Actual child-process termination tests cover kill before COMMIT and kill after COMMIT before the caller receives a result. This demonstrates committed-prefix atomicity and replay idempotency while identities remain retained. It does **not** demonstrate that every inbound event survives a crash. Replaying a previously uncommitted trade after its deadline is late and is tested as such.

## Optional Binance source

`src/binance-source.ts` subscribes to `<symbol>@trade` on the market-data-only combined stream. The contract follows binance-spot-api-docs `web-socket-streams.md` at 828ca74 (2026-09-18): fields `e s t p q T` (`E m M` unused); a connection lives at most 24 h; the server pings every 20 s; a `serverShutdown` event precedes closure; the limit is 300 connection attempts per 5 min per IP. The adapter:

- Parses `t` from its JSON source text, so IDs above 2^53 stay exact.
- Maps `T` to event time and `p`/`q` to decimal strings, and passes malformed trades to the store, which records them as `invalid_input` instead of dropping them.
- Fences every socket event by a generation number, so frames from a replaced socket are ignored and an error followed by close counts as one drop.
- Reconnects with jittered exponential backoff (1 s doubling to 30 s), immediately after `serverShutdown` or at 23 h 50 m age.
- Treats 60 s without any frame as a dead connection. The WHATWG WebSocket answers pings but does not expose them, so data silence is the only liveness evidence.
- Halts instead of reconnect-looping when intake refuses a delivery.

Rotation is break-before-make, so each rotation leaves a short recorded gap. Identity de-duplication makes a make-before-break overlap safe, but it was not needed for bounded runs.

## Verification strategy and trade-offs

The golden fixture has a third-party-checkable hand calculation: IDs 1/3/2 arrive in that order; event-time order yields `100/103/99/103`, volume 6, quoteVolume 600, count 3. The independent oracle reads raw delivery actions, independently applies identity and timing rules, and aggregates with `BigInt` fixed-point arithmetic (18 decimal places per input, 36 for products). It imports no production reducer or acceptance list. Fixed-seed out-of-order corpus, quantity scaling, exact boundaries, real HTTP consumption, fault injection, file restart and actual child kills test distinct seams.

The seeded generator and a 60-seed property test compare the service with the oracle bar by bar and with market truth. Every miss the service could observe must carry a reason, and no bar may claim `known_incomplete` while matching truth. The generator's edge probes make the property test alone kill five seeded mutants.

A captured 209 s BTCUSDT stream (4,651 contiguous trade IDs) replays through the real adapter. Its fully observed minutes equal Binance's own REST 1m klines on all seven fields. The results files separate observed outcomes from unrun cases.

Alternatives considered: exchange `@kline` would not meet the raw-trade requirement; pure event-time watermarks would need another lateness/completeness contract; Redis pub/sub without durable upstream acknowledgement would not make arrival lossless; a distributed bus or Web UI would add operational burden without improving the core proof. A fixed receive-time deadline is easy to reason about but depends on trusted local UTC in real mode and can exclude delayed genuine trades. The service exposes that exclusion instead of silently revising closed values.
