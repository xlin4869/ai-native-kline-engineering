# Verification record

This file records checks that were actually run; planned features are not counted as passing.

- **Platforms:** Windows 10.0.26200, Node `v22.16.0`, npm `10.9.2`; and, from round 3, a Linux container (`node:22-bookworm-slim`, Node `v22.23.2`, npm `10.9.8`). `node:sqlite` emits an experimental warning.
- **Sources:** deterministic mock (default); optional Binance Spot raw `@trade` via `wss://data-stream.binance.vision`.
- **Storage:** in-memory for core, API and demo; local temporary SQLite files for recovery tests.
- **Rounds:** round 1 is the original submission (archive `798d29c3…`, 37 tests). Round 2 is the independent review and fix session of 2026-09-25 (archive `31aa1a76…`). Round 3 resolves the items round 2 left open. See [review.md](review.md).

## Round 2 checks (source of archive 31aa1a76)

| Check | Observed result | Scope |
| --- | --- | --- |
| `npm run typecheck` | passed | Strict TypeScript over `src/**` and `tests/**` |
| `npm test` | **51/51 passed**, about 31 s (one earlier `npm run typecheck` attempt failed in the npm shim with "Could not determine Node.js install directory" before tsc ran; two immediate retries passed) | 37 original tests (six with deliberately updated expectations, see review.md), 8 review regressions, 1 property test (60 seeds), 5 Binance tests |
| Review regressions against the reviewed source | **8/8 failed** on an untouched copy of the 798d29c3 source; 8/8 pass now | `tests/review.test.ts`. F2 fails on the reviewed source because it lacks the page-limit hook; its direct evidence is probe P-G (masked `cannot rollback` error). |
| Property test against the reviewed source | failed at seed 1: pre-start minute with observable misses and no reason | `tests/property.test.ts` |
| Mutation matrix (scratch copy) | Property test alone: 5/5 mutants killed after adding edge probes (2/5 before). Full suite: each mutant killed (1–7 failing tests each). | M1 string trade-ID order, M2 `>` instead of `>=` at the deadline, M3 float quote volume, M4 no startup row, M5 gap window without grace. One earlier matrix run was invalid (broken `node_modules` copy) and was discarded. |
| Property-test totals | 39,605 truth trades, 28,352 deliveries, 682 bars, 12,799 observable misses (all carrying a reason), 284 `known_incomplete` bars (all differing from truth), 20 minutes whose only loss was silent | population = generated scenarios; seeds 1–60; 5 minutes each plus 2 pre-start minutes; BTCUSDT and ETHUSDT |
| `npm run demo` | passed, both phases. Golden: `O100 H103 L99 C103 V6 Q600 count3`, `closed`, `unverified`, no reasons. Generated seed 7: 6 bars per symbol; the paged consumer read (3 pages of 2) equals one unpaged read; reasons included startup, gap, late, conflict and invalid input. | Real HTTP subprocess plus `examples/read-klines.mjs` |
| Captured Binance replay (`tests/binance.test.ts`) | 4,651 frames, all parsed; trade IDs contiguous (4,651 unique = ID span); bars equal the oracle. The 2 fully observed minutes (10:39 and 10:40 UTC, 1,504 and 594 trades) equal Binance REST 1m klines on O, H, L, C, V, quote volume and count. The first and last minutes are flagged `startup_partial` and `source_gap`. | `fixtures/binance/btcusdt-capture.json`, captured 2026-09-25 10:38:24–10:41:53 UTC. Latency (receive − `T`): p50 173 ms, p99 401 ms, max 567 ms. 86% of frames share their predecessor's millisecond. |
| Binance lifecycle (fake socket and timers) | passed | Exact ID above 2^53; `serverShutdown` (raw and combined); malformed and mismatched frames; one drop for error+close; generation fencing; duplicate across reconnect; gap starting at the last frame; backoff 0.5/1/2/4/8/15/15 s with fixed jitter; immediate reconnect after shutdown; 24 h age timer; 60 s silence watchdog; overflow halts without reconnect; clean stop |
| Live check 1 (`results/binance-live-check-1.json`) | passed. BTCUSDT and ETHUSDT: 2/2 fully observed minutes equal the exchange | 2026-09-25 10:45:56 UTC start, about 3 min, real service over HTTP |
| Live check 2 (`…-2.json`) | 4/4 fully observed minutes per symbol equal the exchange. 10:52 was `known_incomplete` (`late_rejected`) for both symbols and differed from the exchange (BTC 1,031 vs 1,245 trades; ETH 1,699 vs 1,702). The script's assertion then required five unflagged minutes and failed; that criterion was wrong and was replaced. | 10:50:01 start, about 6 min; overlapped concurrent test and benchmark runs on the same host |
| Live check 3 (`…-3.json`) | passed with the corrected criteria. 2/2 unflagged minutes equal per symbol; 11:48 `known_incomplete` for both symbols and differing, as required | 11:47:20 start; overlapped concurrent review-test runs |
| Live check 4 (`…-4.json`) | passed. 3/3 fully observed minutes per symbol equal the exchange; no late rejection | 11:52:23 start; run with no concurrent heavy work |
| Benchmark, memory, 5,000 events | Reviewed source 2,240 and 2,298 trades/s; current source 1,984 and 2,258 trades/s | Same generator and seed, back-to-back on an idle host; not a production SLA |
| Benchmark, file, 2,000 events | Reviewed source 375–459 trades/s (5 runs); current source 336–448 trades/s (4 runs) plus one outlier at 85/s | Local SQLite WAL/FULL; per-commit fsync variance is high on this host |
| `npm audit` | not re-run in round 2; dependencies unchanged since round 1 (0 reported vulnerabilities after the fflate 0.8.3 upgrade) | — |
| Archive identifier scan | No file of the extracted archive contains the local account name, the e-mail local part (any prefix of 5 or more characters), the workspace folder name or the local DB password. Before this round, `scripts/export-ai-history.mjs` hard-coded the account name and workspace path in its redaction rules; it now derives them at run time, with the same behavior. | `grep -r` over a fresh extraction, patterns built from the local environment so they are not written into any file |
| Final ZIP extraction check | recorded in the external `dist/RELEASE_RECEIPT.md` so the ZIP does not contain its own hash | Fresh temporary directory: `npm ci`, typecheck, tests, demo |

