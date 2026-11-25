// Tiny Bot: dip-buy mean reversion, long only, for agent-fun/bars-replay/v1
// (hourly Solana bars, 10,000 USDC paper capital).
//
// The idea: a sharp 6-hour drop (under -3%) usually overdoes it on these
// hourly bars, so buy the dip and bank a small bounce: take profit at
// +2.5% over cost, cut at -3%. Small, frequent, capped losses. A momentum
// rider was tried first and dropped: on the dev window it bought dead-cat
// bounces a bar late, then kept falling (hybrid scored -631 USDC; dip-only
// scored +120 USDC on the same window, 34 trades, max drawdown 3.8%,
// against buy-and-hold -869 USDC). The bot stays mostly in cash during a
// falling market and still clears the 8-trade guardrail even in a calm
// 72-bar window (10 trades in the dev window's calm second half).
//
// Sizing: one equal slice of equity per symbol (equity / 7), never over the
// 25% per-symbol weight cap, never spending cash a sell in the same reply
// has not settled yet. Every order caps slippage at 100 bps past the close
// it was decided on, so a fill into a liquidity gap is refused and the
// signal is simply re-sent on the next bar while it still holds.
// Deterministic: float64 arithmetic on closes only, no clock, no random.

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOLS = 7;
const DIP_BARS = 6;
const DIP_ENTRY = -0.03; // 6h return under -3% -> buy the dip
const DIP_TAKE = 0.025; // +2.5% over cost -> take profit
const DIP_STOP = -0.03; // -3% under cost -> cut
const MAX_SLIPPAGE_BPS = 100;

/** Per-symbol close history (last 64 closes). */
interface Track {
  closes: number[];
}

const tracks = new Map<string, Track>();

function track(symbol: string): Track {
  let t = tracks.get(symbol);
  if (t === undefined) {
    t = { closes: [] };
    tracks.set(symbol, t);
  }
  return t;
}

/** The return over the last `n` closes, or null before enough history. */
function retOver(t: Track, n: number): number | null {
  const c = t.closes;
  if (c.length <= n) return null;
  return c[c.length - 1] / c[c.length - 1 - n] - 1;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      const t = track(bar.symbol);
      t.closes.push(Number(bar.c));
      if (t.closes.length > 64) t.closes.shift();
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const orders: (SellInput | BuyInput)[] = [];
    const slots = Math.min(SYMBOLS, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    let cash = state.cash;
    let room = slots - state.positions.size;

    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const t = tracks.get(symbol)!;
      const held = state.positions.get(symbol);
      const r6 = retOver(t, DIP_BARS);

      if (held !== undefined) {
        // Take profit or cut the loss. A sell the market refuses is simply
        // re-sent on the next bar while its condition still holds.
        const value = state.value(symbol, held.qty);
        const ret = Number(value) / Number(held.cost) - 1;
        if (ret >= DIP_TAKE || ret <= DIP_STOP) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }

      // No position: look for an entry. Zero-volume bars carry no signal.
      const bar = batch.bars.find((b) => b.symbol === symbol)!;
      if (bar.v === '0' || r6 === null) continue;
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) continue;
      if (r6 >= DIP_ENTRY) continue;
      let slice = stake;
      const byWeight = state.weightRoom(symbol);
      if (byWeight < slice) slice = byWeight;
      if (cash < slice) slice = cash;
      if (slice <= 0n || slice < BigInt(fees.min_notional_quote_units)) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
