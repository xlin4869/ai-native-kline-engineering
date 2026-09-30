# AI-assisted engineering case study: trade-to-kline service

This is a reproducible market-data project built from the [original assignment](ASSIGNMENT.md). It shows how AI assistance was used to design, implement, challenge, and verify a service, with the candidate retaining responsibility for the decisions and final claims. The code and the readable, redacted AI exchanges are in this archive. [AI_USAGE.md](AI_USAGE.md) records the model attribution and which labels are directly supported by local session metadata.

## Problem and working contract

Convert a stream of executed trades into one-minute UTC OHLCV bars for downstream readers. The difficult part is deciding what a bar means after disorder, duplicate delivery, late arrivals, disconnects, process crashes, and missed trades. A `closed` bar means its receive deadline has passed; it does not prove that every market trade was observed.

The implementation uses one bounded intake queue and one SQLite writer. Event time determines the half-open minute and the first/last trade, with numeric trade IDs breaking same-millisecond ties. `decimal.js` avoids floating-point price and volume drift. SQLite commits trade identity, bar changes, and quality events together. The read-only HTTP API exposes current and historical bars, observation coverage, revisions, and a persisted history floor. Optional Binance raw trades use the same pipeline; `aggTrades` history can explicitly reconcile eligible minutes. The mock source is the default and needs no exchange connection.

The key alternatives are in [DESIGN.md](DESIGN.md): one local writer instead of distributed infrastructure for this scope; a fixed receive deadline instead of silently rewriting finalized values; a separate quality record instead of treating connectivity as completeness; and a seven-day linked retention window instead of unbounded quality rows. These choices make the behavior inspectable and leave clear scaling limits.

## How AI output was challenged

| Stage | AI contribution | Candidate decision and independent check |
| --- | --- | --- |
| Initial investigation and design | Codex Astra Ultra led requirements analysis, design, and implementation documentation; ChatGPT Web supplied supplementary perspectives | Kept the mock-first scope, explicit event/receive clocks, failure semantics, and a real downstream HTTP reader. The original prompt and design exchanges are linked from [AI_HISTORY/INDEX.md](AI_HISTORY/INDEX.md). |
| Implementation | Codex GPT-6.0 SOL built the service, fixtures, and tests | Verified behavior against hand-calculated OHLCV and a separate BigInt oracle that does not import the production reducer. Fixed a `decimal.js` NodeNext type import and an SQLite handle leak exposed by a restart test. |
| Independent review | Claude reviewed the accepted archive, reproduced suspected faults, added Binance capture/reconciliation, and extended failure tests | Rejected false findings: an invalid mutation run had broken dependencies; a captured-stream mismatch had omitted a recorded socket close; a live-check assertion treated a correctly flagged late bar as a service failure. The review kept those failed attempts in the record. |
| Final reliability review | Codex Astra Ultra led the final audit and closeout; Codex Sol contributed reliability fixes and checks | A probe showed old failed candidates starving later minutes. Scheduling now filters and orders eligible minutes before limiting a run, and transient failures can recover without a permanent retry cap. Linked retention prevents a lifetime quality-row limit from halting intake. Targeted regressions cover both fixes. |

The five-mutant exercise is a useful check on test quality. An initial valid run found only two of five deliberately broken behaviors; deterministic edge probes were added, after which the property test detected all five. Test and harness errors were diagnosed separately from product defects. [AI_USAGE.md](AI_USAGE.md) and [results/review.md](results/review.md) give the underlying sequence without presenting AI agreement as evidence.

## Decisive verification

| Evidence | Result and what it checks |
| --- | --- |
| Hand fixture through the real HTTP process | `O=100 H=103 L=99 C=103 V=6 Q=600 count=3`; verifies aggregation and the downstream interface together. |
| Independent generated oracle | 60 fixed seeds, 39,605 truth trades, 28,352 delivered attempts, and 682 bars; checks values and quality reasons. |
| Reconciliation property scenarios | 30 seeds, 380/380 observable minutes restored to their truth state; 317 repaired, 42 confirmed unchanged, 21 correctly barless. |
| Recorded public Binance trades | 4,651 captured frames; after injecting the loss of 1,284 frames, all four affected minutes matched the recorded exchange klines following history repair. This is replay evidence, not a fresh live claim. |
| Real failure boundaries | Child-process kills around SQLite COMMIT, actual SQLite FULL, and OS ENOSPC on a dedicated Linux tmpfs; the committed prefix remains readable and intake stops on a durable writer fault. |
| Final-source suites | Windows: 80 passed, 0 failed, 1 skipped for environment-dependent ENOSPC. Linux: 81 passed, 0 failed, 0 skipped. See [REPORT.md](REPORT.md) and the acceptance logs in `results/`. |

To reproduce locally with Node 22: `npm ci`, `npm run typecheck`, `npm test`, then `npm run demo`. The demo starts a real local HTTP service and runs a paging consumer. `npm run check:package -- --archive=dist/trade-kline-service.zip` additionally checks a fresh extraction. First dependency installation uses the npm registry; the installed mock tests do not need Binance access.

## What this case demonstrates and where it stops

The reusable method is to turn an ambiguous market-data requirement into observable contracts, use AI for alternative designs and adversarial review, and settle disagreements with independent calculations, reproducible failures, and the actual consumer path. This matters more than the number of prompts or tools used. The archive includes the [assignment](ASSIGNMENT.md), source, fixtures, tests, decision notes, verification output, and a [chat-history index](AI_HISTORY/INDEX.md) with explicit redactions and snapshot cut-offs.

This is a single-process service with non-durable in-memory intake. Automatic reconciliation looks back six hours and depends on the venue's own history; retained local history defaults to seven days. Long live soaks, power-loss behavior, and macOS remain unverified. The original assignment states a one-day timebox, but this later portfolio version does not claim it was completed within that window. No production deployment or trading use is claimed. See [LIMITATIONS.md](LIMITATIONS.md) for operational consequences and next checks.
