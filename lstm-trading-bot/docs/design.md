# Design: LSTM Crypto Trading Bot (BTC/USDT) — ITD105 Lab

## Intent
Complete the ITD105 lab "Building and Testing an LSTM Crypto Trading Bot (BTC/USDT)":
extend the reference app `msuiit-ph/BZUI-LSTM-BTCUSDT` into a paper-trading bot with an
in-code dummy wallet, then add upgrades. Lives in the ITD105 subject repo beside
`tourist-arrivals-app/`, documented the same way (base code → fixes → innovations).

## Goals
- Reference code copied unchanged first, so its diffs show what was added.
- Required by the PDF: in-code virtual wallet (USDT, BTC, position, equity, PnL, reset),
  LSTM signal (BUY/SELL/HOLD on closed candles), simulated orders + trade history,
  bzUI controls (balances, Running/Stopped, Start/Stop/Reset, trade table).
- Innovations: fees + buy-and-hold benchmark, stop-loss/take-profit + MAPE gate,
  equity-curve chart + trade markers, localStorage persistence + CSV export.
- README in the layout of `tourist-arrivals-app/README.md`, plus the PDF's required sections.

## Non-goals / anti-goals
- No exchange account, testnet, API key or real funds. Only the public, keyless
  Binance klines endpoint is called. Any order/account API call is a failure.
- No change to the TinyLSTM model math.

## Approaches
1. **Separate ES modules + one hook in `app.js`** (chosen). Wallet, bot and bot UI in
   their own files; `tick()` passes the forecast to the bot when a new closed candle
   arrives. Keeps reference files near upstream and logic unit-testable in Node.
2. Everything inline in `app.js`: rejected; mixes concerns and blurs the base-vs-added diff.
3. Separate trading page: rejected; loses the live chart/network views the screenshots need.

## Decisions (user)
- Signal: `forecast[0]` (next candle) vs `closes[closes.length - 1]`.
- Sizing: BUY spends 50% of free USDT, SELL sells 100% of BTC; threshold ±0.01%.
  Both editable in the UI.
- Git: commits on branch `lab/lstm-trading-bot`, pushed; the user merges into main (guardrail blocks main commits).
- Commit sequence: base → fixes → required bot → innovations → screenshots + README.

## Decisions (builder's calls)
- Fixes: the live indicator dot is never set to `on`; set it on success, clear `error` on recovery.
- Fee 0.1% taker per order, editable; benchmark = buy all at the price when the bot first starts.
- Stop-loss / take-profit default off-able (e.g. −0.5% / +0.5% from average entry), checked each closed candle before the LSTM signal.
- MAPE gate: optional toggle; when on, BUY/SELL becomes HOLD while LSTM MAPE ≥ baseline MAPE.
- Bot evaluates once per new closed candle (same `trainedAt` change that triggers training).

## Verification
- `node --test` on wallet and signal logic (balance conservation, thresholds, fees, reset, SL/TP).
- Headless Chromium on 1s candles: bot runs until ≥1 trade, no console errors; screenshots
  captured into `screenshots/` from that run.
