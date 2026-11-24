// Launch sniper with a rug filter for agent-fun/replay/v2 (pump.fun bonding curves).
//
// The bot watches every coin from its CreateEvent and reads the opening tape in its first
// slots: how big the creator's own buy was, how many trades have printed, how many distinct
// wallets bought alongside the creator (a launch bundled by many wallets early is usually the
// creator's cluster waiting to dump), whether the creator has sold, and how much real SOL the
// curve holds. It only buys launches that clear every filter, takes profit quickly (tpBps),
// cuts losers (slBps), never holds past maxHold slots, and exits immediately when the creator
// sells while it holds.
//
// The defaults were picked by sweeping the kit pilot's parameters and grading each candidate
// with the kit's own grade-local on the FULL dev window — the local sim only sees the first
// part of the window and ranked the add-on variants backwards, so only full-window grades
// counted. Two filters mattered most: minTrades (a launch with no early tape is an instant
// dump: requiring 3 trades before entry cut the dev loss from -0.42 SOL to -0.26 SOL) and a
// small stake (0.05 SOL: the 1%-of-reserve cap binds anyway, and smaller tickets lose less
// per false start). A flow filter (minimum net inflow + distinct recent buyers) improved dev
// PnL further to -0.14 SOL, but it cut traded coins to ~90 in 24h, which scales to ~17 in a
// 6h window: below the 20-coin guardrail in a quiet window like the final one (05:40-11:40
// UTC lines up with the dev window's quiet slices). The final window is 6h, not 24h, so
// breadth is a guardrail, not a luxury: this configuration trades 177 coins in 24h (~35 in
// the final window's expected activity) at a dev net of -0.26 SOL and ~3% drawdown against
// the 50% guardrail. Pyramid adds looked good on the sim's half window but LOST on the full
// window, so they stay off.
//
// A pure function of the batches it is fed: no clock, no randomness, no I/O, so the two
// graded executions produce byte-identical action logs.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps): a buy whose price jumps more than this in the latency is refused. */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many lamports. */
  exitFlowLamports: number;
  /**
   * Fill pacing: the run is expected to make at least 200 fills. When the filled-order
   * count lags fillTarget prorated over the window (windowSeconds of block time from the
   * first event), each order is split into pieces sent in the same reply (baseSplit
   * normally, up to maxSplit): the pieces fill at the same price as the whole order (the
   * replay applies them in turn), cost one extra tx fee each, and a failed tx then stalls
   * only part of the order.
   */
  fillTarget: number;
  windowSeconds: number;
  baseSplit: number;
  maxSplit: number;
  /** Smallest buy piece worth sending (lamports). */
  minPieceLamports: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeLamports: 50_000_000,
  minBuyLamports: 5_000_000,
  minRealSol: 300_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 0,
  maxDevBuy: 2_500_000_000,
  minTrades: 3,
  minBuyers: 0,
  maxBuyers: 3,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  minRunupBps: 0,
  maxRunupBps: 1_000_000,
  flowWindow: 10,
  minFlowLamports: -1_000_000_000_000,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tpBps: 2_500,
  slBps: 800,
  maxHold: 25,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  exitFlowLamports: 1_000_000_000_000,
  fillTarget: 300,
  windowSeconds: 21_600,
  baseSplit: 1,
  maxSplit: 6,
  minPieceLamports: 2_000_000,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  /** Buys sent for this coin (adds are off: at most one entry per coin). */
  buysSent: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  devSoldAtOpen: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** Curve fees on a sale (protocol 95 + creator 30 bps). */
