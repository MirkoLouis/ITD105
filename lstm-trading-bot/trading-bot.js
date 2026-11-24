// Paper-trading bot: turns an LSTM forecast into BUY/SELL/HOLD and simulates orders on the dummy wallet.
import { createWallet, equity, executeBuy, executeSell } from './wallet.js';

export const MIN_ORDER_USDT = 10;
export const MAX_EQUITY_POINTS = 1000;
export const ADAPTIVE_WINDOW = 60;
export const ADAPTIVE_MIN_SAMPLES = 20;
const THRESHOLD_MODES = ['adaptive', 'fixed'];
export const DEFAULT_CONFIG = {
    thresholdMode: 'adaptive',
    targetSignalsPerMin: 3,
    thresholdPct: 0.01,
    buyPct: 50,
    sellPct: 100,
    feePct: 0.1,
    stopLossPct: 0.5,
    takeProfitPct: 0.5,
    mapeGate: false,
};

// Converts a percentage (50) to a fraction (0.5).
const percentToFraction = (pct) => pct / 100;

// Expected percent change from the last close to the forecast price.
export function expectedChangePct(forecastPrice, lastClose) {
    return (forecastPrice / lastClose - 1) * 100;
}

// Quantile of |changePct| that yields about `targetSignalsPerMin` signals per minute (<= 0 means every candle may signal).
export function adaptiveQuantile(targetSignalsPerMin, candlesPerMinute) {
    return 1 - targetSignalsPerMin / candlesPerMinute;
}

// Percentile threshold of recent |changePct| values; null while fewer than ADAPTIVE_MIN_SAMPLES exist (warm-up).
export function adaptiveThresholdPct(recentAbsChanges, targetSignalsPerMin, candlesPerMinute) {
    const quantile = adaptiveQuantile(targetSignalsPerMin, candlesPerMinute);
    // Target at or above the candle rate: every candle may signal.
    if (quantile <= 0) return 0;
    // Not enough history yet.
    if (recentAbsChanges.length < ADAPTIVE_MIN_SAMPLES) return null;
    const sorted = [...recentAbsChanges].sort((a, b) => a - b);
    const index = Math.min(Math.floor(quantile * sorted.length), sorted.length - 1);
    return sorted[index];
}

// Chooses BUY, SELL or HOLD from the forecast change, holdings and minimum order size.
export function decideSignal({ changePct, thresholdPct, wallet, price, buyFraction, sellFraction = 1 }) {
    // BUY: forecast rises past the threshold and the order is not dust.
    if (changePct > thresholdPct && wallet.usdt * buyFraction >= MIN_ORDER_USDT) return 'BUY';
    // SELL: forecast falls past the threshold and the sold amount is not dust.
    if (changePct < -thresholdPct && wallet.btc * sellFraction * price >= MIN_ORDER_USDT) return 'SELL';
    return 'HOLD';
}

// Returns 'STOP_LOSS' or 'TAKE_PROFIT' when the price moved far enough from the average entry, else null (0 = off).
export function checkRiskExit({ wallet, price, stopLossPct, takeProfitPct }) {
    // No position, nothing to protect.
    if (wallet.btc <= 0 || wallet.avgEntry <= 0) return null;
    const movePct = (price / wallet.avgEntry - 1) * 100;
    // Price fell far enough below the entry.
    if (stopLossPct > 0 && movePct <= -stopLossPct) return 'STOP_LOSS';
    // Price rose far enough above the entry.
    if (takeProfitPct > 0 && movePct >= takeProfitPct) return 'TAKE_PROFIT';
    return null;
}

// Value of the buy-and-hold benchmark at `price`; null before the benchmark exists.
export function benchmarkEquity(state, price) {
    // No benchmark has been anchored yet.
    if (!state.benchmark) return null;
    return state.benchmark.btc * price;
}

// Parses a raw field; returns the number when it is a finite value inside the bounds, else null.
function parseField(raw, { min, max, minExclusive }) {
    // Empty input is rejected.
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const value = Number(raw);
    // NaN and Infinity are rejected.
    if (!Number.isFinite(value)) return null;
    // Below the lower bound (exclusive or inclusive).
    if (minExclusive ? value <= min : value < min) return null;
    // Above the upper bound.
    if (value > max) return null;
    return value;
}

// Bounds per numeric config field (stop-loss/take-profit accept 0 = off).
const FIELD_BOUNDS = {
    thresholdPct: { min: 0, max: 100 },
    buyPct: { min: 0, max: 100, minExclusive: true },
    sellPct: { min: 0, max: 100, minExclusive: true },
    feePct: { min: 0, max: 10 },
    stopLossPct: { min: 0, max: 100 },
    takeProfitPct: { min: 0, max: 100 },
};

