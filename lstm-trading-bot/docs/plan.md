# LSTM Crypto Trading Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the BZUI-LSTM-BTCUSDT forecast demo into an in-browser paper-trading bot with a dummy USDT/BTC wallet, then add fees, benchmark, risk controls, equity chart, persistence and CSV export.

**Architecture:** Reference files stay near-upstream. New logic lives in pure ES modules (`wallet.js`, `trading-bot.js`, `storage.js`, `csv.js`) that Node can unit-test, plus one DOM module (`bot-ui.js`). `app.js` gets a single hook: when a new closed candle arrives, `tick()` hands the latest close, `forecast[0]` and the MAPE pair to the bot.

**Tech Stack:** Vanilla JS ES modules, bzUI CSS + `BzChart` (CDN), public Binance klines (no key), `node --test` (Node 22), playwright-core + cached chrome-headless-shell for browser checks (scratchpad only, not committed).

**Spec:** `lstm-trading-bot/docs/design.md`

## Global Constraints

- All paths below are relative to `/home/mirkolouis/Documents/ITD105/lstm-trading-bot/`.
- No exchange account, API key, or authenticated/order endpoint. Only `https://api.binance.com/api/v3/klines` is fetched.
- Wallet starts at `10000` USDT, `0` BTC.
- Signal: `changePct = (forecast[0] / closes[closes.length - 1] - 1) * 100`. BUY if `changePct > +threshold` and USDT available; SELL if `changePct < -threshold` and BTC held; otherwise HOLD. Default threshold `0.01` (%).
- Sizing: BUY spends `50`% of free USDT; SELL sells `100`% of held BTC. Both editable in the UI.
- Bot evaluates at most once per closed candle (keyed by candle open time).
- Code style: 4-space indent in new files; short comment on every function, loop, conditional and section; early returns; no duplicated logic. Reference files keep their 2-space indent (minimal diffs).
- Commits go on branch `lab/lstm-trading-bot` (main is guardrail-protected; the user merges), in this order: base → fixes → required bot → innovations → screenshots + README. Messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Dust balances:** after repeated 50% BUYs, free USDT falls below the minimum order → must HOLD, not place sub-cent orders (min order notional `10` USDT). Test in Task 3.
2. **Invalid UI inputs:** threshold/size fields emptied, negative, `NaN`, or size > 100 → value rejected, previous config kept, field shows the kept value. Test (`parseBotConfig`) in Task 3.
3. **Corrupt or old localStorage:** malformed JSON or missing fields → fresh wallet, no exception. Test in Task 4.
4. **Duplicate evaluation:** `tick()` runs every 1s but a 1m candle closes once a minute → the same candle time is evaluated once. Test in Task 3.
5. **SELL everything:** selling 100% must leave `btc === 0` exactly (no float residue) so the position flips to CASH. Test in Task 3.

---

### Task 1: Base code (unchanged reference)

**Files:**
- Create: `index.html`, `app.js`, `tiny-lstm.js`, `unroll-graph.js`, `LICENSE` — copied byte-for-byte from `msuiit-ph/BZUI-LSTM-BTCUSDT@b35fcd5`.
- Keep: `docs/design.md`, `docs/plan.md`.

- [ ] **Step 1:** Copy the five files from the scratchpad clone.
- [ ] **Step 2:** Verify `diff -r` against the clone shows only `docs/` and `.git` differ.
- [ ] **Step 3:** Serve (`python3 -m http.server`) and run the probe script: status line shows `Live · updated`, `errors: []`.
- [ ] **Step 4:** Commit `lstm-trading-bot: add BZUI-LSTM-BTCUSDT reference code (unmodified)` including `docs/`.

### Task 2: Fixes

**Files:** Modify `app.js` (`tick()` try/catch).

Bug: `#live-dot` is set to `error` on failure but never to `on`, so the "Live" indicator stays grey and stays red after recovery.

- [ ] **Step 1:** In the probe, assert `#live-dot[data-state]` after 5 s; expected (bug) `idle`.
- [ ] **Step 2:** Set `liveEl.dataset.state = 'on'` after a successful render in `tick()`.
- [ ] **Step 3:** Re-probe: `data-state="on"`, `errors: []`.
- [ ] **Step 4:** Commit `lstm-trading-bot: fix live indicator never switching on`.

### Task 3: Required bot (wallet + signal + UI)

**Files:**
- Create: `package.json` (`{"type":"module","scripts":{"test":"node --test tests/"}}`), `wallet.js`, `trading-bot.js`, `bot-ui.js`, `tests/wallet.test.js`, `tests/trading-bot.test.js`
- Modify: `index.html` (new bzUI card "Paper-trading bot" between chart card and network card; reuse `bz-card`, `bz-btn`, `bz-form-control`, `bz-table` classes), `app.js` (import bot, hook in `tick()`).

