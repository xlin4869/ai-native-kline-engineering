import type { Trade } from './contracts.js';
import type { MockAction, Scenario } from './mock-source.js';

/**
 * What the simulated network did with one true trade. Only `silent_loss` is invisible to the service by design;
 * every other non-delivery happens while the service can observe it (disconnect, pre-start, late, skew, conflict).
 */
export type Fate = 'delivered' | 'silent_loss' | 'not_connected' | 'late_delivery' | 'skewed_delivery' | 'conflict_first';

export interface GeneratorOptions {
  seed: number;
  startMs: number;             // service start (virtual clock); the market starts two minutes earlier
  minutes?: number;            // simulated market minutes after the start
  symbols?: string[];
  tradesPerMinute?: number;    // mean per symbol
  sameMsRate?: number;         // probability that the next trade shares the previous millisecond
  duplicateRate?: number;      // equivalent-decimal resend of a delivered trade
  silentLossRate?: number;     // dropped while connected, with no signal
  lateRate?: number;           // delivered 2.5-10 s after its minute ended
  skewRate?: number;           // receive clock behind exchange: delivered 0.5-7 s before trade time
  conflictRate?: number;       // same ID with a different price, sometimes arriving first
  disconnects?: number;        // disconnect windows of 0.3-8 s
  edgeProbes?: boolean;        // default true: ID digit-crossing tie at a close, deadline -1/0, in-grace disconnect
  probeGraceMs?: number;       // grace the deadline probes target (service default 2 s)
}

/** Ground truth for tests: the planned receive time of every attempt, including ones a disconnect swallowed. */
export interface Plan { fate: Fate; attempts: number[] }
export interface GeneratedScenario extends Scenario { plans: Record<string, Plan> }

