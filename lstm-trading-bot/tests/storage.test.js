import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../trading-bot.js';
import { saveBotState, loadBotState } from '../storage.js';

// In-memory stand-in for localStorage.
const memoryStorage = (initial = {}) => {
    const data = { ...initial };
    return { getItem: (key) => data[key] ?? null, setItem: (key, value) => { data[key] = String(value); }, data };
};

test('malformed JSON loads as null without throwing (Review Focus 3)', () => {
    assert.equal(loadBotState({ getItem: () => '{oops' }), null);
});

test('missing storage entry, wrong shape and missing fields load as null (Review Focus 3)', () => {
    assert.equal(loadBotState(memoryStorage()), null);
    for (const raw of ['null', '42', '{}', '{"wallet":{"usdt":1}}', '{"wallet":{"usdt":1,"btc":0,"initialUsdt":1,"avgEntry":0,"feesPaid":0},"trades":"x"}']) {
        assert.equal(loadBotState({ getItem: () => raw }), null, raw);
    }
});

test('a trade with non-numeric fields invalidates the saved state', () => {
    const bot = createBot();
    bot.state.trades.push({ time: 1, side: 'BUY', price: 'abc' });
    const storage = memoryStorage();
    saveBotState(bot.state, storage);
    assert.equal(loadBotState(storage), null);
});

test('round trip keeps trades and wallet and restores running as false', () => {
    const bot = createBot({ config: { thresholdPct: 0.01, buyPct: 50, sellPct: 100, feePct: 0.1, stopLossPct: 0, takeProfitPct: 0, mapeGate: false } });
    bot.start(100);
    bot.onClosedCandle({ time: 1, closeTime: 2, lastClose: 100, forecastNext: 101 });
    assert.equal(bot.state.running, true);
    const storage = memoryStorage();
    saveBotState({ ...bot.state, config: bot.config }, storage);
    const loaded = loadBotState(storage);
    assert.equal(loaded.running, false);
    assert.deepEqual(loaded.trades, bot.state.trades);
    assert.deepEqual(loaded.wallet, bot.state.wallet);
    assert.deepEqual(loaded.benchmark, bot.state.benchmark);
    assert.equal(loaded.equityHistory.length, 1);
    assert.equal(loaded.config.feePct, 0.1);
});

test('saveBotState swallows storage errors', () => {
    const failing = { setItem: () => { throw new Error('quota'); } };
    assert.equal(saveBotState(createBot().state, failing), false);
});
