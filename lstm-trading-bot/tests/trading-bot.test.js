import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWallet } from '../wallet.js';
import {
    expectedChangePct, decideSignal, parseBotConfig, createBot, checkRiskExit, benchmarkEquity,
    nextAdaptiveThreshold, initialAdaptiveThreshold, ADAPTIVE_MIN_SAMPLES, ADAPTIVE_ETA, THETA_MIN_PCT, THETA_MAX_PCT,
} from '../trading-bot.js';

// Fee, risk exits and the MAPE gate are off so the Task 3 tests keep their exact arithmetic; the threshold stays fixed.
const DEFAULTS = { thresholdMode: 'fixed', targetTradesPerMin: 3, thresholdPct: 0.01, buyPct: 50, sellPct: 100, feePct: 0, stopLossPct: 0, takeProfitPct: 0, mapeGate: false };
const closeTo = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} !~ ${expected}`);
const cashWallet = createWallet();
const btcWallet = { ...createWallet(), usdt: 0, btc: 1 };

// Builds decideSignal arguments with sensible defaults.
const signalFor = (changePct, wallet, extra = {}) =>
    decideSignal({ changePct, thresholdPct: 0.01, wallet, price: 100, buyFraction: 0.5, ...extra });

test('expectedChangePct computes percent change', () => {
    closeTo(expectedChangePct(100.02, 100), 0.02);
});

test('decideSignal applies threshold and holdings', () => {
    assert.equal(signalFor(0.02, cashWallet), 'BUY');
    assert.equal(signalFor(-0.02, btcWallet), 'SELL');
    assert.equal(signalFor(-0.02, cashWallet), 'HOLD');
    assert.equal(signalFor(0.005, cashWallet), 'HOLD');
});

test('dust USDT below the minimum order holds (Review Focus 1)', () => {
    assert.equal(signalFor(0.02, { ...cashWallet, usdt: 15 }), 'HOLD');
});

test('repeated 50% buys eventually stop (Review Focus 1)', () => {
    const bot = createBot({ config: DEFAULTS, wallet: createWallet() });
    bot.start();
    let buys = 0;
    for (let time = 1; time <= 40; time++) {
        const result = bot.onClosedCandle({ time, lastClose: 100, forecastNext: 101 });
        if (result.signal === 'BUY') buys++;
    }
    assert.ok(buys < 40);
    assert.ok(bot.state.wallet.usdt < 20);
});

test('parseBotConfig rejects invalid fields (Review Focus 2)', () => {
    assert.deepEqual(parseBotConfig({ thresholdPct: '', buyPct: '-5', sellPct: '150' }, DEFAULTS), DEFAULTS);
    assert.equal(parseBotConfig({ thresholdPct: '0.05' }, DEFAULTS).thresholdPct, 0.05);
    assert.deepEqual(parseBotConfig({ thresholdPct: 'abc', buyPct: 'NaN', sellPct: '0' }, DEFAULTS), DEFAULTS);
});

test('stopped bot returns null', () => {
    const bot = createBot({ config: DEFAULTS, wallet: createWallet() });
    assert.equal(bot.onClosedCandle({ time: 1, lastClose: 100, forecastNext: 101 }), null);
});

test('same candle time is evaluated once (Review Focus 4)', () => {
    const bot = createBot({ config: DEFAULTS, wallet: createWallet() });
    bot.start();
    const first = bot.onClosedCandle({ time: 5, lastClose: 100, forecastNext: 101 });
    assert.ok(first);
    assert.equal(bot.onClosedCandle({ time: 5, lastClose: 100, forecastNext: 101 }), null);
    assert.equal(bot.state.trades.length, 1);
});

test('BUY trade is recorded with change and balances; reset restores', () => {
    const bot = createBot({ config: DEFAULTS, wallet: createWallet() });
    bot.start();
    const { signal, trade } = bot.onClosedCandle({ time: 1, lastClose: 100, forecastNext: 101 });
    assert.equal(signal, 'BUY');
    closeTo(trade.changePct, 1);
    closeTo(trade.usdtAfter, 5000);
    closeTo(trade.btcAfter, 50);
    assert.equal(bot.state.trades.length, 1);
    bot.reset();
    assert.equal(bot.state.wallet.usdt, 10000);
    assert.equal(bot.state.trades.length, 0);
    assert.equal(bot.state.running, false);
});

test('changePct equal to the threshold holds (strict inequality)', () => {
    assert.equal(signalFor(0.01, cashWallet), 'HOLD');
    assert.equal(signalFor(-0.01, btcWallet), 'HOLD');
});

test('SELL dust check uses the sell fraction', () => {
    const wallet = { ...createWallet(), usdt: 0, btc: 0.15 };
    assert.equal(signalFor(-0.02, wallet), 'SELL');
    assert.equal(signalFor(-0.02, wallet, { sellFraction: 1 }), 'SELL');
    assert.equal(signalFor(-0.02, wallet, { sellFraction: 0.5 }), 'HOLD');
});

test('fee of 0.1% on a 5000 USDT buy is 5 and btc is 4995/50000', () => {
    const bot = createBot({ config: { ...DEFAULTS, feePct: 0.1 }, wallet: createWallet() });
    bot.start();
    const { trade } = bot.onClosedCandle({ time: 1, lastClose: 50000, forecastNext: 50050 });
    assert.equal(trade.fee, 5);
    assert.equal(trade.reason, 'SIGNAL');
    closeTo(bot.state.wallet.btc, 4995 / 50000, 1e-9);
});

test('checkRiskExit triggers stop-loss, take-profit or nothing', () => {
    const wallet = { ...createWallet(), usdt: 0, btc: 1, avgEntry: 100 };
    const exit = (price, stopLossPct = 0.5, takeProfitPct = 0.5) => checkRiskExit({ wallet, price, stopLossPct, takeProfitPct });
    assert.equal(exit(99.4), 'STOP_LOSS');
    assert.equal(exit(100.6), 'TAKE_PROFIT');
    assert.equal(exit(100.1), null);
    assert.equal(exit(99.4, 0, 0), null);
    assert.equal(exit(100.6, 0, 0), null);
    assert.equal(checkRiskExit({ wallet: createWallet(), price: 50, stopLossPct: 0.5, takeProfitPct: 0.5 }), null);
});

test('risk exit sells everything before the LSTM signal', () => {
    const config = { ...DEFAULTS, stopLossPct: 0.5, takeProfitPct: 0.5 };
    const bot = createBot({ config, wallet: createWallet() });
    bot.start();
    bot.onClosedCandle({ time: 1, lastClose: 100, forecastNext: 101 });
    // Forecast says BUY, but the price is 0.6% below entry: stop-loss wins.
    const { trade } = bot.onClosedCandle({ time: 2, lastClose: 99.4, forecastNext: 99.5 });
    assert.equal(trade.side, 'SELL');
    assert.equal(trade.reason, 'STOP_LOSS');
    assert.equal(bot.state.wallet.btc, 0);
    const takeProfitBot = createBot({ config, wallet: createWallet() });
    takeProfitBot.start();
    takeProfitBot.onClosedCandle({ time: 1, lastClose: 100, forecastNext: 101 });
    assert.equal(takeProfitBot.onClosedCandle({ time: 2, lastClose: 100.6, forecastNext: 100.7 }).trade.reason, 'TAKE_PROFIT');
});

test('MAPE gate turns BUY into HOLD while the LSTM is not beating the baseline', () => {
    const bot = createBot({ config: { ...DEFAULTS, mapeGate: true }, wallet: createWallet() });
    bot.start();
    const gated = bot.onClosedCandle({ time: 1, lastClose: 100, forecastNext: 101, mape: 0.02, baseMape: 0.01 });
    assert.equal(gated.signal, 'HOLD');
    assert.equal(gated.reason, 'MAPE_GATE');
    assert.equal(gated.trade, null);
    const open = bot.onClosedCandle({ time: 2, lastClose: 100, forecastNext: 101, mape: 0.005, baseMape: 0.01 });
    assert.equal(open.signal, 'BUY');
});

test('benchmarkEquity at +10% is (10000 - fee) * 1.1', () => {
    const bot = createBot({ config: { ...DEFAULTS, feePct: 0.1 }, wallet: createWallet() });
    bot.start(50000);
    assert.equal(bot.state.benchmark.startPrice, 50000);
    closeTo(benchmarkEquity(bot.state, 55000), (10000 - 10) * 1.1, 1e-6);
    bot.reset();
    assert.equal(bot.state.benchmark, null);
});

test('equityHistory gains one entry per evaluated candle and is capped at 1000', () => {
    const bot = createBot({ config: DEFAULTS, wallet: createWallet() });
    bot.start(100);
    bot.onClosedCandle({ time: 1, lastClose: 100, forecastNext: 100 });
    bot.onClosedCandle({ time: 1, lastClose: 100, forecastNext: 100 });
    assert.equal(bot.state.equityHistory.length, 1);
    for (let time = 2; time <= 1100; time++) bot.onClosedCandle({ time, lastClose: 100, forecastNext: 100 });
    assert.equal(bot.state.equityHistory.length, 1000);
    assert.deepEqual(Object.keys(bot.state.equityHistory[0]).sort(), ['benchmark', 'equity', 'time']);
});

test('parseBotConfig validates the new fields', () => {
    const parsed = parseBotConfig(
        { thresholdPct: '0.01', buyPct: '50', sellPct: '100', feePct: '0.2', stopLossPct: '-1', takeProfitPct: '0', mapeGate: true },
        { ...DEFAULTS, stopLossPct: 0.5 },
    );
    assert.equal(parsed.feePct, 0.2);
    assert.equal(parsed.stopLossPct, 0.5);
    assert.equal(parsed.takeProfitPct, 0);
    assert.equal(parsed.mapeGate, true);
});

test('SELL sells all BTC exactly', () => {
    const bot = createBot({ config: DEFAULTS, wallet: createWallet() });
    bot.start();
    bot.onClosedCandle({ time: 1, lastClose: 100, forecastNext: 101 });
    const { trade } = bot.onClosedCandle({ time: 2, lastClose: 100, forecastNext: 99 });
    assert.equal(trade.side, 'SELL');
    assert.equal(bot.state.wallet.btc, 0);
});

// ---- Adaptive threshold (trade-rate feedback controller) ----

const ADAPTIVE = { ...DEFAULTS, thresholdMode: 'adaptive', targetTradesPerMin: 3 };
// Builds a candle whose forecast change is `changePct` percent from a close of 100.
const candle = (time, changePct, extra = {}) => ({ time, lastClose: 100, forecastNext: 100 * (1 + changePct / 100), intervalMs: 1000, ...extra });
// Starts an adaptive bot and feeds it `count` candles of the same small change (all HOLD under the fixed 0.01%).
const warmedBot = (count, changePct = 0.001, config = ADAPTIVE) => {
    const bot = createBot({ config, wallet: createWallet() });
    bot.start();
    for (let time = 1; time <= count; time++) bot.onClosedCandle(candle(time, changePct));
    return bot;
};

test('adaptive constants', () => {
    assert.equal(ADAPTIVE_MIN_SAMPLES, 20);
    assert.equal(ADAPTIVE_ETA, 0.3);
    assert.equal(THETA_MIN_PCT, 0.00001);
    assert.equal(THETA_MAX_PCT, 1);
});

test('nextAdaptiveThreshold lowers theta without a trade and raises it after one', () => {
    closeTo(nextAdaptiveThreshold(0.01, 0, 3, 60), 0.01 * Math.exp(-0.015), 1e-12);
    closeTo(nextAdaptiveThreshold(0.01, 1, 3, 60), 0.01 * Math.exp(0.285), 1e-12);
});

test('nextAdaptiveThreshold clamps at both bounds', () => {
    assert.equal(nextAdaptiveThreshold(THETA_MIN_PCT, 0, 60, 60), THETA_MIN_PCT);
    assert.equal(nextAdaptiveThreshold(THETA_MAX_PCT, 1, 0.1, 60), THETA_MAX_PCT);
});

test('nextAdaptiveThreshold caps p at 1 when the target exceeds the candle rate', () => {
    closeTo(nextAdaptiveThreshold(0.01, 0, 3, 1), 0.01 * Math.exp(-0.3), 1e-12);
    closeTo(nextAdaptiveThreshold(0.01, 1, 3, 1), 0.01, 1e-12);
});

test('initialAdaptiveThreshold takes p90 of the warm-up samples or the fallback', () => {
    const samples = Array.from({ length: 20 }, (_, i) => i * 0.001);
    closeTo(initialAdaptiveThreshold(samples, 0.01), 0.018, 1e-12);
    assert.equal(initialAdaptiveThreshold(new Array(20).fill(0), 0.01), 0.01);
    assert.equal(samples[0], 0);
});

test('parseBotConfig validates thresholdMode and targetTradesPerMin (legacy targetSignalsPerMin accepted)', () => {
    assert.equal(parseBotConfig({ thresholdMode: 'bogus' }, ADAPTIVE).thresholdMode, 'adaptive');
    assert.equal(parseBotConfig({ thresholdMode: 'fixed' }, ADAPTIVE).thresholdMode, 'fixed');
    assert.equal(parseBotConfig({ thresholdMode: 'adaptive' }, DEFAULTS).thresholdMode, 'adaptive');
    for (const bad of ['0', '-1', '61', '', 'abc']) {
        assert.equal(parseBotConfig({ targetTradesPerMin: bad }, ADAPTIVE).targetTradesPerMin, 3, bad);
    }
    assert.equal(parseBotConfig({ targetTradesPerMin: '5' }, ADAPTIVE).targetTradesPerMin, 5);
    assert.equal(parseBotConfig({ targetTradesPerMin: '0.1' }, ADAPTIVE).targetTradesPerMin, 0.1);
    assert.equal(parseBotConfig({ targetTradesPerMin: '60' }, ADAPTIVE).targetTradesPerMin, 60);
    assert.equal(parseBotConfig({ targetSignalsPerMin: '4' }, ADAPTIVE).targetTradesPerMin, 4);
    assert.equal(parseBotConfig({ targetTradesPerMin: '5', targetSignalsPerMin: '4' }, ADAPTIVE).targetTradesPerMin, 5);
    assert.equal(parseBotConfig({}, { thresholdPct: 0.01 }).thresholdMode, 'adaptive');
    assert.equal(parseBotConfig({}, { thresholdPct: 0.01 }).targetTradesPerMin, 3);
    assert.equal(parseBotConfig({}, { thresholdPct: 0.01, targetSignalsPerMin: 5 }).targetTradesPerMin, 5);
});

test('the first 20 evaluated candles use the fixed threshold (warm-up), then theta is the p90 of the samples', () => {
    const bot = createBot({ config: ADAPTIVE, wallet: createWallet() });
    bot.start();
    // Each of the first 20 candles is a warm-up candle.
    for (let time = 1; time <= 20; time++) {
        bot.onClosedCandle(candle(time, 0.001));
        assert.equal(bot.state.lastThreshold.source, 'warmup', `candle ${time}`);
        assert.equal(bot.state.lastThreshold.pct, 0.01);
    }
    assert.equal(bot.state.trades.length, 0);
    assert.equal(bot.state.adaptiveThetaPct, null);
    // The 21st decides with theta = p90 of 20 samples of 0.001 -> 0.001; a 0.003 forecast beats it.
    const result = bot.onClosedCandle(candle(21, 0.003));
    assert.equal(bot.state.lastThreshold.source, 'adaptive');
    closeTo(bot.state.lastThreshold.pct, 0.001, 1e-9);
    assert.equal(result.signal, 'BUY');
    // A trade raises theta: 0.001 * exp(0.3 * (1 - 3/60)).
    closeTo(bot.state.adaptiveThetaPct, 0.001 * Math.exp(0.285), 1e-9);
});

test('adaptive BUY needs changePct strictly above theta; a hold lowers theta', () => {
    const bot = warmedBot(20, 0.001);
    assert.equal(bot.onClosedCandle(candle(21, 0.001)).signal, 'HOLD');
    closeTo(bot.state.adaptiveThetaPct, 0.001 * Math.exp(-0.015), 1e-9);
});

test('a risk exit counts as a trade for the controller', () => {
    const config = { ...ADAPTIVE, stopLossPct: 0.5 };
    const bot = warmedBot(20, 0.001, config);
    bot.onClosedCandle(candle(21, 0.003));
    const before = bot.state.adaptiveThetaPct;
    // Price 0.6% below the entry: stop-loss sells regardless of the forecast.
    const result = bot.onClosedCandle({ time: 22, lastClose: 99.4, forecastNext: 99.4, intervalMs: 1000 });
    assert.equal(result.reason, 'STOP_LOSS');
    closeTo(bot.state.adaptiveThetaPct, before * Math.exp(0.285), 1e-9);
});

test('the warm-up samples are capped at 20', () => {
    const bot = warmedBot(40, 0.001);
    assert.ok(bot.state.warmupAbsChanges.length <= ADAPTIVE_MIN_SAMPLES);
    assert.equal(bot.state.lastIntervalMs, 1000);
});

test('changing intervalMs goes back to warm-up', () => {
    const bot = warmedBot(25, 0.001);
    assert.equal(bot.state.lastThreshold.source, 'adaptive');
    bot.onClosedCandle(candle(26, 0.001, { intervalMs: 2000 }));
    assert.equal(bot.state.lastThreshold.source, 'warmup');
    assert.equal(bot.state.adaptiveThetaPct, null);
    assert.equal(bot.state.warmupAbsChanges.length, 1);
    assert.equal(bot.state.lastIntervalMs, 2000);
});

test('reset goes back to warm-up', () => {
    const bot = warmedBot(25, 0.001);
    bot.reset();
    assert.deepEqual(bot.state.warmupAbsChanges, []);
    assert.equal(bot.state.adaptiveThetaPct, null);
    assert.equal(bot.state.lastIntervalMs, null);
    assert.equal(bot.state.lastThreshold, null);
});

test('fixed mode ignores the controller', () => {
    const bot = warmedBot(30, 0.001, DEFAULTS);
    assert.equal(bot.state.lastThreshold.source, 'fixed');
    assert.equal(bot.state.lastThreshold.pct, 0.01);
    assert.deepEqual(bot.state.warmupAbsChanges, []);
    assert.equal(bot.state.adaptiveThetaPct, null);
});

test('a candle without intervalMs is treated as fixed mode', () => {
    const bot = createBot({ config: ADAPTIVE, wallet: createWallet() });
    bot.start();
    const result = bot.onClosedCandle({ time: 1, lastClose: 100, forecastNext: 100.005 });
    assert.equal(result.signal, 'HOLD');
    assert.equal(bot.state.lastThreshold.source, 'fixed');
    assert.deepEqual(bot.state.warmupAbsChanges, []);
});

// Seeded PRNG (mulberry32) so the simulation is reproducible.
const mulberry32 = (seed) => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Runs the real bot for 3600 1s candles on an AR(1) forecast-change series; returns trades per minute over the last 50 minutes.
const simulateTradesPerMinute = (bias) => {
    const random = mulberry32(42);
    // Standard normal sample via the Box-Muller transform.
    const gaussian = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    const bot = createBot({ config: ADAPTIVE, wallet: createWallet() });
    bot.start();
    let change = 0;
    let lastClose = 60000;
    const tradeTimes = [];
    for (let time = 1; time <= 3600; time++) {
        change = 0.8 * change + 0.0015 * gaussian() + bias * 0.2;
        lastClose *= 1 + 0.00002 * gaussian();
        const result = bot.onClosedCandle({ time, lastClose, forecastNext: lastClose * (1 + change / 100), intervalMs: 1000 });
        if (result.trade) tradeTimes.push(time);
    }
    return tradeTimes.filter((time) => time > 600).length / 50;
};

test('the controller holds 2-4 trades per minute in a seeded long run', () => {
    const rate = simulateTradesPerMinute(0);
    assert.ok(rate >= 2 && rate <= 4, `rate ${rate}`);
});

test('the controller still trades 2-4 per minute when forecasts lean one way', () => {
    const rate = simulateTradesPerMinute(0.002);
    assert.ok(rate >= 2 && rate <= 4, `rate ${rate}`);
});
