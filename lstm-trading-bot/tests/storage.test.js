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

// Saves a valid state after letting `mutate` tamper with it, then loads it back.
const loadTampered = (mutate) => {
    const bot = createBot();
    bot.start(100);
    bot.onClosedCandle({ time: 1, closeTime: 2, lastClose: 100, forecastNext: 101 });
    const state = JSON.parse(JSON.stringify(bot.state));
    mutate(state);
    const storage = memoryStorage();
    saveBotState(state, storage);
    return loadBotState(storage);
};

test('a tampered trade reason loads as null', () => {
    assert.equal(loadTampered((state) => { state.trades[0].reason = '<img onerror=x>'; }), null);
    assert.notEqual(loadTampered((state) => { state.trades[0].reason = 'STOP_LOSS'; }), null);
});

test('negative balances or non-positive initialUsdt load as null', () => {
    assert.equal(loadTampered((state) => { state.wallet.usdt = -1; }), null);
    assert.equal(loadTampered((state) => { state.wallet.btc = -0.5; }), null);
    assert.equal(loadTampered((state) => { state.wallet.feesPaid = -1; }), null);
    assert.equal(loadTampered((state) => { state.wallet.initialUsdt = 0; }), null);
});

test('equity history entries with a bad benchmark are dropped', () => {
    const loaded = loadTampered((state) => {
        state.equityHistory.push({ time: 5, equity: 1, benchmark: 'x' }, { time: 6, equity: 1, benchmark: null });
    });
    assert.deepEqual(loaded.equityHistory.map((point) => point.time), [2, 6]);
});

test('saveBotState swallows storage errors', () => {
    const failing = { setItem: () => { throw new Error('quota'); } };
    assert.equal(saveBotState(createBot().state, failing), false);
});

// ---- Adaptive threshold persistence ----

test('round trip keeps recentAbsChanges and lastIntervalMs', () => {
    const bot = createBot();
    bot.start(100);
    for (let time = 1; time <= 5; time++) {
        bot.onClosedCandle({ time, closeTime: time + 1, lastClose: 100, forecastNext: 100 + 0.001 * time, intervalMs: 1000 });
    }
    const storage = memoryStorage();
    saveBotState({ ...bot.state, config: bot.config }, storage);
    const loaded = loadBotState(storage);
    assert.equal(loaded.recentAbsChanges.length, 5);
    assert.deepEqual(loaded.recentAbsChanges, bot.state.recentAbsChanges);
    assert.equal(loaded.lastIntervalMs, 1000);
    assert.equal(loaded.config.thresholdMode, 'adaptive');
    assert.equal(loaded.config.targetSignalsPerMin, 3);
});

test('a legacy save without the adaptive fields loads with an empty window', () => {
    const loaded = loadTampered((state) => { delete state.recentAbsChanges; delete state.lastIntervalMs; });
    assert.deepEqual(loaded.recentAbsChanges, []);
    assert.equal(loaded.lastIntervalMs, null);
});

test('an invalid window entry loads as null', () => {
    assert.equal(loadTampered((state) => { state.recentAbsChanges = [0.1, -0.1]; }), null);
    assert.equal(loadTampered((state) => { state.recentAbsChanges = [0.1, 'x']; }), null);
    assert.equal(loadTampered((state) => { state.recentAbsChanges = 'x'; }), null);
    assert.equal(loadTampered((state) => { state.recentAbsChanges = new Array(61).fill(0.1); }), null);
    assert.notEqual(loadTampered((state) => { state.recentAbsChanges = new Array(60).fill(0.1); }), null);
});

test('an invalid lastIntervalMs loads as null', () => {
    assert.equal(loadTampered((state) => { state.lastIntervalMs = -5; }).lastIntervalMs, null);
    assert.equal(loadTampered((state) => { state.lastIntervalMs = 'x'; }).lastIntervalMs, null);
});