const MINUTE = 60_000;
const START_PRICE_CENTS: Record<string, number> = { BTCUSDT: 8_459_409, ETHUSDT: 320_000 };
// BTC IDs cross from 10 to 11 digits inside the run, so lexical ID ordering would be caught.
const FIRST_TRADE_ID: Record<string, bigint> = { BTCUSDT: 9_999_999_900n, ETHUSDT: 2_000_000_000n };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const cents = (value: number) => `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
const lots = (value: number) => `0.${String(value).padStart(5, '0')}`;
const equivalent = (decimal: string) => decimal.includes('.') ? `${decimal}0` : `${decimal}.0`;
const key = (trade: Trade) => `${trade.symbol}|${trade.tradeId}`;

export function generateScenario(options: GeneratorOptions): GeneratedScenario {
  const { seed, startMs } = options;
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(startMs) || startMs < 2 * MINUTE) throw new Error('invalid seed or startMs');
  const minutes = options.minutes ?? 5;
  const symbols = options.symbols ?? ['BTCUSDT', 'ETHUSDT'];
  const rate = options.tradesPerMinute ?? 40;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120 || rate <= 0 || rate > 2_000) throw new Error('invalid minutes or rate');
  const random = mulberry32(seed);
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));

  const marketStart = startMs - 2 * MINUTE;
  const marketEnd = startMs + minutes * MINUTE;
  const endAt = Math.floor(marketEnd / MINUTE) * MINUTE + MINUTE + 10_000; // past every deadline (grace <= 10 s)

  // Times and prices first; IDs afterwards, increasing with time as on the exchange.
  type Draft = { t: number; price: number; quantity: string };
  const drafts = new Map<string, Draft[]>();
  for (const symbol of symbols) {
    const list: Draft[] = []; let t = marketStart; let price = START_PRICE_CENTS[symbol] ?? 100_000;
    for (;;) {
      if (random() >= (options.sameMsRate ?? 0.15)) t += Math.max(1, Math.round(-Math.log(1 - random()) * MINUTE / rate));
      if (t >= marketEnd) break;
      price = Math.max(1, price + between(-50, 50));
      list.push({ t, price, quantity: lots(between(1, 99_999)) });
    }
    drafts.set(symbol, list);
  }

  // Edge probes: realistic events placed exactly on boundaries that uniform random data almost never hits.
  // They target the service's documented default grace (probeGraceMs) and use the first symbol only.
  const forced = new Map<Draft, { atMs: number; fate: Fate }>();
  const windows: Array<[number, number]> = [];
  let idCrossing: Draft | null = null;
  const probeList = drafts.get(symbols[0]!) ?? [];
  const firstFull = Math.ceil(startMs / MINUTE) * MINUTE;
  const lastTwo = (open: number) => open + MINUTE <= marketEnd ? probeList.filter(d => d.t >= open && d.t < open + MINUTE).slice(-2) : [];
  if (options.edgeProbes !== false) {
    const grace = options.probeGraceMs ?? 2_000;
    const [a0, a1] = lastTwo(firstFull); // (a) same-ms pair at the close; IDs cross a digit-length boundary
    if (a0 && a1) {
      a0.t = a1.t = firstFull + MINUTE - 1; a1.price = a0.price + 7; idCrossing = a1;
      forced.set(a0, { atMs: a0.t + 100, fate: 'delivered' }); forced.set(a1, { atMs: a1.t + 150, fate: 'delivered' });
    }
    const [b0, b1] = lastTwo(firstFull + MINUTE); // (b) deadline - 1 ms is admitted, the deadline itself is late
    if (b0 && b1) {
      const deadline = firstFull + 2 * MINUTE + grace;
      forced.set(b0, { atMs: deadline - 1, fate: 'delivered' }); forced.set(b1, { atMs: deadline, fate: 'late_delivery' });
    }
    const [c0, c1] = lastTwo(firstFull + 2 * MINUTE); // (c) a disconnect lying only inside the grace period
    if (c0 && c1 && grace >= 1_000) {
      const end = firstFull + 3 * MINUTE;
      windows.push([end + 300, end + grace - 300]);
      forced.set(c0, { atMs: end + 400, fate: 'delivered' }); forced.set(c1, { atMs: end + 500, fate: 'delivered' });
    }
  }

  const truth: Trade[] = [];
  const forcedByKey = new Map<string, { atMs: number; fate: Fate }>();
  for (const symbol of symbols) {
    const list = drafts.get(symbol)!;
    const crossingIndex = idCrossing ? list.indexOf(idCrossing) : -1;
    let id = crossingIndex > 0 ? 10_000_000_000n - BigInt(crossingIndex) : FIRST_TRADE_ID[symbol] ?? 1_000_000n;
    for (const draft of list) {
      const trade: Trade = { venue: 'mock', market: 'spot', symbol, tradeId: String(id++), eventTimeMs: draft.t, price: cents(draft.price), quantity: draft.quantity };
      truth.push(trade);
      const plan = forced.get(draft);
      if (plan) forcedByKey.set(key(trade), plan);
    }
  }

  const connectAt = random() < 0.5 ? startMs : startMs + between(1, 3_000);
  for (let i = 0; i < (options.disconnects ?? 2); i++) {
    const from = between(connectAt + 5_000, marketEnd);
    windows.push([from, from + between(300, 8_000)]);
  }
  windows.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const window of windows) {
    const last = merged.at(-1);
    if (last && window[0] <= last[1]) last[1] = Math.max(last[1], window[1]); else merged.push([...window]);
  }
  const connectedAt = (at: number) => at >= connectAt && at < endAt && !merged.some(([from, to]) => at >= from && at < to);

  type Item = { atMs: number; rank: number; order: number; action: MockAction };
  const items: Item[] = [];
  let order = 0;
  const push = (action: MockAction, rank: number) => items.push({ atMs: action.atMs, rank, order: order++, action });
  const deliver = (trade: Trade, atMs: number) => { if (connectedAt(atMs)) push({ kind: 'trade', atMs, trade }, 1); return connectedAt(atMs); };

  const plans: Record<string, Plan> = {};
  const silent = options.silentLossRate ?? 0.01, late = options.lateRate ?? 0.01, skew = options.skewRate ?? 0.02;
  for (const trade of truth) {
    const probe = forcedByKey.get(key(trade));
    if (probe) {
      plans[key(trade)] = { fate: deliver(trade, probe.atMs) ? probe.fate : 'not_connected', attempts: [probe.atMs] };
      continue;
    }
    const minuteEnd = Math.floor(trade.eventTimeMs / MINUTE) * MINUTE + MINUTE;
    const roll = random();
    let fate: Fate; let atMs: number;
    if (roll < silent) { plans[key(trade)] = { fate: 'silent_loss', attempts: [] }; continue; }
    else if (roll < silent + late) { fate = 'late_delivery'; atMs = minuteEnd + between(2_500, 10_000); }
    else if (roll < silent + late + skew) { fate = 'skewed_delivery'; atMs = trade.eventTimeMs - between(500, 7_000); }
    else { fate = 'delivered'; atMs = trade.eventTimeMs + between(20, 400) + (random() < 0.1 ? between(0, 1_500) : 0); }
    const attempts = [atMs];
    // A conflicting twin is only sent alongside a delivered original, so the pair stays observable.
    if (random() < (options.conflictRate ?? 0.005) && connectedAt(atMs)) {
      const conflictAt = atMs + between(-300, 300);
      if (deliver({ ...trade, price: cents(Math.round(Number(trade.price) * 100) + 1) }, conflictAt) && conflictAt < atMs) fate = 'conflict_first';
    }
    if (!deliver(trade, atMs)) fate = 'not_connected';
    if (random() < (options.duplicateRate ?? 0.05)) {
      const duplicateAt = atMs + between(0, 3_000);
      attempts.push(duplicateAt);
      deliver({ ...trade, price: equivalent(trade.price), quantity: equivalent(trade.quantity) }, duplicateAt);
    }
    plans[key(trade)] = { fate, attempts };
  }

  push({ kind: 'source', atMs: connectAt, state: 'connected' }, 0);
  for (const [from, to] of merged) {
    if (from >= endAt) continue;
    push({ kind: 'source', atMs: from, state: 'disconnected' }, 0);
    if (to < endAt) push({ kind: 'source', atMs: to, state: 'connected' }, 0);
  }
  for (let at = startMs + 5_000; at < endAt; at += 5_000) push({ kind: 'advance', atMs: at }, 2);
  push({ kind: 'advance', atMs: endAt }, 3);
  push({ kind: 'source', atMs: endAt, state: 'stopped' }, 3);
  items.sort((a, b) => a.atMs - b.atMs || a.rank - b.rank || a.order - b.order);
  const actions = items.filter(item => item.atMs >= startMs).map(item => item.action);
  return { name: `generated-seed-${seed}`, startMs, truth, actions, plans };
}
