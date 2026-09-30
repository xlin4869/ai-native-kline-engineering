# AI Native Kline Engineering Portfolio

This small, mock-first market-data service constructs one-minute UTC klines from individual executed trades. It serves committed current and historical bars, plus separately queryable observation gaps and quality reasons. The default run needs no exchange account, VPN, Docker, Redis or network. An optional Binance Spot raw-trade source exists for bounded live use; it is not needed to evaluate the service and gives no correctness guarantee the mock tests do not already give.

This repository presents a runnable trade-to-kline market-data service and the engineering evidence behind it. The service constructs one-minute UTC klines from trades, exposes read-only HTTP endpoints, and makes uncertainty explicit through quality markers and reconciliation. It is a personal engineering case study, not a production trading service.

- [Download the project ZIP](artifacts/trade-kline-service-ai-native-showcase-curated.zip)
- [Read the AI Native Engineering Practices PDF](docs/AI_Native_Engineering_Practices.pdf)
- [Review the implementation and test report](REPORT.md)
- [Read the design and AI-assisted engineering case study](AI_NATIVE_CASE_STUDY.md)

The ZIP includes a readable **edited** AI-history excerpt. Its index identifies the omitted late-stage report and submission messages. The source and technical verification files below match that ZIP; this repository README and the PDF are additional portfolio materials.
## Quick evaluation

For a concise account of the implementation and checks, read [REPORT.md](REPORT.md). The [original assignment](ASSIGNMENT.md) and [AI-assisted engineering case study](AI_NATIVE_CASE_STUDY.md) connect the requested behavior to the design decisions, review corrections and reproducible evidence. The [AI history index](AI_HISTORY/INDEX.md) explains transcript coverage and redactions.

Use Node.js **22.16.0** and npm **10.9.2** (the versions used for verification). `node:sqlite` is experimental in this Node release. From this project directory:

```text
npm ci
npm run typecheck
npm test
npm run demo
```

`npm test` runs every suite without network access:

- unit, HTTP, and file recovery with real child-process kills;
- the review regressions and the retention/reconciliation tests;
- two generated-scenario property tests (numeric and quality contracts over 60 seeds; reconciliation restoring market truth over 30 seeds);
- replays of a captured Binance stream, one of them with an injected disconnect.

`npm test -- --suite=core|api|recovery|review|property|binance|hardening|retention` runs one suite. The real-ENOSPC test runs only when `TKS_ENOSPC_DIR` points at a small dedicated filesystem (for example a 1 MB tmpfs in a Linux container); otherwise it is reported as skipped.

The demo starts the real HTTP process twice on random localhost ports:

1. It streams the golden fixture and checks the HTTP result against a hand-calculated constant. Expected: `O=100 H=103 L=99 C=103 volume=6 quoteVolume=600 tradeCount=3`, `closed`, no quality reasons.
2. It serves a seeded generated scenario. The example consumer reads it two bars per page, following `nextFrom`/`nextCursor`, and the result must equal one unpaged read.

To inspect the service interactively in one terminal:

```text
npm start -- --source=mock --scenario=fixtures/golden.json --db=:memory: --port=3000
```

In another terminal:

```text
npm run consume -- --base-url=http://127.0.0.1:3000 --symbol=BTCUSDT
```

The golden bars use minute `2026-01-01T12:00:00.000Z` (`1767268800000` ms). Example URLs:

```text
http://127.0.0.1:3000/v1/klines?symbol=BTCUSDT&from=1767268800000&to=1767268860000
http://127.0.0.1:3000/v1/klines/current?symbol=BTCUSDT
http://127.0.0.1:3000/v1/coverage?symbol=BTCUSDT&from=1767268800000&to=1767268920000
http://127.0.0.1:3000/readyz
```

## Mock supplier

- **Hand fixtures.**
  - `fixtures/golden.json` separates the truth list from its arrival schedule.
  - `fixtures/gaps.json` shows a mid-minute start and a disconnect in the previous minute's two-second grace period.
  - `fixtures/missing-trade.json` keeps a trade in the truth list but omits its delivery during a disconnect.
- **Generated scenarios** (`--generate-seed=N [--generate-minutes=5]`, `src/mock-generator.ts`).
  - Normal activity: Poisson-like arrivals, same-millisecond bursts and a random-walk price for BTCUSDT and ETHUSDT, starting two minutes before the service does.
  - Faults: disconnects, silent loss, late and clock-skewed delivery, equivalent-decimal duplicates and conflicting twins.
  - Deterministic edge probes:
    - a same-millisecond pair at a minute's close whose trade IDs cross from 10 to 11 digits;
    - arrivals at the deadline − 1 ms and exactly at the deadline;
    - a disconnect lying only inside a grace period.

  Every true trade's planned receive attempts are kept, so tests can tell a loss the service could observe from a silent one.

Source actions, event time, receive time and explicit advances are deterministic; a mock scenario fixes its own virtual time domain.

## What the endpoints mean

- `GET /v1/klines?symbol=...&from=...&to=...&limit=100` returns bars whose **open time** is in `[from,to)`, ascending, at most 1,000 per page. `nextFrom` is returned when more bars exist.
- `GET /v1/klines/current?symbol=...` returns every still-open bar. Two open minutes can overlap during the grace period.
- `GET /v1/coverage?symbol=...&from=...&to=...&limit=100&cursor=...` returns the quality and observation events that affect any minute opening in `[from,to)`. It uses the same receive-window rule as a bar's `quality.reasons`, so it also answers for minutes that have no bar. `nextCursor` pages by event ID. An observation interval whose `startMs` is `0` means "since before the service first started".
- `GET /healthz` means the HTTP process responds. `GET /readyz` reports source/writer/clock readiness. A finished mock scenario reports `stopped` (503) while historical reads remain available.

