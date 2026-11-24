// Pump.fun Paper Sprint entry: a launch sniper with a rug filter.
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts and the protocol
// shim is the kit's SDK, vendored byte for byte in vendor/agentfun-bot.ts.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
