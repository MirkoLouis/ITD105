import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tradesToCsv } from '../csv.js';

const HEADER = 'time,side,reason,price,qty,fee,changePct,usdtAfter,btcAfter,equityAfter';

test('empty trade list yields only the header', () => {
    assert.equal(tradesToCsv([]), HEADER);
});

test('one trade yields a header and a 10-column ISO-time row', () => {
    const trade = { time: Date.UTC(2026, 0, 2, 3, 4, 5), side: 'BUY', reason: 'SIGNAL', price: 50000, qty: 0.0999, fee: 5, changePct: 0.02, usdtAfter: 5000, btcAfter: 0.0999, equityAfter: 9995 };
    const lines = tradesToCsv([trade]).split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], HEADER);
    const cells = lines[1].split(',');
    assert.equal(cells.length, 10);
    assert.equal(cells[0], '2026-01-02T03:04:05.000Z');
    assert.equal(cells[1], 'BUY');
    assert.equal(cells[2], 'SIGNAL');
});
