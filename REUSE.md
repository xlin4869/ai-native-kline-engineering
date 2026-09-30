# Reused components and sources

The service code, reducer, oracle and fixtures were written for this assignment with AI assistance. No source code was copied from the existing private quant-platform repository into this project. Its K-line WebSocket lifecycle tests and market-data gap/Decimal practices informed the failure cases, but that code consumes exchange klines or different data and was not treated as a raw-trade aggregation implementation.

| Component | Locked version | License | Source and use |
| --- | --- | --- | --- |
| Node.js standard library, including experimental `node:sqlite` and the built-in `WebSocket` client | 22.16.0 tested | Node.js license | [Node SQLite API](https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html); local transactions, HTTP/process utilities, the optional Binance stream client, and the `JSON.parse` reviver `context.source` used to keep trade IDs exact. |
| `decimal.js` | 10.6.0 | MIT | [MikeMcl/decimal.js](https://github.com/MikeMcl/decimal.js); exact production decimal arithmetic with a private clone. |
| `typescript` | 5.8.3 | Apache-2.0 | [microsoft/TypeScript](https://github.com/microsoft/TypeScript); typecheck only. |
| `tsx` | 4.20.3 | MIT | [privatenumber/tsx](https://github.com/privatenumber/tsx); run TypeScript directly in local evaluation. |
| `@types/node` | 22.15.30 | MIT | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped); Node type definitions. |
| `fflate` | 0.8.3 | MIT | [101arrowz/fflate](https://github.com/101arrowz/fflate); ZIP packaging and extraction check. Upgraded from 0.8.2 after `npm audit` found a malformed-ZIP64 denial-of-service advisory. |

Specifications used, not code: Binance Spot API documentation, [binance/binance-spot-api-docs](https://github.com/binance/binance-spot-api-docs) `web-socket-streams.md` (Trade Streams, general WSS rules, `serverShutdown`, limits) and `rest-api.md` (`GET /api/v3/klines` field order; `GET /api/v3/aggTrades` fields `a p q f l T` and paging by `fromId`), master at commit 828ca74 dated 2026-09-18. `fixtures/binance/btcusdt-capture.json` is public market data recorded from `wss://data-stream.binance.vision` and `https://data-api.binance.vision` on 2026-09-25. Its `aggTrades` history for the same minutes was fetched on 2026-09-25 from the same endpoint. Rounds 2 and 3 added no dependency.

`package-lock.json` is the exact dependency graph. ZIP input is a fixed allowlist. No Redis, Docker, Binance SDK or copied platform source is required to evaluate the service; the Binance source uses no SDK.