**Interfaces (produced):**
- `wallet.js`
  - `createWallet(initialUsdt = 10000) -> Wallet` where `Wallet = { initialUsdt, usdt, btc, avgEntry, feesPaid }`
  - `executeBuy(wallet, spendUsdt, price, feeRate = 0) -> { wallet, fill }` — fee taken from the USDT spent; `fill = { side:'BUY', price, qty, notional, fee }`
  - `executeSell(wallet, sellBtc, price, feeRate = 0) -> { wallet, fill }` — `sellBtc >= wallet.btc` sets `btc` to exactly `0`
  - `equity(wallet, price) -> number`; `pnl(wallet, price) -> { abs, pct }`; `positionOf(wallet) -> 'CASH' | 'BTC'` (BTC when `btc * price >= 1` USDT)
  - All functions return new objects; inputs are not mutated.
- `trading-bot.js`
  - `MIN_ORDER_USDT = 10`
  - `expectedChangePct(forecastPrice, lastClose) -> number`
  - `decideSignal({ changePct, thresholdPct, wallet, price, buyFraction }) -> 'BUY' | 'SELL' | 'HOLD'` (BUY needs `usdt * buyFraction >= MIN_ORDER_USDT`; SELL needs `btc * price >= MIN_ORDER_USDT`)
  - `parseBotConfig(raw, previous) -> Config` where `Config = { thresholdPct, buyPct, sellPct }`; invalid fields fall back to `previous`. Defaults `{ thresholdPct: 0.01, buyPct: 50, sellPct: 100 }`
  - `createBot({ config, wallet }) -> Bot` with `bot.state = { running, wallet, trades, lastEvaluatedTime, lastSignal, lastChangePct }`, `bot.start()`, `bot.stop()`, `bot.reset()`, `bot.setConfig(config)`, `bot.onClosedCandle({ time, lastClose, forecastNext }) -> { signal, trade } | null` (returns `null` when stopped or `time === lastEvaluatedTime`). `trade = { time, side, price, qty, changePct, usdtAfter, btcAfter, equityAfter }`.
- `bot-ui.js`: `createBotPanel({ bot, root }) -> { render(lastClose) }` — wires Start/Stop/Reset + config inputs, renders balances, equity, PnL, position, Running/Stopped badge, last signal, trade table (newest first).

- [ ] **Step 1: Failing tests** in `tests/wallet.test.js`:
  - `createWallet()` → `{usdt:10000, btc:0}`, `positionOf` = `'CASH'`.
  - buy 5000 USDT at 50000 → `btc === 0.1`, `usdt === 5000`, `equity(w, 50000) === 10000`, `pnl.abs === 0`.
  - then sell all at 55000 → `btc === 0`, `usdt === 10500`, `pnl.pct === 5`, `positionOf` = `'CASH'`.
  - sell all after three partial buys at different prices → `btc === 0` exactly (Review Focus 5).
  - `executeBuy` with `spendUsdt > usdt` throws `RangeError`.
- [ ] **Step 2: Failing tests** in `tests/trading-bot.test.js`:
  - `expectedChangePct(100.02, 100)` ≈ `0.02`.
  - threshold 0.01: `+0.02` with USDT → BUY; `-0.02` with BTC → SELL; `-0.02` with no BTC → HOLD; `+0.005` → HOLD.
  - `usdt = 15`, `buyFraction = 0.5` → HOLD (Review Focus 1).
  - `parseBotConfig({thresholdPct:'', buyPct:'-5', sellPct:'150'}, defaults)` returns defaults; `{thresholdPct:'0.05'}` → `0.05` (Review Focus 2).
  - bot stopped → `onClosedCandle` returns `null`; running, same `time` twice → second returns `null` (Review Focus 4); BUY trade appended with `changePct`, `usdtAfter`, `btcAfter`; `reset()` restores 10000 USDT, empty trades, `running === false`.
- [ ] **Step 3:** Run `npm test` in `lstm-trading-bot/` → FAIL (modules missing).
- [ ] **Step 4:** Implement `wallet.js` and `trading-bot.js`. Round BTC qty to 8 decimals, USDT to 8 decimals internally; display 2 / 6.
- [ ] **Step 5:** `npm test` → all pass.
- [ ] **Step 6:** Implement `bot-ui.js` + `index.html` card. Hook in `app.js` `tick()` after `forecast` is computed: `const r = bot.onClosedCandle({ time: last.time, lastClose: last.c, forecastNext: forecast[0] }); panel.render(last.c);`.
- [ ] **Step 7:** Browser check (probe extended to click `#bot-start`, wait up to 120 s on 1s candles): `#trade-rows tr` count ≥ 1, `#bot-status` = `Running`, `errors: []`. Click Reset → USDT `10,000.00`, 0 rows.
- [ ] **Step 8:** Commit `lstm-trading-bot: add in-code dummy wallet and LSTM paper-trading bot`.

