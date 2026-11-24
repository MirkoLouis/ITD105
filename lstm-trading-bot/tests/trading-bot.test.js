import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWallet } from '../wallet.js';
import { expectedChangePct, decideSignal, parseBotConfig, createBot, checkRiskExit, benchmarkEquity } from '../trading-bot.js';

// Fee, risk exits and the MAPE gate are off so the Task 3 tests keep their exact arithmetic.
const DEFAULTS = { thresholdPct: 0.01, buyPct: 50, sellPct: 100, feePct: 0, stopLossPct: 0, takeProfitPct: 0, mapeGate: false };
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
