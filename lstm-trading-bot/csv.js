// CSV export of the trade history (pure string building, no DOM).

const COLUMNS = ['time', 'side', 'reason', 'price', 'qty', 'fee', 'changePct', 'usdtAfter', 'btcAfter', 'equityAfter'];

// Quotes a cell when it contains a comma, quote or line break (RFC 4180).
function csvCell(value) {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// Builds one CSV line from a trade; the time column is ISO 8601.
function tradeToLine(trade) {
    const cells = COLUMNS.map((column) => (column === 'time' ? new Date(trade.time).toISOString() : trade[column]));
    return cells.map(csvCell).join(',');
}

// Returns the header followed by one line per trade.
export function tradesToCsv(trades) {
    return [COLUMNS.join(','), ...trades.map(tradeToLine)].join('\n');
}
