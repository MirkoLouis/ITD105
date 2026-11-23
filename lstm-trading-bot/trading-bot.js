// Paper-trading bot: turns an LSTM forecast into BUY/SELL/HOLD and simulates orders on the dummy wallet.
import { createWallet, executeBuy, executeSell } from './wallet.js';

export const MIN_ORDER_USDT = 10;
const DEFAULT_CONFIG = { thresholdPct: 0.01, buyPct: 50, sellPct: 100 };

// Expected percent change from the last close to the forecast price.
export function expectedChangePct(forecastPrice, lastClose) {
    return (forecastPrice / lastClose - 1) * 100;
}

// Chooses BUY, SELL or HOLD from the forecast change, holdings and minimum order size.
export function decideSignal({ changePct, thresholdPct, wallet, price, buyFraction }) {
    if (changePct > thresholdPct && wallet.usdt * buyFraction >= MIN_ORDER_USDT) return 'BUY';
    if (changePct < -thresholdPct && wallet.btc * price >= MIN_ORDER_USDT) return 'SELL';
    return 'HOLD';
}

// Parses a raw field; returns the number when it is a finite value inside the bounds, else null.
function parseField(raw, { min, max, minExclusive }) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    if (minExclusive ? value <= min : value < min) return null;
    if (value > max) return null;
    return value;
}

// Builds a config from raw UI strings; invalid fields keep the previous value.
export function parseBotConfig(raw, previous = DEFAULT_CONFIG) {
    const thresholdPct = parseField(raw.thresholdPct, { min: 0, max: 100 });
    const buyPct = parseField(raw.buyPct, { min: 0, max: 100, minExclusive: true });
    const sellPct = parseField(raw.sellPct, { min: 0, max: 100, minExclusive: true });
    return {
        thresholdPct: thresholdPct ?? previous.thresholdPct,
        buyPct: buyPct ?? previous.buyPct,
        sellPct: sellPct ?? previous.sellPct,
    };
}

// Creates a bot holding its own mutable state; wallet operations stay pure.
export function createBot({ config = DEFAULT_CONFIG, wallet = createWallet() } = {}) {
    const initialUsdt = wallet.initialUsdt;
    const bot = {
        config: { ...config },
        state: { running: false, wallet, trades: [], lastEvaluatedTime: null, lastSignal: null, lastChangePct: null },
    };

    // Begins evaluating closed candles.
    bot.start = () => {
        bot.state.running = true;
    };

    // Stops evaluating; the wallet and history are kept.
    bot.stop = () => {
        bot.state.running = false;
    };

    // Restores a fresh wallet and clears history and signal; the bot ends stopped.
    bot.reset = () => {
        bot.state = { running: false, wallet: createWallet(initialUsdt), trades: [], lastEvaluatedTime: null, lastSignal: null, lastChangePct: null };
    };

    // Replaces the active config.
    bot.setConfig = (nextConfig) => {
        bot.config = { ...nextConfig };
    };

    // Applies the signal to the wallet and returns the trade record.
    const placeOrder = (signal, { time, closeTime, lastClose, changePct }) => {
        const { wallet: current } = bot.state;
        const fill = signal === 'BUY'
            ? executeBuy(current, current.usdt * (bot.config.buyPct / 100), lastClose)
            : executeSell(current, current.btc * (bot.config.sellPct / 100), lastClose);
        bot.state.wallet = fill.wallet;
        return {
            time: closeTime ?? time,
            side: signal,
            price: lastClose,
            qty: fill.fill.qty,
            changePct,
            usdtAfter: fill.wallet.usdt,
            btcAfter: fill.wallet.btc,
            equityAfter: fill.wallet.usdt + fill.wallet.btc * lastClose,
        };
    };

    // Evaluates one closed candle at most once; returns null when stopped or already seen.
    bot.onClosedCandle = ({ time, closeTime, lastClose, forecastNext }) => {
        if (!bot.state.running) return null;
        if (time === bot.state.lastEvaluatedTime) return null;
        bot.state.lastEvaluatedTime = time;
        const changePct = expectedChangePct(forecastNext, lastClose);
        const signal = decideSignal({
            changePct,
            thresholdPct: bot.config.thresholdPct,
            wallet: bot.state.wallet,
            price: lastClose,
            buyFraction: bot.config.buyPct / 100,
        });
        bot.state.lastSignal = signal;
        bot.state.lastChangePct = changePct;
        if (signal === 'HOLD') return { signal, trade: null };
        const trade = placeOrder(signal, { time, closeTime, lastClose, changePct });
        bot.state.trades.push(trade);
        return { signal, trade };
    };

    return bot;
}
