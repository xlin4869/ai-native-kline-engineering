// Real OS disk exhaustion. Runs only when TKS_ENOSPC_DIR points at a small dedicated filesystem, e.g.
//   docker run --tmpfs /enospc:size=1m -e TKS_ENOSPC_DIR=/enospc ...
// Elsewhere it is reported as skipped, never as passed.
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { VirtualClock } from '../src/clock.js';
import { Coordinator } from '../src/coordinator.js';
import { DEFAULT_CONFIG } from '../src/contracts.js';
import { SqliteStore } from '../src/sqlite-store.js';
import { M, trade } from './support.js';

const dir = process.env.TKS_ENOSPC_DIR;

test('a real ENOSPC keeps the committed prefix readable, latches the cause and refuses intake',
  { skip: dir ? false : 'set TKS_ENOSPC_DIR to a small dedicated filesystem to run' }, async () => {
    const path = join(dir!, `enospc-${process.pid}.db`);
    const config = { ...DEFAULT_CONFIG, dbPath: path };
    const store = new SqliteStore(config);
    const coordinator = new Coordinator(store, new VirtualClock(M - 10_000), config);
    try {
      coordinator.enqueueSource('connected', M - 10_000); await coordinator.drain();
      let i = 0;
      // Distinct minutes add bar rows as well as identities, so the file keeps growing until the filesystem is full.
      for (; i < 200_000 && !coordinator.writerFault; i++) {
        const offset = Math.floor(i / 50) * 60_000 + (i % 50) * 100;
        if (!coordinator.enqueueTrade(trade(String(i + 1), offset, '100.123456789', '0.000001'), M + offset + 1)) break;
        await coordinator.drain();
      }
      assert.match(coordinator.writerFault ?? '', /full|disk|space|I\/O/i, `fault after ${i} trades: ${coordinator.writerFault}`);
      const accepted = coordinator.decisions.filter(x => x.kind === 'accepted').length;
      // WAL mode appends several pages per commit, so a 1 MB filesystem fills after a few dozen trades.
      assert.ok(accepted >= 10, `accepted ${accepted} before the disk filled`);
      const lastMinute = Math.floor((accepted - 1) / 50) * 60_000;
      const tail = store.bars('BTCUSDT', M + lastMinute, M + lastMinute + 60_000, 1).bars[0]!;
      assert.equal(tail.quality.completeness, 'known_incomplete', 'the refused delivery is a known loss');
      assert.ok(tail.quality.reasons.includes('writer_fault'));
      const total = store.bars('BTCUSDT', M, M + lastMinute + 60_000, 1_000).bars.reduce((sum, bar) => sum + bar.tradeCount, 0);
      assert.equal(total, accepted, 'every committed trade is still readable');
      assert.equal(coordinator.enqueueTrade(trade('999999999', lastMinute + 59_000), M + lastMinute + 59_001), false);
      process.stdout.write(`# enospc ${JSON.stringify({ accepted, fault: coordinator.writerFault })}\n`);
    } finally {
      try { store.close(); } catch { /* closing may itself need space */ }
      for (const name of readdirSync(dir!)) if (name.startsWith(`enospc-${process.pid}.db`)) rmSync(join(dir!, name), { force: true });
    }
  });
