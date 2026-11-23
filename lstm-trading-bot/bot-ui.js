// Bot panel: wires the bzUI controls to the bot and renders wallet, signal and trade history.
import { equity, pnl, positionOf } from './wallet.js';
import { parseBotConfig } from './trading-bot.js';

// Formats USDT with 2 decimals and thousands separators.
const formatUsdt = (value) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Formats BTC with 6 decimals.
const formatBtc = (value) => value.toFixed(6);
// Formats a percentage with 4 decimals and an explicit sign.
const formatPct = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
// Formats a millisecond timestamp as local HH:MM:SS.
const formatClock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });

// Builds one trade-history row using textContent only (no HTML injection).
function buildTradeRow(trade) {
    const row = document.createElement('tr');
    const cells = [
        formatClock(trade.time),
        trade.side,
        formatUsdt(trade.price),
        formatBtc(trade.qty),
        formatPct(trade.changePct),
        formatUsdt(trade.usdtAfter),
        formatBtc(trade.btcAfter),
        formatUsdt(trade.equityAfter),
    ];
    // One cell per column.
    for (const text of cells) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
    }
    return row;
}

// Creates the panel controller for the markup inside `root`.
export function createBotPanel({ bot, root }) {
    const byId = (id) => root.querySelector(`#${id}`);
    const inputs = { thresholdPct: byId('bot-threshold'), buyPct: byId('bot-buy-pct'), sellPct: byId('bot-sell-pct') };
    let lastPrice = null;

    // Writes the active config back into the inputs (shows the kept value after a rejection).
    const showConfig = () => {
        for (const [key, input] of Object.entries(inputs)) input.value = String(bot.config[key]);
    };

    // Reads the inputs, applies valid fields, and shows what was kept.
    const applyInputs = () => {
        const raw = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
        bot.setConfig(parseBotConfig(raw, bot.config));
        showConfig();
    };

    // Renders balances, status, signal and trade table; lastClose is the current mark price.
    const render = (lastClose) => {
        if (Number.isFinite(lastClose)) lastPrice = lastClose;
        const { state } = bot;
        const { wallet } = state;
        byId('bot-status').textContent = state.running ? 'Running' : 'Stopped';
        byId('bot-initial').textContent = formatUsdt(wallet.initialUsdt);
        byId('bot-usdt').textContent = formatUsdt(wallet.usdt);
        byId('bot-btc').textContent = formatBtc(wallet.btc);
        byId('bot-signal').textContent = state.lastSignal === null
            ? '-'
            : `${state.lastSignal} (${formatPct(state.lastChangePct)}%)`;
        // Price-dependent readouts need a mark price.
        if (lastPrice === null) return renderTrades(state.trades);
        const profit = pnl(wallet, lastPrice);
        byId('bot-equity').textContent = formatUsdt(equity(wallet, lastPrice));
        byId('bot-pnl').textContent = `${profit.abs >= 0 ? '+' : ''}${formatUsdt(profit.abs)} (${formatPct(profit.pct)}%)`;
        byId('bot-position').textContent = positionOf(wallet, lastPrice);
        renderTrades(state.trades);
    };

    // Rebuilds the trade table, newest first.
    const renderTrades = (trades) => {
        const body = byId('trade-rows');
        body.replaceChildren(...[...trades].reverse().map(buildTradeRow));
    };

    byId('bot-start').addEventListener('click', () => { bot.start(); render(); });
    byId('bot-stop').addEventListener('click', () => { bot.stop(); render(); });
    byId('bot-reset').addEventListener('click', () => { bot.reset(); render(); });
    // Config inputs apply on change.
    for (const input of Object.values(inputs)) input.addEventListener('change', applyInputs);

    showConfig();
    render();
    return { render };
}
