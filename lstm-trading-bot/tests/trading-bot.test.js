import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWallet } from '../wallet.js';
import { expectedChangePct, decideSignal, parseBotConfig, createBot } from '../trading-bot.js';

const DEFAULTS = { thresholdPct: 0.01, buyPct: 50, sellPct: 100 };
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

test('SELL sells all BTC exactly', () => {
    const bot = createBot({ config: DEFAULTS, wallet: createWallet() });
    bot.start();
    bot.onClosedCandle({ time: 1, lastClose: 100, forecastNext: 101 });
    const { trade } = bot.onClosedCandle({ time: 2, lastClose: 100, forecastNext: 99 });
    assert.equal(trade.side, 'SELL');
    assert.equal(bot.state.wallet.btc, 0);
});
