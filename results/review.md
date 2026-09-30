# Independent review of the 798d29c3 submission (2026-09-25)

Scope: the accepted 48-file archive (SHA-256 `798d29c33deaeb31ada371d487bc45171702ea9c970575e67309232951db33c0`), reviewed against the original assignment by a second AI session (Claude Code, Opus 5.5) that did not write it. Its existing tests and verification record were not taken as truth. Each finding below was reproduced against an untouched copy of that archive's source before it was fixed. Line numbers refer to the **reviewed** source; `tests/review.test.ts` holds one test per finding. All 8 tests failed on the reviewed source and pass now. For F2, the reviewed code has no hook to apply a page limit, so the direct baseline evidence is the probe result quoted below.

Probes P-A to P-G and P-4 were throwaway scripts. Their code and output appear in `AI_HISTORY/transcripts/claude-code-26ef8a38-….md`, and each finding they exposed has a permanent test.

Severity: **P1** means the service could present a bar as observed when a delivered or unobserved trade was lost, or it lost diagnosability of a storage failure. **P2** means a wrong or over-broad label, or a resource leak, with a limited trigger. **P3** means cosmetic or a known trade-off.

## Defects found and fixed

| ID | Sev | Trigger | Expected | Reviewed behaviour | Location (reviewed) | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | P1 | A write fails on trade k while trade k+1 is still queued, then any later `drain()` runs. `main.ts` shutdown does this at line 50, and live sources always have a queue. | Nothing queued behind a failed write commits; the lost delivery is visible on the affected bar. | `drainLoop` resumed after the latched fault and committed k+1. k was rolled back with no quality row, so the bar showed `reasons: []`, `unverified` (probe: `open=105, tradeCount=1, reasons=[]`). | `src/coordinator.ts:85-96`; `src/sqlite-store.ts:153` (no fault guard) | F1 |
| F2 | P1 | A real engine-level `SQLITE_FULL` (from a `max_page_count` limit) during a trade transaction. | The original cause is kept, intake stops, the bar shows the loss, and reopening reports `faulted`. | SQLite had already rolled back, so the service's own `ROLLBACK` threw and replaced the cause with `writer_error:cannot rollback - no transaction is active`. The 28th delivered trade left no bar reason, and reopening reported `sourceState=stopped`. | `src/sqlite-store.ts:106`, `:248` | probe P-G; F2 |
| F3 | P1 | A fresh start at M with a trade from M−1 ms arriving in the grace period; more generally, any minute before the first start. | Every minute whose receive window straddles the start is flagged, and minutes before the start are distinguishable from observed-empty ones. | Only `minuteOpen(start)` was flagged, and only for a mid-minute start. The previous minute's bar had `reasons: []`, and pre-start minutes had no bar and no coverage event, exactly like an observed minute with no trades. | `src/sqlite-store.ts:237-242` | F3; property test fails on the reviewed source at seed 1 |
| F8 | P2 | A disconnect only inside a barless minute's grace period (M+60.5 s to M+61.5 s). | That minute's coverage lists the gap, as the bar's own reasons would. | Coverage filtered observation rows by minute bounds while bar quality used the receive window, so it returned `[]`. | `src/sqlite-store.ts:290` | F8 |
| F4 | P2 | A mock store receives `venue: "binance"` for a symbol and minute it already holds. | One configured source per store, so `(symbol, minute)` is unique. | Both venues were accepted; two bars shared `openTimeMs`, and `limit=1` paging via `nextFrom` skipped one. | `src/contracts.ts:105`; `src/sqlite-store.ts:275-279` | probe P-C; F4 |
| F5 | P2 | The source stops, reconnects, trades, then the store is closed while connected; then a restart. | The downtime gap starts at the last processed time. | `sourceStoppedAt` was never cleared on reconnect, so the gap started at the old stop and fully observed minutes were labelled `source_gap`. This errs on the conservative side, but it is a wrong label. | `src/sqlite-store.ts:69`, `:215` | probe P-F; F5 |
| F6 | P2 | A `clock_untrusted` fault or `resource_limit` while other bars are open. | Every bar that could still receive trades after the fault carries the fault reason. | The clock fault was scoped `source` (attached to no bar); resource_limit marked only the rejected trade's minute. Open ETH bars and other minutes showed `reasons: []`. | `src/sqlite-store.ts:162`, `:194` | probes P-D, P-E; F6 |
| F7 | P2 | Opening a corrupt (non-SQLite) database file. | A clear refusal, with the file handle released. | The error was correct but the handle leaked; Windows then refused to delete the file (`EBUSY`). | `src/sqlite-store.ts:40-58` | F7 |

Fix summary:

- The coordinator halts after the first committed fault or failed write, and the store refuses to process once a fault is latched.
- A writer fault is latched in memory first, then persisted as an open-ended `writer_fault` observation row, falling back to the meta row only. `ROLLBACK` failures no longer mask the cause.
- Clock, resource and writer faults are observation intervals `[fault, ∞)`. A fresh start records `startup_partial [0, start)`, and coverage uses the same receive-window rule as bar quality.
- A store accepts only its configured venue, reconnecting clears the stale stop time, and a failed store initialization closes its handle.