// Bounds of the target signal rate per minute.
const TARGET_RATE_BOUNDS = { min: 0.1, max: 60 };

// Builds a config from raw UI values; invalid fields keep the previous value.
export function parseBotConfig(raw, previous = DEFAULT_CONFIG) {
    const config = { ...previous };
    // One bounds check per numeric field.
    for (const [key, bounds] of Object.entries(FIELD_BOUNDS)) {
        config[key] = parseField(raw[key], bounds) ?? previous[key];
    }
    config.mapeGate = typeof raw.mapeGate === 'boolean' ? raw.mapeGate : Boolean(previous.mapeGate);
    // Unknown modes keep the previous mode (or the default for configs saved before the mode existed).
    const previousMode = previous.thresholdMode ?? DEFAULT_CONFIG.thresholdMode;
    config.thresholdMode = THRESHOLD_MODES.includes(raw.thresholdMode) ? raw.thresholdMode : previousMode;
    const previousTarget = previous.targetSignalsPerMin ?? DEFAULT_CONFIG.targetSignalsPerMin;
    config.targetSignalsPerMin = parseField(raw.targetSignalsPerMin, TARGET_RATE_BOUNDS) ?? previousTarget;
    return config;
}

// Builds an empty bot state around the given wallet.
function freshState(wallet) {
    return {
        running: false,
        wallet,
        trades: [],
        lastEvaluatedTime: null,
        lastSignal: null,
        lastChangePct: null,
        lastReason: null,
        benchmark: null,
        equityHistory: [],
        recentAbsChanges: [],
        lastIntervalMs: null,
        lastThreshold: null,
    };
}

