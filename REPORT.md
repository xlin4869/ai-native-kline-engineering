# Delivery report

This service builds one-minute UTC klines from executed trades and exposes current bars, historical bars and observation quality through a read-only HTTP API. The default evaluation uses a deterministic mock supplier. An optional Binance Spot raw `@trade` adapter and `aggTrades` reconciliation exercise the same processing path.

## Decisions and methods

- One bounded ingress queue and one SQLite writer make ordering, committed snapshots and crash boundaries explicit. Decimal arithmetic and numeric trade-ID ordering avoid floating-point and same-millisecond ordering errors.
- Event time determines the minute and open/close order. A fixed receive-time deadline governs late acceptance. Numeric closure, observation gaps and market completeness are separate facts.
- The mock supplier combines hand-calculated fixtures with seeded normal traffic, duplicates, conflicts, disorder, late arrivals, gaps and silent loss. An independent BigInt oracle, property tests, real HTTP consumers and process/disk failure tests check the implementation.
- Reconciliation revises closed values explicitly. Temporary history failures use bounded exponential backoff without a lifetime retry cap; candidate selection allows other minutes to progress. HTTP deadlines cover response headers and bodies, and shutdown cancels pending reconciliation.
- Linked history retention keeps bars and their quality evidence together for seven days by default. Expired queries return HTTP 410 with the available history floor; old inputs cannot recreate expired history. The quality-event cap applies to retained rows, so abnormal within-window growth still fails visibly.

## Evidence and limits

The golden HTTP result is `O=100 H=103 L=99 C=103 V=6 Q=600 count=3`. The final suite contains 81 registered test cases; the complete Windows and Linux acceptance output is included under `results/`. The test runner executes files sequentially and all ordinary tests run without exchange access.

| Final-source verification (2026-09-26) | Result |
| --- | --- |
| Windows, Node 22.16.0: strict typecheck and full suite | Passed; **80 passed, 0 failed, 1 skipped**. The skip is the real ENOSPC case requiring a dedicated small filesystem. |
| Linux, Node 22.23.2: fresh dependencies, strict typecheck, full suite and HTTP demo | Passed; **81 passed, 0 failed, 0 skipped**. Real ENOSPC on a 1 MB tmpfs preserved 34 committed trades and refused further intake. |
| Generated numeric/quality and reconciliation populations | 39,605 truth trades, 28,352 deliveries and 682 bars checked; **380/380** observable reconciliation minutes restored to truth (317 repaired, 42 confirmed, 21 empty). |
| Captured-stream disconnect replay | 1,284 frames deliberately dropped; all four captured minutes matched the recorded exchange klines after repair. |
| Final ZIP | Clean-directory install, typecheck, full suite and demo result plus SHA-256 are in the external release receipt. |

| Test group | Cases | What is checked |
| --- | ---: | --- |
| Core aggregation, coordinator, independent oracle and mock | 24 | UTC half-open minute boundaries and timezone independence; exact decimals and quote volume; same-millisecond numeric IDs, including large IDs; duplicates and conflicting identities; before/at/after admission deadlines; future timestamps; queue/control capacity; clock faults; EOF; source gaps; independent hand calculation and quantity-scaling checks. |
| HTTP API | 7 | Committed current/historical reads; overlapping open minutes during grace; quality/coverage paging; invalid requests; fault/readiness semantics; stalled queues; idle request timeout and connection limits. |
| File recovery and disk exhaustion | 7 | Single-writer ownership; semantic-config and clock rejection; clean restart; actual child kills before/after COMMIT; replay after crash; transaction rollback; real OS ENOSPC when a dedicated small filesystem is supplied. |
| Earlier audit regressions | 8 | No commit behind a failed write; actual SQLite FULL cause preservation; corrupt-file handle cleanup; startup/pre-start quality; barless grace-period gaps; one venue per store; reconnect downtime scope; fault coverage across symbols. |
| Generated property scenarios | 2 | 60 seeded scenarios compare all bars and quality contracts against an independent BigInt oracle; 30 seeded reconciliation scenarios restore every observable minute to market truth. One test case exercises many generated inputs. |
| Binance adapter and captured replay | 6 | Exact parsing above 2^53; reconnect backoff, stale-socket fencing, silence and shutdown/age events; intake halt; captured real trades versus exchange klines; repair after injected disconnect. |
| Identity/revision hardening and reconciliation | 17 | Monotonic quality revisions; coalesced late events; identity retention/restart; repair and unchanged confirmation; contiguous-ID validation and REST pagination; poisoned-candidate fairness; recovery after more than three failures; real HTTP header/body deadlines, cancellation and callback isolation. |
| Linked history retention | 10 | Continued operation beyond lifetime event counts; retained-window overflow still fails visibly; retained boundary quality and open gaps; no resurrection by old inputs; HTTP 410; persisted floor and restart pruning; faulted files can reopen for reads even at capacity; untrusted clocks cannot expire history; configuration bounds. |