Changed expectations in existing tests, all deliberate:

- Stores that start exactly on a minute (`harness()` at M) now report `startup_partial` for M. Under the service's own receive-window model, `[open − futureTolerance, end + grace)`, a trade stamped just after M could have been received before the service existed; gaps already used this rule.
- The golden fixture now starts 10 s before M, so its demo minute is genuinely fully observed. The hand-calculated OHLCV is unchanged: IDs 1, 3 and 2 arrive in that order; event order gives 100/99/103, so O=100, H=103, L=99, C=103; V=2+3+1=6; Q=200+297+103=600; count 3.

## Test-evidence weaknesses found and addressed

| ID | Finding | Change |
| --- | --- | --- |
| T1 | The oracle is independent code (no production imports, `BigInt` fixed point), but its only randomized comparison put 150 trades received in `[M+59.000 s, M+59.149 s]` into one minute (`tests/oracle.test.ts:19-25`). It never exercised late, future, multi-minute, gap, restart or truth-versus-service comparisons. | `tests/property.test.ts` covers 60 seeds (39,605 truth trades, 28,352 deliveries, 682 bars). It checks service bars against the oracle bar by bar, closure, that every observable miss carries a reason, that no false `known_incomplete` occurs, and that bar reasons equal the coverage API. |
| T2 | The mock supplier replayed three hand fixtures only; it could not simulate normal activity. | `src/mock-generator.ts` is a seeded generator: Poisson-like arrivals, 15% same-millisecond bursts, a random-walk price, disconnects, silent loss, late and skewed delivery, equivalent-decimal duplicates, conflicting twins and pre-start trades. It adds deterministic edge probes: a same-millisecond pair at a minute's close whose IDs cross 9,999,999,999 to 10,000,000,000, arrivals at deadline − 1 ms and exactly at the deadline, and a disconnect only inside a grace period. CLI: `--generate-seed=N`. |
| T3 | The random property test alone first missed 3 of 5 seeded mutants, because uniform data rarely lands on exact boundaries. | After the edge probes, the property test alone kills all 5 mutants (string trade-ID order, `>` instead of `>=` at the deadline, float quote volume, missing startup row, gap window ignoring grace); the full suite kills each too. An early run that seemed to kill all four was invalid (broken `node_modules` copy) and is discarded. |
| T4 | The consumer made single requests and never followed `nextFrom`/`nextCursor`. | `examples/read-klines.mjs` now pages; the demo's second phase reads a generated scenario 2 bars per page and requires equality with one unpaged read. |

## Checked and found correct (no change)

- **UTC half-open buckets:** `floor(T/60000)`, with child processes under `TZ=UTC` and `America/New_York`.
- **Same-millisecond ordering by `BigInt` trade ID:** confirmed critical on real data, where 86% of 4,651 captured BTCUSDT trades shared a millisecond with their predecessor. The captured replay matches the exchange's own klines, so the ordering rule is correct on that data.
- **Decimal capacity:** inputs have at most 36 significant digits, products at most 72, and sums over at most 500,000 trades at most 78 digits, below the 96-digit context. Constructing a decimal from a string does not round.
- **Deadline equality and queued processing:** `receivedAt < end + grace` is judged on the ingress stamp; the identity check runs before the late check.
- **HTTP snapshots:** handlers are synchronous and each write is one SQLite transaction.
- **Atomicity:** the child-kill-before/after-COMMIT tests were re-run and pass.

## Verified but not fixed (recorded as limitations)

| ID | Sev | Observation | Why not fixed |
| --- | --- | --- | --- |
| L1 | P3 | A disconnect and reconnect within the same millisecond deletes the zero-length gap row. A reader between the two commits sees `source_gap` with revision 4, then `[]` with revision 0 (probe P-4), so `qualityRevision` is not monotonic in that case. | A monotonic per-bar revision needs a persisted per-bar counter; the case needs a same-millisecond flap. Documented. |
| L2 | P2 | Lifetime caps of 500,000 identities and 10,000 quality rows. The live BTCUSDT rate observed was about 950–3,900 trades per minute, so a live run reaches `resource_limit` within roughly 2–9 hours and halts intake by design. | Needs an identity-retention horizon and its own duplicate-versus-late semantics. The live source is documented as bounded smoke use. |
| L3 | P2 | A fixed receive deadline excludes genuinely delayed trades. It was observed live: in two of four runs one minute turned `known_incomplete` (for example, 214 of 1,245 BTCUSDT trades at 10:52 arrived after 2 s). The exclusion was flagged correctly, and those bars differ from the exchange as they should. | Repairing these needs a versioned backfill/revision policy (for example, REST trade lookup). See `results/verification.md` for the load observation. |
| H1 | – | Hypotheses, not measured as problems at current limits: O(queue) `filter` per enqueue, a `closeDue` full scan of open bars, and bar quality computed in O(bars × quality rows). | Performance only; the benchmark is recorded. |

