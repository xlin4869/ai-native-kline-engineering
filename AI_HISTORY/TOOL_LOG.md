# Curated tool and decision log

This is a factual index to technical tool activity, not a replacement for the timestamped chat transcripts. Raw tool outputs were not copied into the external package because they contain unrelated repository/environment information.

| Step | Tool / command | Observation and action |
| --- | --- | --- |
| Existing-code investigation | `rg`, project manifest/feature index, read-only Agent Launch | Existing platform consumes exchange `@kline` and REST aggregate trades; no directly reusable raw-trade→1m reducer was found in the searched surfaces. The initial natural-language launch was advisory only; a structured standalone package later received a Workcell start. |
| Dependency check | `npm install`, `npm run typecheck`, `node --import tsx --test` | Runtime aggregate golden test passed; TypeScript rejected the default `decimal.js` import under NodeNext. Named import fixed the typecheck. |
| First core verification | `npm test -- --suite=core` | Golden, exact ordering, identity, late boundaries, queue, quality and independent BigInt oracle passed. |
| Consumer verification | `npm test -- --suite=api`, `npm run demo` | Real HTTP queries produced the hand-calculated bar and the standalone fetch consumer read it. |
| File recovery | `npm test -- --suite=recovery` | First run exposed an SQLite handle leaked by semantic-config mismatch; constructor error cleanup was fixed. Actual child kills before and after COMMIT then passed, as did clean/unclean gap tests. |
| Dependency audit | `npm audit --json`, `npm install --save-dev fflate@0.8.3` | Advisory GHSA-px8p-9vwx-vf98 affected initial fflate 0.8.2; lockfile was upgraded. npm reported zero vulnerabilities after installation. |
| Load-sensitive test run | Concurrent `npm test`, demo and typecheck | One 10-second child startup and the 15-second demo watchdog timed out under parallel process load; independent reruns passed. Test files were then run sequentially, and full tests passed. This failed run is retained in the process record. |
| Expanded verification | `npm test`, focused core/API/recovery suites, `npm run typecheck`, `npm run demo` | 37/37 full tests passed after adding truth-missing, HTTP slow/overflow, pagination, scenario-identity and recovery cases. Earlier focused core/API/recovery suites also passed. Final full ZIP suite is still the decisive check. |
| Bounded load observation | `npm run benchmark -- --events=5000 --seed=20260925 --storage=memory`; file mode with 2,000 events | Measured in-process throughput only; exact numbers and machine conditions are in `results/verification.md`. |
| Archive validation | `npm run package`, `npm run check:package -- --archive=dist/trade-kline-service.zip` | A preliminary ZIP was extracted into a fresh temp directory; `npm ci`, typecheck, 26 tests at that time and demo passed. Final archive will be rechecked after the expanded tests/history/record are frozen. |
