// In-code dummy wallet: pure functions that return new wallet objects (no I/O, no exchange).

const DECIMALS = 1e8;
const DUST_NOTIONAL_USDT = 1; // below this value in USDT the BTC balance counts as "no position"

// Rounds to 8 decimals to avoid float residue accumulating in balances.
const round8 = (value) => Math.round(value * DECIMALS) / DECIMALS;

// Creates a fresh wallet holding only USDT.
export function createWallet(initialUsdt = 10000) {
    return { initialUsdt, usdt: initialUsdt, btc: 0, avgEntry: 0, feesPaid: 0 };
}

// Validates that a number is finite and positive, else throws RangeError.
function assertPositive(value, name) {
    // Reject NaN, Infinity, zero and negatives.
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number`);
}

// Spends `spendUsdt` (fee taken from it) to buy BTC at `price`.
export function executeBuy(wallet, spendUsdt, price, feeRate = 0) {
    assertPositive(spendUsdt, 'spendUsdt');
    assertPositive(price, 'price');
    // Reject orders larger than the free USDT.
    if (spendUsdt > wallet.usdt) throw new RangeError('spendUsdt exceeds available USDT');
    const fee = round8(spendUsdt * feeRate);
    const qty = round8((spendUsdt - fee) / price);
    const btc = round8(wallet.btc + qty);
    // Weighted average entry price across old and new BTC.
    const avgEntry = btc > 0 ? (wallet.avgEntry * wallet.btc + price * qty) / btc : 0;
    const next = {
        ...wallet,
        usdt: round8(wallet.usdt - spendUsdt),
        btc,
        avgEntry,
        feesPaid: round8(wallet.feesPaid + fee),
    };
    return { wallet: next, fill: { side: 'BUY', price, qty, notional: round8(qty * price), fee } };
}

// Sells `sellBtc` at `price`; selling >= the holding empties it to exactly 0.
export function executeSell(wallet, sellBtc, price, feeRate = 0) {
    assertPositive(sellBtc, 'sellBtc');
    assertPositive(price, 'price');
    // Nothing to sell without a BTC holding.
    if (wallet.btc <= 0) throw new RangeError('no BTC to sell');
    const qty = sellBtc >= wallet.btc ? wallet.btc : round8(sellBtc);
    const notional = round8(qty * price);
    const fee = round8(notional * feeRate);
    const btc = sellBtc >= wallet.btc ? 0 : round8(wallet.btc - qty);
    const next = {
        ...wallet,
        usdt: round8(wallet.usdt + notional - fee),
        btc,
        avgEntry: btc === 0 ? 0 : wallet.avgEntry,
        feesPaid: round8(wallet.feesPaid + fee),
    };
    return { wallet: next, fill: { side: 'SELL', price, qty, notional, fee } };
}

// Total value in USDT at the given price.
export function equity(wallet, price) {
    return wallet.usdt + wallet.btc * price;
}

// Profit and loss versus the initial balance.
export function pnl(wallet, price) {
    const abs = equity(wallet, price) - wallet.initialUsdt;
    return { abs, pct: (abs / wallet.initialUsdt) * 100 };
}

// 'BTC' when the BTC holding is worth at least 1 USDT, otherwise 'CASH'.
export function positionOf(wallet, price) {
    return wallet.btc * price >= DUST_NOTIONAL_USDT ? 'BTC' : 'CASH';
}