The host was under memory pressure at times during round 2, from other workloads: one `tsc` run died with a V8 out-of-memory error and shell forks failed once. Each affected command was re-run once the host recovered, and only the completed re-runs are counted above. The live late-rejection episodes coincided with concurrent CPU-heavy runs; the cause was not isolated.

## Round 3 checks (current source)

Round 3 resolved the items left open after round 2; see the last section of [review.md](review.md).

| Check | Observed result | Scope |
| --- | --- | --- |
| `npm run typecheck` | passed | Strict TypeScript |
| `npm test` (Windows) | **62 passed, 1 skipped** (the ENOSPC test needs `TKS_ENOSPC_DIR`) | Adds 4 retention/revision tests, 5 reconciliation tests, the reconciliation property test and the injected-disconnect replay |
| Reconciliation property test | 30 seeds, 380 observable minutes: all equal to market truth after `--reconcile=all` (317 repaired, 42 confirmed unchanged, 21 correctly barless) | population = generated scenarios, seeds 1–30, BTCUSDT and ETHUSDT |
| Injected-disconnect replay | 1,284 real frames dropped across 10:39–10:40 UTC; after flagged reconciliation from the recorded `aggTrades`, all 4 captured minutes, including both partial ones, equal Binance's REST 1m klines on all seven fields | `fixtures/binance/btcusdt-capture.json`, augmented with `aggTrades` fetched on 2026-09-25 |
| History versus klines | `barFromHistory` over the recorded `aggTrades` reproduces all 5 recorded exchange klines (10:37–10:41) | same fixture |
| Linux container, current tree | `node:22-bookworm-slim` (Node 22.23.2, npm 10.9.8), 1 MB tmpfs for ENOSPC: typecheck passed, 62/63 then 7/7 recovery after correcting the ENOSPC test's own threshold (it expected more than 100 trades before the disk filled; 34 fit), demo passed. The first `npm ci` in the container hit a transient registry reset; `--fetch-retries=6` succeeded. | The final archive's Linux run is in the external receipt |
| Real ENOSPC (Linux) | "database or disk is full" after 34 trades; cause latched; all 34 committed trades readable; tail bar `known_incomplete` with `writer_fault`; intake refused | `tests/enospc.test.ts` |
| Live check 5, real network drop (`results/binance-live-check-5-drop.json`) | Relay cut both streams at 16:06:23 UTC and refused 4 reconnects until 16:06:43; the service reconnected at 16:06:49. Reconciliation repaired 16:05 (startup) and 16:06 (drop) for both symbols, e.g. BTCUSDT 16:06 from 2,499 to 5,073 trades. 6/6 comparable closed minutes equal the exchange. | 2026-09-25 16:05:13 start, about 4 min |
| Demo | passed. Phase 2 runs with `--reconcile=all`; every closed generated bar is `reconciled` over HTTP | Real HTTP process and paging consumer |
| Benchmark, round 2 versus round 3 | memory 2,664–4,122 versus 3,263–3,598 trades/s; file 433–530 versus 435–464 trades/s | Same generator and seed, alternating; no regression beyond noise |

## Assignment requirement status

