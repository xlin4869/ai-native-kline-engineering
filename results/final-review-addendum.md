# Final review addendum

This supersedes the earlier review-only supplement. Both remaining material findings were reproduced and fixed in the final release.

1. **Reconciliation starvation and bounded lifetime retries:** scheduling now filters backoff and orders eligible candidates before limiting each round. Retries continue within the six-hour eligibility window using capped exponential backoff. A probe attempts all 14 candidates, reconciling the 10 valid minutes, instead of repeatedly attempting only four. Recovery succeeds on the fifth attempt after four failures in one process. Header/body request deadlines, cancellation, bounded shutdown and callback isolation are regression-tested.
2. **Quality-event lifetime capacity:** linked retention removes expired bars and evidence together. Capacity counts retained rows, while event IDs remain monotonic. Crossing/open quality intervals are preserved, old input cannot revive deleted history, and expired HTTP queries return 410. Twenty simulated minutes progress with a six-row capacity and two-minute history; overflow inside the retained window still produces a visible durable fault. A capacity-faulted file can reopen for reads without allocating another normal quality row.

Final acceptance: Windows exact ZIP extraction 80 pass / 1 environment-dependent skip; Linux final source 81 pass / 0 skip including real ENOSPC; both typecheck and real HTTP demo pass. The report groups all 81 cases and states remaining limits. No new material defect was identified by the scoped independent review. These checks do not certify production readiness or market completeness beyond the venue history.

The candidate's edits to the report were retained. Its final filename is `REPORT.md`; all current documentation links and the package allowlist use that spelling. `HANDOFF.md` is intentionally excluded. A remaining personal path in an older transcript was redacted, including the forward-slash path variant in the exporter.