Independent checks provide different failure detectors: the oracle uses fixed-point BigInt and imports no production reducer; the demo launches a real service and consumes paginated HTTP responses; captured exchange klines supply an external comparison. Earlier recorded runs covered 39,605 truth trades / 28,352 deliveries / 682 bars over 60 seeds, and 380 reconciliation minutes over 30 seeds. A five-mutant experiment tested whether the property test detects intentionally broken ID ordering, deadline equality, floating-point quote volume, startup quality and grace-window gaps; all five were detected after strengthening deterministic edge probes.

Previous live verification recorded five bounded Binance runs and one real network cut through a relay; the final such run matched all six comparable closed minutes after repair. Those live results and the five-mutant experiment are historical evidence from earlier revisions; live exchange checks and the mutation matrix were not repeated in this final round. Linux was independently rerun on the final source as shown above. `results/verification.md` records populations and conditions. The final deliverable is also checked by fresh Windows ZIP extraction, dependency installation, type checking, the complete test suite and the real HTTP demo.

The final repair has explicit before/after evidence: an early-failure probe originally attempted only four of fourteen candidates; the corrected scheduler attempts all fourteen and reconciles the ten valid minutes. Four consecutive history failures recover on the fifth attempt in the same process. A rolling-history test processes twenty minutes with a six-row capacity, retaining the last two minutes and increasing event IDs without fault; actual retained-window overflow still fails closed. A further regression proves a capacity-faulted file can reopen for reads without allocating a new normal quality row.

Reproduce with Node 22: `npm ci`, `npm run typecheck`, `npm test`, `npm run demo`. Focused commands are `npm test -- --suite=hardening` and `npm test -- --suite=retention`. Verify the archive with `npm run check:package -- --archive=dist/trade-kline-service.zip`. Initial installation requires registry access; the mock service and installed tests do not.

The service remains a small single-process implementation. In-memory ingress is not durable; history older than the retention window needs an external archive; automatic reconciliation looks back six hours and trusts the venue's history. Power loss, long live soaks and macOS are unverified. Schema changes require a fresh database; no automatic migration is provided.

## AI-assisted workflow

Codex GPT-6 Astra Ultra led requirements analysis, technical design, and implementation documentation; ChatGPT Web GPT-6 Pro supplied supplementary perspectives. Codex GPT-6.0 SOL handled the main implementation, and Claude Code Opus 5.5 independently reviewed and improved it. Codex GPT-6 Astra Ultra led the final audit and closeout, with GPT-6.0 SOL also contributing final fixes and checks. The local Codex session metadata identifies `gpt-6-astra` and `gpt-6-sol`; the web model and Ultra effort label follow the candidate's description. `AI_USAGE.md` explains the evidence boundary, and readable technical exchanges are under `AI_HISTORY`.

Significant reused components and their sources are listed in `REUSE.md`; implementation details and remaining limitations are in `DESIGN.md` and `LIMITATIONS.md`.