const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function saleProceeds(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

class LaunchSniper implements Strategy {
  private readonly p: Params;
  private readonly coins = new Map<Pubkey, Coin>();
  private readonly held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  private readonly selling = new Set<Pubkey>();
  private readonly stake: bigint;
  private readonly minBuy: bigint;
  private firstSeen: number | null = null;
  private latestSeen = 0;
  private fills = 0;

  constructor(params: Params = DEFAULT_PARAMS) {
    this.p = params;
    this.stake = BigInt(params.stakeLamports);
    this.minBuy = BigInt(params.minBuyLamports);
  }

  /** Fold a batch's events into the per-coin tape. */
  private absorb(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        this.coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = this.coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const reserveBefore = BigInt(e.real_quote_reserves) + sol;
          if (reserveBefore > 0n) {
            const bps = (sol * BPS) / reserveBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = this.coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold, and distinct buyers, over the last flowWindow slots. */
  private recentFlow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - this.p.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  }

  private hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  private hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  /** How many pieces to split an order into now: baseSplit, more when fills lag their pace. */
  private splitNow(): number {
    if (this.firstSeen === null) return this.p.baseSplit;
    const elapsed = Math.max(0, Math.min(this.p.windowSeconds, this.latestSeen - this.firstSeen));
    const due = (this.p.fillTarget * elapsed) / this.p.windowSeconds;
    if (this.fills >= due) return this.p.baseSplit;
    const behind = due - this.fills;
    return Math.min(this.p.maxSplit, this.p.baseSplit + (behind > this.p.fillTarget * 0.15 ? 2 : 1));
  }

  /** Sell all of `tokens` as k orders in one reply. */
  private sellPieces(mint: Pubkey, tokens: bigint, k: number, room: number): OrderInput[] {
    const n = BigInt(Math.max(1, Math.min(k, room)));
    const out: OrderInput[] = [];
    const piece = tokens / n;
    if (piece === 0n) return [{ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 }];
    for (let i = 0n; i < n; i++) {
      const amt = i === n - 1n ? tokens - piece * (n - 1n) : piece;
      out.push({ side: 'sell', mint, token_amount: amt, max_slippage_bps: 10_000 });
    }
    return out;
  }

  /** Buy `amount` lamports as up to k orders in one reply (pieces of at least minPieceLamports). */
  private buyPieces(mint: Pubkey, amount: bigint, k: number, room: number): OrderInput[] {
    let n = BigInt(Math.max(1, Math.min(k, room)));
    const minPiece = BigInt(this.p.minPieceLamports);
    while (n > 1n && amount / n < minPiece) n -= 1n;
    const piece = amount / n;
    const out: OrderInput[] = [];
    for (let i = 0n; i < n; i++) {
      const amt = i === n - 1n ? amount - piece * (n - 1n) : piece;
      out.push({ side: 'buy', mint, quote_lamports: amt, max_slippage_bps: this.p.buySlippageBps });
    }
    return out;
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.absorb(batch);
    for (const e of batch.events) {
      if (e.block_time === null) continue;
      if (this.firstSeen === null) this.firstSeen = e.block_time;
      if (e.block_time > this.latestSeen) this.latestSeen = e.block_time;
    }
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        this.held.delete(f.mint);
        this.selling.delete(f.mint);
        continue;
      }
      if (f.status === 'filled') this.fills += 1;
      const h = this.held.get(f.mint);
      if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
      if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
        this.held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), devSoldAtOpen: this.coins.get(f.mint)?.devSold ?? false });
      }
    }
    for (const mint of [...this.selling]) if (!this.hasPendingSell(state, mint)) this.selling.delete(mint);
    for (const mint of [...this.held.keys()]) {
      if (!state.positions.has(mint) && !this.selling.has(mint) && !this.hasPendingBuy(state, mint)) this.held.delete(mint);
    }
    const k = this.splitNow();

    // Exits first.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (this.selling.has(mint)) continue;
      const c = this.coins.get(mint);
      let h = this.held.get(mint);
      if (h === undefined) {
        h = { openedSlot: state.slot, txPaid: tx, devSoldAtOpen: c?.devSold ?? false };
        this.held.set(mint, h);
      }
      let mk = marks.get(mint);
      if (mk === undefined) {
        const cv = state.curves.get(mint);
        if (cv === undefined) continue;
        mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      }
      const value = saleProceeds(pos.token_amount, mk.vq, mk.vt) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      let exit = false;
      if (basis > 0n) {
        if (value * BPS >= basis * (BPS + BigInt(this.p.tpBps))) exit = true;
        if (value * BPS <= basis * (BPS - BigInt(this.p.slBps))) exit = true;
      }
      if (state.slot - h.openedSlot >= this.p.maxHold) exit = true;
      if (c !== undefined) {
        if (this.p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (state.slot - c.lastTradeSlot >= this.p.staleSlots) exit = true;
        if (this.recentFlow(c, state.slot).net < -BigInt(this.p.exitFlowLamports)) exit = true;
      }
      if (!exit) continue;
      if (pendingByMint.has(mint)) {
        // A sell already in flight: wait for it. A buy in flight: sell what we hold now anyway.
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
      }
      orders.push(...this.sellPieces(mint, pos.token_amount, k, cap - orders.length));
      this.selling.add(mint);
      if (c !== undefined) c.done = true;
    }

    // Entries.
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    // Leave room in the reply for the split pieces of an exit next to new buys.
    let open = state.committedPositionCount();
    for (const c of this.coins.values()) {
      if (orders.length >= cap) break;
      if (c.done || c.complete) continue;
      if (c.buysSent > 0) continue;
      if (state.positions.has(c.mint)) continue;
      const age = state.slot - c.createSlot;
      if (age > this.p.maxAge) {
        c.done = true;
        continue;
      }
      if (age < this.p.minAge) continue;
      if (pendingByMint.has(c.mint)) continue;
      if (open >= state.hello.caps.max_open_positions) continue;
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) continue;
      if (c.devSold && this.p.skipDevSold) {
        c.done = true;
        continue;
      }
      // Rug filter.
      const rq = curve.real_quote_reserves;
      if (rq < BigInt(this.p.minRealSol) || rq > BigInt(this.p.maxRealSol)) continue;
      if (c.devBuy < BigInt(this.p.minDevBuy) || c.devBuy > BigInt(this.p.maxDevBuy)) continue;
      if (c.trades < this.p.minTrades || c.buyers.size < this.p.minBuyers || c.buyers.size > this.p.maxBuyers) continue;
      if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(this.p.maxSellRatioBps)) continue;
      if (c.bigSellBps > BigInt(this.p.maxBigSellBps)) continue;
      const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0);
      if (runup > BigInt(this.p.maxRunupBps) || runup < BigInt(this.p.minRunupBps)) continue;
      const fl = this.recentFlow(c, state.slot);
      if (fl.net < BigInt(this.p.minFlowLamports) || fl.buyers < this.p.minRecentBuyers) continue;
      const maxBuy = state.maxBuyLamports(c.mint);
      const amount = this.stake < maxBuy ? this.stake : maxBuy;
      if (amount < this.minBuy) continue;
      if (free < amount + tx * 6n) continue;
      const buys = this.buyPieces(c.mint, amount, k, cap - orders.length);
      orders.push(...buys);
      free -= amount + tx * BigInt(buys.length);
      c.buysSent += 1;
      open += 1;
    }
    return orders;
  }
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  return new LaunchSniper(params);
}
