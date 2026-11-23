// Persistence of the bot state in localStorage; corrupt or old data loads as null (fresh wallet).

export const STORAGE_KEY = 'lstm-bot-state-v1';
const WALLET_FIELDS = ['initialUsdt', 'usdt', 'btc', 'avgEntry', 'feesPaid'];
const TRADE_REASONS = ['SIGNAL', 'STOP_LOSS', 'TAKE_PROFIT'];
const TRADE_NUMBER_FIELDS = ['time', 'price', 'qty', 'changePct', 'usdtAfter', 'btcAfter', 'equityAfter'];

// True for finite numbers only (rejects strings, NaN, Infinity, null).
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// True when `value` is a non-null object that is not an array.
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// Validates the wallet: all fields finite, initialUsdt positive, balances non-negative.
function isValidWallet(wallet) {
    // Reject non-objects.
    if (!isPlainObject(wallet)) return false;
    // Reject missing or non-finite fields.
    if (!WALLET_FIELDS.every((field) => isFiniteNumber(wallet[field]))) return false;
    return wallet.initialUsdt > 0 && wallet.usdt >= 0 && wallet.btc >= 0 && wallet.avgEntry >= 0 && wallet.feesPaid >= 0;
}

// Validates one trade record; a missing reason becomes SIGNAL, an unknown reason rejects the record.
function normalizeTrade(trade) {
    // Reject non-objects.
    if (!isPlainObject(trade)) return null;
    // Every numeric field must be a finite number.
    if (!TRADE_NUMBER_FIELDS.every((field) => isFiniteNumber(trade[field]))) return null;
    // Reject an unknown side.
    if (trade.side !== 'BUY' && trade.side !== 'SELL') return null;
    // Reason is whitelisted because it is rendered and exported.
    // Legacy saves written before reasons existed have none, so they default to SIGNAL.
    const reason = trade.reason ?? 'SIGNAL';
    // Reject a reason outside the whitelist.
    if (!TRADE_REASONS.includes(reason)) return null;
    return { ...trade, fee: isFiniteNumber(trade.fee) ? trade.fee : 0, reason };
}

// Validates the benchmark; absent or malformed becomes null.
// Ternary: keep the object only when both numbers are finite, else fall back to no benchmark.
const normalizeBenchmark = (benchmark) =>
    (isPlainObject(benchmark) && isFiniteNumber(benchmark.startPrice) && isFiniteNumber(benchmark.btc) ? benchmark : null);

// True for a well-formed equity point: finite time and equity, benchmark finite or null.
const isValidPoint = (point) =>
    isPlainObject(point) && isFiniteNumber(point.time) && isFiniteNumber(point.equity)
    && (point.benchmark === null || isFiniteNumber(point.benchmark));

// Keeps only well-formed equity points, capped to the newest 1000.
function normalizeHistory(history) {
    // A missing or malformed history becomes empty.
    if (!Array.isArray(history)) return [];
    return history.filter(isValidPoint).slice(-1000);
}

// Saves the state as JSON; returns false when storage is unavailable or full.
export function saveBotState(state, storage = globalThis.localStorage) {
    try {
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
        return true;
    } catch {
        return false;
    }
}

// Loads and validates the saved state; returns null when missing, malformed or incomplete. Never restores running.
export function loadBotState(storage = globalThis.localStorage) {
    let parsed;
    try {
        parsed = JSON.parse(storage.getItem(STORAGE_KEY));
    } catch {
        return null;
    }
    // Missing or malformed top-level fields mean a fresh wallet.
    if (!isPlainObject(parsed) || !isValidWallet(parsed.wallet) || !Array.isArray(parsed.trades)) return null;
    const trades = parsed.trades.map(normalizeTrade);
    // Any invalid trade invalidates the whole save.
    if (trades.some((trade) => trade === null)) return null;
    // Each ternary below keeps a field only when it has the expected type, otherwise it falls back to a safe default.
    return {
        running: false,
        wallet: parsed.wallet,
        trades,
        lastEvaluatedTime: isFiniteNumber(parsed.lastEvaluatedTime) ? parsed.lastEvaluatedTime : null,
        lastSignal: typeof parsed.lastSignal === 'string' ? parsed.lastSignal : null,
        lastChangePct: isFiniteNumber(parsed.lastChangePct) ? parsed.lastChangePct : null,
        lastReason: typeof parsed.lastReason === 'string' ? parsed.lastReason : null,
        benchmark: normalizeBenchmark(parsed.benchmark),
        equityHistory: normalizeHistory(parsed.equityHistory),
        config: isPlainObject(parsed.config) ? parsed.config : null,
    };
}
