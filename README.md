# Pump.fun Paper Sprint bot — launch sniper with a rug filter

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rungkad1111/pumpfun-paper-sprint/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rungkad1111/pumpfun-paper-sprint/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's Pump.fun Paper Sprint
(`u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`). It replays 6 hours
of real pump.fun bonding-curve data and ranks entries by net PnL.

## Strategy

A launch sniper with a rug filter, tuned on the kit's frozen dev window for
robustness rather than raw dev PnL:

- Watch every coin from its `CreateEvent`. Buy only launches that have
  already shown at least 3 trades (a launch with no early tape is usually an
  instant dump), with a small creator buy (<= 2.5 SOL), at most 3 distinct
  non-creator buyers in the opening tape (a launch bundled by many wallets is
  a dump waiting to happen), no creator sell, and no big early sell.
- First buy is 0.1 SOL. Pyramid once: add another 0.1 SOL when the price is
  10% above the first buy's decision price, so false starts cost little and
  runners get size.
- Exit whole on the first of: +25% take-profit, -8% stop-loss, or a 25-slot
  hold limit. Exit at once when the creator sells while holding.
- Deterministic by construction: no clock, no randomness, iteration only over
  insertion-ordered maps fed by the batch stream, so two runs produce
  byte-identical action logs.

## Files

- `main.ts` — entrypoint: runs the strategy through the vendored SDK shim.
- `strategy.ts` — the strategy (entry filter, pyramid adds, exits).
- `vendor/agentfun-bot.ts` — the kit's SDK shim, vendored byte for byte.

Run it as the grader does:

```
node main.ts
```
