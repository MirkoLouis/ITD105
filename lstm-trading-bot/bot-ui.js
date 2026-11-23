// Bot panel: wires the bzUI controls to the bot and renders wallet, signal, benchmark, equity chart and trade history.
import { equity, pnl, positionOf } from './wallet.js';
import { benchmarkEquity, parseBotConfig } from './trading-bot.js';
import { tradesToCsv } from './csv.js';

// Formats USDT with 2 decimals and thousands separators.
const formatUsdt = (value) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Formats BTC with 6 decimals.
const formatBtc = (value) => value.toFixed(6);
// Formats a percentage with 4 decimals and an explicit sign.
const formatPct = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
// Formats a millisecond timestamp as local HH:MM:SS.
const formatClock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hourCycle: 'h23' });
// Formats an absolute amount and percentage as "+12.34 (+0.1234%)".
const formatPnl = (abs, pct) => `${abs >= 0 ? '+' : ''}${formatUsdt(abs)} (${formatPct(pct)}%)`;

// Builds one trade-history row using textContent only (no HTML injection).
function buildTradeRow(trade) {
    const row = document.createElement('tr');
    const cells = [
        formatClock(trade.time),
        trade.side,
        trade.reason,
        formatUsdt(trade.price),
        formatBtc(trade.qty),
        formatUsdt(trade.fee),
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

// Downloads the trades as trades.csv through a temporary object URL and anchor.
function downloadCsv(trades) {
    const url = URL.createObjectURL(new Blob([tradesToCsv(trades)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'trades.csv';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

// Creates the panel controller for the markup inside `root`; `persist` saves state, `equityChart` is a BzChart-like { setData }.
export function createBotPanel({ bot, root, persist = () => {}, equityChart = null }) {
    const byId = (id) => root.querySelector(`#${id}`);
    const inputs = {
        thresholdPct: byId('bot-threshold'),
        buyPct: byId('bot-buy-pct'),
        sellPct: byId('bot-sell-pct'),
        feePct: byId('bot-fee'),
        stopLossPct: byId('bot-stop-loss'),
        takeProfitPct: byId('bot-take-profit'),
    };
    const gateInput = byId('bot-mape-gate');
    let lastPrice = null;
    let chartKey = null;

    // Writes the active config back into the inputs (shows the kept value after a rejection).
    const showConfig = () => {
        // One input per numeric config field.
        for (const [key, input] of Object.entries(inputs)) input.value = String(bot.config[key]);
        gateInput.checked = bot.config.mapeGate;
    };

    // Reads the inputs, applies valid fields, shows what was kept and saves.
    const applyInputs = () => {
        const raw = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
        raw.mapeGate = gateInput.checked;
        bot.setConfig(parseBotConfig(raw, bot.config));
        showConfig();
        persist();
    };

    // Shows (or clears, with null) a bot error without touching the rest of the page.
    const showError = (message) => {
        const line = byId('bot-error');
        line.textContent = message ? `Bot error: ${message}` : '';
        line.hidden = !message;
    };

    // Redraws the equity chart only when a new point was added.
    const renderEquityChart = () => {
        // The chart is optional (absent in non-browser use).
        if (!equityChart) return;
        const history = bot.state.equityHistory;
        const last = history[history.length - 1];
        const key = `${history.length}:${last ? last.time : ''}`;
        // Nothing new since the last draw.
        if (key === chartKey) return;
        chartKey = key;
        // Plot the change from the initial balance so the axis shows distinct values.
        const initial = bot.state.wallet.initialUsdt;
        equityChart.setData({
            type: 'line',
            labels: history.map((point) => formatClock(point.time)),
            datasets: [
                { label: 'Bot', data: history.map((point) => point.equity - initial), points: false },
                { label: 'Buy & hold', data: history.map((point) => (point.benchmark === null ? null : point.benchmark - initial)), points: false },
            ],
        });
    };

    // Renders the readouts that need a mark price (equity, PnL, position, benchmark).
    const renderPriced = (price) => {
        const { wallet } = bot.state;
        const profit = pnl(wallet, price);
        byId('bot-equity').textContent = formatUsdt(equity(wallet, price));
        byId('bot-pnl').textContent = formatPnl(profit.abs, profit.pct);
        byId('bot-position').textContent = positionOf(wallet, price);
        const held = benchmarkEquity(bot.state, price);
        // No benchmark yet: leave the readout as it is.
        if (held === null) return;
        const heldAbs = held - wallet.initialUsdt;
        byId('bot-benchmark').textContent = `${formatUsdt(held)} USDT · ${formatPnl(heldAbs, (heldAbs / wallet.initialUsdt) * 100)}`;
    };

    // Renders balances, status, signal, trade table and chart; lastClose is the current mark price.
    const render = (lastClose) => {
        // Remember the newest mark price when one is given.
        if (Number.isFinite(lastClose)) lastPrice = lastClose;
        const { state } = bot;
        const { wallet } = state;
        byId('bot-status').textContent = state.running ? 'Running' : 'Stopped';
        byId('bot-initial').textContent = formatUsdt(wallet.initialUsdt);
        byId('bot-usdt').textContent = formatUsdt(wallet.usdt);
        byId('bot-btc').textContent = formatBtc(wallet.btc);
        const reasonNote = state.lastReason && state.lastReason !== 'SIGNAL' ? ` [${state.lastReason}]` : '';
        byId('bot-signal').textContent = state.lastSignal === null
            ? '-'
            : `${state.lastSignal} (${formatPct(state.lastChangePct)}%)${reasonNote}`;
        // Without a benchmark the readout shows a dash.
        if (state.benchmark === null) byId('bot-benchmark').textContent = '-';
        // Price-dependent readouts need a mark price.
        if (lastPrice !== null) renderPriced(lastPrice);
        renderTrades(state.trades);
        renderEquityChart();
    };

    // Rebuilds the trade table, newest first.
    const renderTrades = (trades) => {
        const body = byId('trade-rows');
        body.replaceChildren(...[...trades].reverse().map(buildTradeRow));
    };

    // Runs a control action, then redraws and saves.
    const onControl = (action) => () => {
        action();
        render();
        persist();
    };

    byId('bot-start').addEventListener('click', onControl(() => bot.start(lastPrice ?? undefined)));
    byId('bot-stop').addEventListener('click', onControl(() => bot.stop()));
    byId('bot-reset').addEventListener('click', onControl(() => bot.reset()));
    byId('bot-export-csv').addEventListener('click', () => downloadCsv(bot.state.trades));
    // Config inputs apply on change.
    for (const input of [...Object.values(inputs), gateInput]) input.addEventListener('change', applyInputs);

    showConfig();
    render();
    return { render, showError };
}