### Task 4: Innovations

**Files:**
- Create: `storage.js`, `csv.js`, `tests/storage.test.js`, `tests/csv.test.js`
- Modify: `trading-bot.js`, `bot-ui.js`, `index.html`, `app.js`, `tests/trading-bot.test.js`

**Interfaces (produced / changed):**
- `Config` gains `feePct` (default `0.1`), `stopLossPct` (default `0.5`, `0` = off), `takeProfitPct` (default `0.5`, `0` = off), `mapeGate` (default `false`).
- `checkRiskExit({ wallet, price, stopLossPct, takeProfitPct }) -> 'STOP_LOSS' | 'TAKE_PROFIT' | null` — relative to `wallet.avgEntry`; checked before the LSTM signal; triggers a full SELL with `trade.reason` set.
- `bot.onClosedCandle({ time, lastClose, forecastNext, mape, baseMape })` — when `mapeGate` and `mape >= baseMape`, BUY/SELL become `HOLD` with `reason: 'MAPE_GATE'`. Every trade carries `reason: 'SIGNAL' | 'STOP_LOSS' | 'TAKE_PROFIT'` and `fee`.
- Benchmark: `bot.state.benchmark = { startPrice, btc }` set on first `start()` after reset (buy all 10000 USDT minus fee at that close); `benchmarkEquity(state, price) -> number`.
- `bot.state.equityHistory: Array<{ time, equity, benchmark }>` appended once per evaluated candle, capped at 1000.
- `storage.js`: `saveBotState(state, storage = localStorage)`, `loadBotState(storage = localStorage) -> state | null` (key `lstm-bot-state-v1`; returns `null` on parse error or missing fields; `running` always restored as `false`).
- `csv.js`: `tradesToCsv(trades) -> string` with header `time,side,reason,price,qty,fee,changePct,usdtAfter,btcAfter,equityAfter`; ISO time.
- `app.js`: `updateAccuracy()` returns `{ mape, baseMape } | null`; `buildOptions()` adds a text annotation `▲ BUY` / `▼ SELL` at the candle index of each trade within the visible candles.
- UI: fee / SL / TP inputs, MAPE-gate checkbox, benchmark PnL readout, equity-curve `BzChart` line chart (bot vs buy-and-hold), "Export CSV" button (Blob download `trades.csv`).

- [ ] **Step 1: Failing tests:** fee 0.1% on buy of 5000 → `fee === 5`, `btc === 4995/50000`; price falls 0.6% below entry with SL 0.5 → `'STOP_LOSS'`; rises 0.6% with TP 0.5 → `'TAKE_PROFIT'`; both `0` → `null`; mapeGate with `mape 0.02 ≥ baseMape 0.01` and BUY signal → HOLD; benchmark equity at +10% price ≈ `(10000 - 10) * 1.1`; `loadBotState` with storage returning `'{oops'` → `null` (Review Focus 3); round-trip save/load keeps trades, restores `running:false`; `tradesToCsv` header + one row, 10 columns.
- [ ] **Step 2:** `npm test` → new tests FAIL.
- [ ] **Step 3:** Implement; `npm test` → all pass.
- [ ] **Step 4:** Browser check: run 120 s on 1s candles, reload page → trades still listed, status `Stopped`; equity chart canvas present; CSV button produces a download whose first line is the header; `errors: []`.
- [ ] **Step 5:** Commit `lstm-trading-bot: add fees, benchmark, risk controls, equity chart, persistence and CSV export`.

### Task 5: Screenshots + README

**Files:** Create `screenshots/1_Account.png`, `2_TradeLog.png`, `3_ForecastNetwork.png` (+ `0_Initial.png` showing the untouched 10,000 USDT state), `README.md`, `.gitignore` (`node_modules/`).

- [ ] **Step 1:** Headless run on 1s candles until ≥ 1 BUY and ≥ 1 SELL (or 10 min cap); element screenshots of the bot card, trade table, and chart + both network sections.
- [ ] **Step 2:** README in the `tourist-arrivals-app/README.md` layout: `# ITD105 Lab: LSTM Crypto Trading Bot (BTC/USDT)`, Summary of the Activity, What the App Wants to Find Out, Dummy Account & Trading Strategy (wallet design, thresholds, hyperparameter table from PDF §3 with chosen values), How to Run, Screenshots (table) + Test Results analysis from the actual run, Changes from the Provided Source Code & Why (numbered, per file: Change / Why), Innovations, safety note (no exchange account/API keys).
- [ ] **Step 3:** Verify every image path in README exists (`grep -o 'screenshots/[^"]*' README.md | xargs ls`).
- [ ] **Step 4:** Run `spec-reviewer` on the full diff vs `docs/design.md` + this plan; fix blocking gaps.
- [ ] **Step 5:** Commit `lstm-trading-bot: add screenshots and README`; `git push -u origin lab/lstm-trading-bot`.