## Round 3: remaining items resolved (2026-09-25/26)

The user asked for every remaining item above to be resolved. This round's tests are `tests/hardening.test.ts`, `tests/reconcile.test.ts`, the second test in `tests/property.test.ts`, the injected-disconnect replay in `tests/binance.test.ts`, and `tests/enospc.test.ts`.

| Item | Resolution | Evidence |
| --- | --- | --- |
| L1 `qualityRevision` could decrease | A retracted same-millisecond gap is kept as an empty interval. It names no reason and is not a coverage event, but it still counts toward the revision. | `L1 ...` test: the revision rises at the disconnect and rises again at the reconnect; the round-2 source fell from 4 back to 0 (probe P-4) |
| L2 lifetime caps (500,000 identities, 10,000 quality rows, one row per late trade) | Identities are pruned after `identityRetentionMs` (default 1 h) behind a persisted horizon, and `maxTrades` now limits retained identities. A delivery behind the horizon is `stale_delivery`, not a known loss. Repeated minute and source events share one row with `occurrences`. Quality reads are indexed and windowed instead of loading every row. | `L2 ...` tests: 8 minutes run through `maxTrades=3` without a fault; 300 late trades cost one row with `occurrences=300`; the horizon survives a restart |
| L3 no backfill for late or gap minutes | `reconcile` events carry a closed minute's complete trade history (Binance `aggTrades`, or mock truth). The history must have contiguous raw IDs and must not be truncated. Equal values are confirmed; different values are repaired with an explicit value revision; the reconciled ID range turns later redeliveries into duplicates. | Reconcile unit tests. A 30-seed property test (380 minutes, every observable minute equal to truth after reconciliation, silent losses included). Captured replay with an injected disconnect dropping 1,284 real frames: all four minutes equal Binance's klines after repair. Live run 5 with a real network cut: 6/6 comparable minutes equal the exchange, including the repaired gap minutes |
| Linux not verified | The extracted archive was run in a `node:22-bookworm-slim` container (Node 22.23.2). | `results/verification.md` |
| OS-level disk exhaustion not tested | Real ENOSPC on a 1 MB tmpfs: SQLite reported "database or disk is full" after 34 trades. The cause was latched, all 34 committed trades stayed readable, the tail bar became `known_incomplete` with `writer_fault`, and intake was refused. | `tests/enospc.test.ts`, run in the Linux container |
| Real network drop not tested live | The live check can route the stream through a local relay that cuts every connection and refuses reconnects. The service backed off, reconnected, and reconciliation repaired the gap. | `results/binance-live-check-5-drop.json` |

This round also introduced a defect of its own, which the tests caught before any delivery. A shell edit dropped a backslash from the history ID validator (`[1-9]d{0,39}` instead of `[1-9]\d{0,39}`), so it accepted only single-digit IDs. The unit tests, whose IDs were 1–3, passed; the reconciliation property test failed at seed 1. The fix came with a unit test using multi-digit and above-2^53 IDs, and every regex in the source was re-checked.

Still open, with reasons, in `LIMITATIONS.md`: power loss and torn writes, macOS, multi-hour live soaks, and silent upstream loss in unflagged minutes unless `--reconcile=all` is used.

## Round 4: independent final review and repair (2026-09-26)

The final review reproduced two problems in the round-3 release; the user then authorized fixes.

| Finding | Repair | Regression evidence |
| --- | --- | --- |
| A limited oldest-candidate page was filtered only after three failed attempts; exhausted older minutes could block newer minutes and never retry in the same process. REST fetch had no explicit deadline. | Scan the bounded lookback before work limiting, prioritize unattempted/least-recently attempted candidates, exponential retry without lifetime cutoff, per-page header/body timeout and shutdown cancellation. | Reconciliation suite: 13/13. Old code failed five initial new regressions. Poisoned-candidate probe: 14 candidates all attempted, 10 valid minutes reconciled; recovery after four failures; real local HTTP header/body stalls and cancellation. |
| Quality rows still had a lifetime cap although identities were pruned and late events coalesced. | Seven-day linked retention of bars and quality, persistent history floor, HTTP 410 on expired queries, no resurrection from old inputs. Capacity counts current rows; event IDs remain monotonic. Schema 3 refuses old files. | Retention suite: 10/10. Twenty minutes processed under six-row capacity, retained quality correct; active-window cap still fails; boundary gaps, clock fault, restart and HTTP tested. |
| A capacity-faulted database could not reopen because resume allocated another ordinary quality row at the cap. | Preserve the fault and existing evidence; skip ordinary recovery-row allocation for a faulted store. | Added failing file-reopen regression, then passed with fault still latched and reads available. |

Final source verification: Windows 80 passed / 1 ENOSPC skipped; Linux 81/81 including real ENOSPC; strict types and Linux HTTP demo passed. Final ZIP acceptance is recorded externally in the release receipt. No new live exchange run or multi-hour soak was performed.
