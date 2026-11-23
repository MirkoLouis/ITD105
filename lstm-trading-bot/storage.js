// Persistence of the bot state in localStorage; corrupt or old data loads as null (fresh wallet).

export const STORAGE_KEY = 'lstm-bot-state-v1';
const WALLET_FIELDS = ['initialUsdt', 'usdt', 'btc', 'avgEntry', 'feesPaid'];
const TRADE_NUMBER_FIELDS = ['time', 'price', 'qty', 'changePct', 'usdtAfter', 'btcAfter', 'equityAfter'];

// True for finite numbers only (rejects strings, NaN, Infinity, null).
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// True when `value` is a non-null object that is not an array.
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// Validates the wallet fields.
const isValidWallet = (wallet) => isPlainObject(wallet) && WALLET_FIELDS.every((field) => isFiniteNumber(wallet[field]));

// Validates one trade record and fills the fields older saves may lack.
function normalizeTrade(trade) {
    if (!isPlainObject(trade)) return null;
    if (!TRADE_NUMBER_FIELDS.every((field) => isFiniteNumber(trade[field]))) return null;
    if (trade.side !== 'BUY' && trade.side !== 'SELL') return null;
    return { ...trade, fee: isFiniteNumber(trade.fee) ? trade.fee : 0, reason: typeof trade.reason === 'string' ? trade.reason : 'SIGNAL' };
}

// Validates the benchmark; absent or malformed becomes null.
const normalizeBenchmark = (benchmark) =>
    (isPlainObject(benchmark) && isFiniteNumber(benchmark.startPrice) && isFiniteNumber(benchmark.btc) ? benchmark : null);

// Keeps only well-formed equity points, capped to the newest 1000.
const normalizeHistory = (history) => {
    if (!Array.isArray(history)) return [];
    const valid = history.filter((point) => isPlainObject(point) && isFiniteNumber(point.time) && isFiniteNumber(point.equity));
    return valid.slice(-1000);
};

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
    if (!isPlainObject(parsed) || !isValidWallet(parsed.wallet) || !Array.isArray(parsed.trades)) return null;
    const trades = parsed.trades.map(normalizeTrade);
    if (trades.some((trade) => trade === null)) return null;
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
