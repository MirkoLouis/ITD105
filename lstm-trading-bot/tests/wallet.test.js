import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWallet, executeBuy, executeSell, equity, pnl, positionOf } from '../wallet.js';

// Compares floats within a small tolerance.
const closeTo = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} !~ ${expected}`);

test('selling from a wallet without BTC throws RangeError', () => {
    assert.throws(() => executeSell(createWallet(), 1, 50000), RangeError);
});

test('createWallet starts with 10000 USDT, 0 BTC, in CASH', () => {
    const wallet = createWallet();
    assert.equal(wallet.usdt, 10000);
    assert.equal(wallet.btc, 0);
    assert.equal(positionOf(wallet, 50000), 'CASH');
});

test('buy 5000 USDT at 50000 gives 0.1 BTC and keeps equity', () => {
    const { wallet, fill } = executeBuy(createWallet(), 5000, 50000);
    closeTo(wallet.btc, 0.1);
    closeTo(wallet.usdt, 5000);
    closeTo(equity(wallet, 50000), 10000);
    closeTo(pnl(wallet, 50000).abs, 0);
    assert.equal(fill.side, 'BUY');
    assert.equal(positionOf(wallet, 50000), 'BTC');
});

test('sell all at 55000 returns to CASH with +5% PnL', () => {
    const bought = executeBuy(createWallet(), 5000, 50000).wallet;
    const { wallet } = executeSell(bought, bought.btc, 55000);
    assert.equal(wallet.btc, 0);
    closeTo(wallet.usdt, 10500);
    closeTo(pnl(wallet, 55000).pct, 5);
    assert.equal(positionOf(wallet, 55000), 'CASH');
});

test('selling everything after three partial buys leaves btc exactly 0', () => {
    let wallet = createWallet();
    for (const [spend, price] of [[1000, 61234.56], [1500, 59876.54], [700, 63111.11]]) {
        wallet = executeBuy(wallet, spend, price).wallet;
    }
    const { wallet: after } = executeSell(wallet, wallet.btc, 60000);
    assert.equal(after.btc, 0);
    assert.equal(positionOf(after, 60000), 'CASH');
});

test('buying more than the free USDT throws RangeError', () => {
    assert.throws(() => executeBuy(createWallet(), 10001, 50000), RangeError);
});

test('fee is taken from the USDT spent and inputs are not mutated', () => {
    const start = createWallet();
    const { wallet, fill } = executeBuy(start, 1000, 50000, 0.001);
    closeTo(fill.fee, 1);
    closeTo(fill.qty, 0.01998);
    closeTo(wallet.feesPaid, 1);
    assert.equal(start.usdt, 10000);
});