// Creates a bot holding its own mutable state; wallet operations stay pure. `state` restores a saved run.
export function createBot({ config = DEFAULT_CONFIG, wallet = createWallet(), state = null } = {}) {
    const initialUsdt = state ? state.wallet.initialUsdt : wallet.initialUsdt;
    const bot = {
        config: { ...DEFAULT_CONFIG, ...config },
        state: state ? { ...freshState(state.wallet), ...state, running: false } : freshState(wallet),
    };
    delete bot.state.config;

    // Records what a buy-and-hold investor would own: all initial USDT, minus the fee, at `price`.
    const ensureBenchmark = (price) => {
        // Keep an existing benchmark; ignore unusable prices.
        if (bot.state.benchmark || !Number.isFinite(price) || price <= 0) return;
        const spend = bot.state.wallet.initialUsdt * (1 - percentToFraction(bot.config.feePct));
        bot.state.benchmark = { startPrice: price, btc: spend / price };
    };

    // Begins evaluating closed candles; `price` (optional) anchors the benchmark.
    bot.start = (price) => {
        bot.state.running = true;
        ensureBenchmark(price);
    };

    // Stops evaluating; the wallet and history are kept.
    bot.stop = () => {
        bot.state.running = false;
    };

    // Restores a fresh wallet and clears history, signal and benchmark; the bot ends stopped.
    bot.reset = () => {
        bot.state = freshState(createWallet(initialUsdt));
    };

    // Replaces the active config.
    bot.setConfig = (nextConfig) => {
        bot.config = { ...nextConfig };
    };

    // Applies a BUY or SELL to the wallet and returns the trade record; `sellFraction` is 1 for risk exits.
    const placeOrder = ({ side, reason, sellFraction, time, closeTime, lastClose, changePct }) => {
        const { wallet: current } = bot.state;
        const feeRate = percentToFraction(bot.config.feePct);
        const result = side === 'BUY'
            ? executeBuy(current, current.usdt * percentToFraction(bot.config.buyPct), lastClose, feeRate)
            : executeSell(current, current.btc * sellFraction, lastClose, feeRate);
        bot.state.wallet = result.wallet;
        return {
            time: closeTime ?? time,
            side,
            reason,
            price: lastClose,
            qty: result.fill.qty,
            fee: result.fill.fee,
            changePct,
            usdtAfter: result.wallet.usdt,
            btcAfter: result.wallet.btc,
            equityAfter: equity(result.wallet, lastClose),
        };
    };

    // Appends one equity point (bot vs benchmark), keeping the newest MAX_EQUITY_POINTS.
    const recordEquity = (time, price) => {
        const { equityHistory } = bot.state;
        equityHistory.push({ time, equity: equity(bot.state.wallet, price), benchmark: benchmarkEquity(bot.state, price) });
        // Drop the oldest points beyond the cap.
        if (equityHistory.length > MAX_EQUITY_POINTS) equityHistory.splice(0, equityHistory.length - MAX_EQUITY_POINTS);
    };

    // True when the gate is on and the LSTM does not beat the repeat-last-close baseline (or has no accuracy data yet).
    const gateBlocks = (mape, baseMape) => {
        // Gate switched off: never blocks.
        if (!bot.config.mapeGate) return false;
        // No accuracy data yet: block conservatively.
        if (!Number.isFinite(mape) || !Number.isFinite(baseMape)) return true;
        return mape >= baseMape;
    };

    // Chooses this candle's threshold; adaptive mode reads the window before the candle's own change is added to it.
    const resolveThreshold = (changePct, intervalMs) => {
        const fixed = { pct: bot.config.thresholdPct, source: 'fixed', quantile: null };
        // Without an interval (or in fixed mode) the fixed threshold applies and the window is left alone.
        if (!Number.isFinite(intervalMs) || bot.config.thresholdMode !== 'adaptive') return fixed;
        // A new interval makes old samples incomparable.
        if (intervalMs !== bot.state.lastIntervalMs) bot.state.recentAbsChanges = [];
        bot.state.lastIntervalMs = intervalMs;
        const { recentAbsChanges } = bot.state;
        const { targetSignalsPerMin } = bot.config;
        const candlesPerMinute = 60000 / intervalMs;
        const adaptivePct = adaptiveThresholdPct(recentAbsChanges, targetSignalsPerMin, candlesPerMinute);
        // Keep the newest ADAPTIVE_WINDOW samples.
        recentAbsChanges.push(Math.abs(changePct));
        if (recentAbsChanges.length > ADAPTIVE_WINDOW) recentAbsChanges.shift();
        // Warm-up: not enough samples, so the fixed threshold applies.
        if (adaptivePct === null) return { ...fixed, source: 'warmup' };
        return { pct: adaptivePct, source: 'adaptive', quantile: adaptiveQuantile(targetSignalsPerMin, candlesPerMinute) };
    };

    // Picks the action for this candle: risk exit first, then the LSTM signal behind the optional MAPE gate.
    const decide = ({ lastClose, changePct, mape, baseMape, thresholdPct }) => {
        const { wallet: current } = bot.state;
        const riskReason = checkRiskExit({ wallet: current, price: lastClose, stopLossPct: bot.config.stopLossPct, takeProfitPct: bot.config.takeProfitPct });
        // A risk exit overrides the LSTM signal.
        if (riskReason) return { signal: 'SELL', reason: riskReason, sellFraction: 1 };
        const sellFraction = percentToFraction(bot.config.sellPct);
        const signal = decideSignal({
            changePct,
            thresholdPct,
            wallet: current,
            price: lastClose,
            buyFraction: percentToFraction(bot.config.buyPct),
            sellFraction,
        });
        // The MAPE gate turns a trade into HOLD.
        if (signal !== 'HOLD' && gateBlocks(mape, baseMape)) return { signal: 'HOLD', reason: 'MAPE_GATE', sellFraction };
        return { signal, reason: 'SIGNAL', sellFraction };
    };

    // Evaluates one closed candle at most once; returns null when stopped or already seen.
    bot.onClosedCandle = ({ time, closeTime, lastClose, forecastNext, mape, baseMape, intervalMs }) => {
        // Stopped bots do nothing.
        if (!bot.state.running) return null;
        // Each candle is evaluated once.
        if (time === bot.state.lastEvaluatedTime) return null;
        bot.state.lastEvaluatedTime = time;
        ensureBenchmark(lastClose);
        const changePct = expectedChangePct(forecastNext, lastClose);
        const threshold = resolveThreshold(changePct, intervalMs);
        bot.state.lastThreshold = threshold;
        const { signal, reason, sellFraction } = decide({ lastClose, changePct, mape, baseMape, thresholdPct: threshold.pct });
        bot.state.lastSignal = signal;
        bot.state.lastChangePct = changePct;
        bot.state.lastReason = reason;
        const trade = signal === 'HOLD'
            ? null
            : placeOrder({ side: signal, reason, sellFraction, time, closeTime, lastClose, changePct });
        // Only real orders enter the history.
        if (trade) bot.state.trades.push(trade);
        recordEquity(closeTime ?? time, lastClose);
        return { signal, reason, trade };
    };

    return bot;
}
