import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tradesToCsv, csvCell } from '../csv.js';

test('csvCell quotes commas, quotes and newlines', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('a\nb'), '"a\nb"');
    assert.equal(csvCell('plain'), 'plain');
});

test('csvCell neutralises formula prefixes in strings but not numbers', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) assert.equal(csvCell(`${lead}1`).replace(/^"|"$/g, '')[0], "'");
    assert.equal(csvCell('=1+1'), "'=1+1");
    assert.equal(csvCell(-5.5), '-5.5');
    assert.equal(csvCell(0.02), '0.02');
});

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