Each response includes `asOfCommitSeq` where relevant. A single request is read synchronously from committed SQLite state; separate requests may observe different commits.

History is retained for seven days by default. Bar and coverage responses expose `historyFloorMs`; a query beginning before that persisted floor returns HTTP 410 `history_expired`. Expired minutes are unavailable, not observed-empty. Bars and their quality evidence expire together. Use a fresh database for the new schema; older files are rejected rather than migrated.

- `closed` freezes numeric OHLCV, **not** market completeness.
- `unverified` is the normal quality state even when connected.
- `known_incomplete` appears when a delivered legal trade was excluded (late, overflow, capacity, a failed write).
- `reconciled` means the minute was checked against a trusted trade history with contiguous trade IDs. `repaired` among the reasons means its values were replaced from that history, with a higher `valueRevision`; otherwise they were confirmed unchanged.
- `stale_delivery` marks a delivery for a minute whose identities were already pruned; it may be a duplicate, so it is not a known loss.
- Coverage events carry `occurrences`: repeated events of one reason in one minute share a row.
- A disconnect means an observation gap, not proof that a trade occurred.
- For a minute with **no bar and no coverage event**, the service was observing and received no trade. Silent loss upstream can never be ruled out. Before the first start, during disconnects, after a stop and after a fault, coverage always carries an event.

The API binds to `127.0.0.1` only. There is no HTTP endpoint to inject trades or mutate the database. Invalid query parameters return 400; an empty result is 200 with an empty array.

## Configuration and file mode

The default database is `:memory:`. To retain committed state, pass a fresh local file path with `--db=path/to/service.db`. The service uses SQLite WAL, `synchronous=FULL`, one local writer, semantic configuration hashing and a same-host owner check, and it rejects reopening a file with a changed semantic setting. Tests kill real child processes before COMMIT and after COMMIT (before acknowledgement) and inspect the same database after restart. Incoming but uncommitted in-memory events are **not** durable. After a failed write, intake stops and nothing queued behind the failure is committed; see [DESIGN.md](DESIGN.md) and [LIMITATIONS.md](LIMITATIONS.md).

Optional arguments: `--grace-ms=0..10000`, `--future-tolerance-ms=0..5000`, `--max-queue=1..4096`, `--max-trades=1..500000` (retained identities), `--identity-retention-ms` (default 3,600,000), `--port=0..65535`, and `--reconcile=off|flagged|all`. For mock scenarios reconciliation is off by default and uses the scenario's truth list; for Binance the default is `flagged`, using `/api/v3/aggTrades`.

`--history-retention-ms` controls the linked bar/quality window (default 604,800,000 ms; must be at least identity retention). Reconciliation failures use bounded exponential backoff without a permanent retry cutoff; REST requests time out after ten seconds per page and are cancelled during shutdown.

## Optional live source: Binance Spot raw trades

```text
npm start -- --source=binance --symbols=BTCUSDT,ETHUSDT --port=3000 [--db=live.db] [--duration-s=300] [--silence-timeout-ms=60000]
```

This subscribes to `<symbol>@trade` on the official market-data-only combined stream `wss://data-stream.binance.vision` (`--endpoint=` overrides it). It buckets by trade time `T`, keeps trade ID `t` as its exact source digits, and uses the real clock with a 250 ms tick.

- **Reconnect and lifecycle.**
  - Reconnect uses jittered exponential backoff (1 s doubling to 30 s).
  - `serverShutdown` and the 24-hour connection age trigger an immediate reconnect.
  - A 60 s silence watchdog treats a quiet socket as dead.
- **Gaps and faults.**
  - A disconnect opens a gap starting at the **last received frame**.
  - If intake is halted (queue overflow or a latched fault), the source stops instead of reconnect-looping.
- **Scope.**
  - Node's built-in `WebSocket` is used, so there are no new dependencies. It does not use HTTP proxies.
  - Identities are retained for one hour (`--identity-retention-ms`), so a long run is limited by storage rather than by a lifetime trade cap.
- **Backfill.** Every 15 s, flagged minutes (late trades, gaps, startup, faults) are reconciled against `https://data-api.binance.vision/api/v3/aggTrades` and repaired with an explicit value revision when they differ.

`npm run binance:live-check -- --symbols=BTCUSDT,ETHUSDT --full-minutes=2 [--drop-after-s=70 --drop-for-s=20]` needs network. It runs the real service, reads it over HTTP, and compares every closed bar that is reconciled or carries no quality reason with Binance's own REST 1m kline; every `known_incomplete` bar must differ. With `--drop-after-s`, the stream goes through a local relay that cuts every connection and refuses reconnects for a while, so the service sees a real network drop; the gap minutes must then be reconciled and equal the exchange.

`npm run binance:capture` records raw frames, klines and aggregate-trade history for offline replay. Neither command is part of `npm test`.

## Packaging and benchmark

`npm run package` builds an allowlisted ZIP. `npm run check:package -- --archive=dist/trade-kline-service.zip` extracts it into a fresh temporary directory and runs `npm ci`, typecheck, tests and demo there. The first `npm ci` needs access to the npm registry; after installation the mock application and all tests need no network. See [results/verification.md](results/verification.md) for the checks actually run and [results/review.md](results/review.md) for the independent review findings.

For a bounded synthetic throughput observation (not a network or production SLA), run `npm run benchmark -- --events=5000 --seed=20260925 --storage=memory` or `--storage=file`.