| Requirement | Status | Evidence | Limitation / decisive check |
| --- | --- | --- | --- |
| R01 Trade→1m kline | implemented_verified | Golden fixture, demo, property test; the captured and live Binance minutes equal the exchange's own klines | — |
| R02 Mock supplier | implemented_verified | Three hand fixtures plus a seeded generator of normal activity, faults and edge probes | Faults are modelled, not recorded from production |
| R03 Realistic operating conditions | implemented_verified_with_limits | Generator faults, restarts and child kills (Windows and Linux), SQLITE_FULL, corrupt file, real ENOSPC, slow HTTP, connection cap, live late arrivals, a real live network drop | Power loss not run; see LIMITATIONS |
| R04 Downstream interface | implemented_verified | HTTP tests; the paging consumer in the demo | Localhost polling only |
| R05 Assumptions and trade-offs | documented | README, DESIGN, LIMITATIONS, review | — |
| R06 Independent correctness evidence | implemented_verified | Hand constant, independent `BigInt` oracle, two property tests (quality contract over 60 seeds; reconciliation restoring truth over 30), mutation matrix, exchange klines (live, captured, and after repair) | Reconciliation trusts the venue's own history |
| R07 Individual, AI-enabled process | attested | AI_USAGE, AI_HISTORY | No other person was consulted |
| R08 Reuse sources | documented | REUSE, package-lock | No dependency added in rounds 2 or 3 |
| R09 ZIP project | archive_receipt_external | `dist/RELEASE_RECEIPT.md` | — |
| R10 AI chat history | present_with_redactions | Codex round-1 transcripts plus the Claude Code transcript covering rounds 2 and 3 and the follow-up questions on submission readiness (see AI_HISTORY/INDEX.md) | Readable redacted extractions, not native full-fidelity exports |
| R11 Timebox honesty | documented | The user removed the one-day limit as an engineering deadline | No claim of completion inside an interview window |

## Scenario coverage

`passed` means the named condition has an actual assertion.

- **T01–T28:** unchanged from round 1 and passing. T12 (startup) now also covers the previous minute and pre-start coverage (F3); T13 now also covers barless-minute coverage (F8).
- **T29 (capacity and storage faults):** SQLITE_FULL through a page limit, a corrupt file (F2, F7) and a real OS ENOSPC on Linux are covered; capacity now applies to retained identities and aggregated quality rows. Power loss is not run.
- **T30 (archive):** see the external receipt.
- **Round 2 additions:**
  - F1–F8 regressions.
  - Property test: numeric equality with the oracle, closure, reason for every observable miss, no false `known_incomplete`, bar reasons equal to coverage.
  - Binance parser, lifecycle and captured replay.
  - Live checks 1–4 (network; not part of `npm test`).
- **Round 3 additions:**
  - L1 monotonic revision; L2 retention, stale deliveries, aggregation, restart horizon.
  - L3 reconciliation: repair, confirmation, barless backfill, refusal of incomplete or premature history, `aggTrades` paging with exact IDs.
  - Reconciliation property test; injected-disconnect replay; real ENOSPC (Linux); live check 5 with a real network drop.

## Remaining work by decision value (after round 3)

| Priority | Next action | Decisive check |
| --- | --- | --- |
| P1 | Multi-hour live soak with periodic forced drops | No unflagged minute differs from the exchange; retention keeps storage flat |
| P2 | Power-loss / torn-write testing on target hardware | Committed prefix intact after a hard power cut |
| P2 | macOS CI run of the extracted ZIP | Same assertions pass |
| P3 | Archival of old bars and quality rows for multi-week runs | Bounded disk usage with history still queryable |

## Round 4: final reliability fixes and delivery report (2026-09-26)

This section supersedes the old lifetime-cap limitation and adds a defined history-retention contract. Older round results remain historical records.

| Check | Observed final-source result | Population / scope |
| --- | --- | --- |
| Windows typecheck + full test suite | Passed; **80 passed, 0 failed, 1 skipped** | All 81 cases; ENOSPC skipped without a dedicated small filesystem |
| Linux fresh npm install + typecheck + full suite + demo | Passed; **81/81**, no skips; npm reported 0 vulnerabilities | Node 22.23.2, local node:22-bookworm-slim image; final source copied into a fresh /work, no host node_modules |
| Real Linux ENOSPC | After 34 trades, cause preserved, committed prefix readable, further intake refused | 1 MB dedicated tmpfs; same final suite |
| Retry, timeout and cancellation regressions | 13/13 reconciliation cases | Poisoned oldest minutes and two symbols, >3 failures then success, real local HTTP header/body stalls, stop and ignored cancellation, observer exceptions |
| Linked history retention regressions | 10/10 | Two-minute test window over 20 minutes, six-row cap, monotonic IDs; quality boundary, open gap, old input, HTTP 410, file restart and faulted reopen |
| Property and captured replay | All pass again: 39,605 truth trades, 28,352 deliveries, 682 bars; 380 reconciled minutes; injected 1,284-frame drop repaired | Same fixed seeds and captured public fixture as prior rounds |
| Final project ZIP | See external RELEASE_RECEIPT.md | Fresh Windows extraction runs npm ci, typecheck, all tests and real HTTP demo; source and archive bytes checked |

`REPORT.md` gives per-group case counts and what each group checks. The final live exchange adapter was not exercised against the live venue in this round; previous five short live runs remain earlier evidence. The new seven-day retention policy is simulated deterministically, not demonstrated by a seven-day soak. SQLite deletion reuses pages but need not shrink the file. Automatic repair still considers six hours; retry state is in memory. These are explicit limits, not planned functionality presented as complete.
