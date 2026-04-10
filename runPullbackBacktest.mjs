import "dotenv/config";
import mongoose from "mongoose";
import Candle from "./src/models/Candle.js";
import { pullbackStrategy } from "./src/services/strategies/pullback.strategy.js";
import { calculateATR } from "./src/services/indicators/indicators.service.js";

// ─── Настройки бэктеста для 15m Pullback ────────────────────────────────
const SYMBOL = "BTCUSDT";
const FEE = 0.001;
const SLIPPAGE = 0.0003;
const RISK_PER_TRADE = 0.01;
const ATR_SL = 1.0; // SL = 1 ATR (на 15m)
const ATR_TP = 3.0; // TP = 3 ATR (RR 3:1)
const MAX_HOLD = 48; // 48 свечей × 15 мин = 12 часов макс
const COOLDOWN = 16; // 16 свечей × 15 мин = 4 часа между сделками
const WINDOW_SIZE = 2000; // свечей 15m в одном окне (~21 день)

// ─── Бэктест функция для Pullback (multi-timeframe) ────────────────────
const backtestPullback = (candles15m, candles1h) => {
  let balance = 1000;
  let position = null;
  const trades = [];
  let cooldown = 0;

  const atrValues = calculateATR(candles15m);

  for (let i = 100; i < candles15m.length - 1; i++) {
    // Текущее время 15m свечи
    const currentTime = candles15m[i].openTime;

    // Находим соответствующие 1h свечи (все до текущего момента)
    const relevant1h = candles1h.filter((c) => c.openTime <= currentTime);
    if (relevant1h.length < 250) continue;

    // Срез 15m свечей до текущего момента
    const slice15m = candles15m.slice(Math.max(0, i - 100), i + 1);

    // Следующая свеча — для исполнения ордера
    const nextCandle = candles15m[i + 1];
    const execPrice = nextCandle?.open;
    if (!execPrice) continue;

    const atrIndex = Math.min(i, atrValues.length - 1);
    const currentATR = atrValues[atrIndex];
    if (!currentATR || currentATR === 0) continue;

    // ── Управление позицией ─────────────────────────────────────────────
    if (position) {
      const c = candles15m[i + 1];
      if (!c) continue;

      const holdTime = i - position.entryIndex;
      const currentPrice = c.close;

      // SL/TP цены
      const slPrice =
        position.type === "LONG"
          ? position.entry * (1 - position.slPct)
          : position.entry * (1 + position.slPct);
      const tpPrice =
        position.type === "LONG"
          ? position.entry * (1 + position.tpPct)
          : position.entry * (1 - position.tpPct);

      const hitSL =
        position.type === "LONG" ? c.low <= slPrice : c.high >= slPrice;
      const hitTP =
        position.type === "LONG" ? c.high >= tpPrice : c.low <= tpPrice;
      const timeExit = holdTime >= MAX_HOLD;

      if (hitSL || hitTP || timeExit) {
        let exitPrice = currentPrice;
        let reason = "TIME";

        if (hitSL && hitTP) {
          exitPrice = slPrice; // пессимистично
          reason = "SL";
        } else if (hitSL) {
          exitPrice = slPrice;
          reason = "SL";
        } else if (hitTP) {
          exitPrice = tpPrice;
          reason = "TP";
        }

        exitPrice *= position.type === "LONG" ? 1 - SLIPPAGE : 1 + SLIPPAGE;

        const pnl =
          position.type === "LONG"
            ? (exitPrice - position.entry) / position.entry
            : (position.entry - exitPrice) / position.entry;

        const profit = position.amount * pnl - position.amount * FEE * 2;
        balance += profit;

        trades.push({
          type: position.type,
          entry: position.entry,
          exit: exitPrice,
          profit,
          holdingTime: holdTime,
          reason,
        });

        position = null;
        cooldown = COOLDOWN;
      }
      continue;
    }

    // Cooldown
    if (cooldown > 0) {
      cooldown--;
      continue;
    }

    // ── Сигнал стратегии ────────────────────────────────────────────────
    const signal = pullbackStrategy(slice15m, relevant1h);
    if (!signal || signal.signal === "HOLD") continue;

    const slPct = (currentATR * ATR_SL) / execPrice;
    const tpPct = (currentATR * ATR_TP) / execPrice;
    if (slPct < 0.001) continue; // SL слишком маленький

    const riskAmount = balance * RISK_PER_TRADE;
    const posSize = Math.min(riskAmount / slPct, balance * 0.3);

    const actualEntry =
      signal.signal === "BUY"
        ? execPrice * (1 + SLIPPAGE)
        : execPrice * (1 - SLIPPAGE);

    position = {
      type: signal.signal === "BUY" ? "LONG" : "SHORT",
      entry: actualEntry,
      amount: posSize,
      entryIndex: i,
      slPct,
      tpPct,
    };
  }

  // ── Метрики ─────────────────────────────────────────────────────────
  const wins = trades.filter((t) => t.profit > 0);
  const losses = trades.filter((t) => t.profit < 0);
  const totalProfit = wins.reduce((s, t) => s + t.profit, 0);
  const totalLoss = losses.reduce((s, t) => s + Math.abs(t.profit), 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const profitFactor =
    totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

  let peak = 1000,
    maxDD = 0,
    running = 1000;
  for (const t of trades) {
    running += t.profit;
    if (running > peak) peak = running;
    const dd = (peak - running) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Разбивка по причинам
  const reasons = {};
  for (const t of trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;

  return {
    finalBalance: balance,
    totalTrades: trades.length,
    winRate,
    profitFactor,
    avgProfit: wins.length ? totalProfit / wins.length : 0,
    avgLoss: losses.length ? totalLoss / losses.length : 0,
    maxDrawdown: maxDD * 100,
    reasons,
    trades,
  };
};

// ─── Форматирование результатов ─────────────────────────────────────────
const format = (label, r) => {
  const pf = Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞";
  const wr = r.winRate.toFixed(1);
  const dd = (r.maxDrawdown ?? 0).toFixed(1);
  const avgW = r.avgProfit?.toFixed(2) ?? "0";
  const avgL = r.avgLoss?.toFixed(2) ?? "0";
  const rr = r.avgLoss > 0 ? (r.avgProfit / r.avgLoss).toFixed(2) : "—";
  const bal = r.finalBalance.toFixed(2);
  const pnl = (r.finalBalance - 1000).toFixed(2);
  const emoji =
    r.profitFactor >= 1.2 ? "✅" : r.profitFactor >= 1.0 ? "🟡" : "🔴";
  const exits = Object.entries(r.reasons)
    .map(([k, v]) => `${k}:${v}`)
    .join(" | ");

  console.log(`\n${emoji} ${label}`);
  console.log(`   Balance:    1000 → ${bal}  (${pnl >= 0 ? "+" : ""}${pnl})`);
  console.log(`   Trades:     ${r.totalTrades}  (WR ${wr}%)`);
  console.log(
    `   PF:         ${pf}  (avg win: ${avgW}, avg loss: ${avgL}, RR: ${rr})`,
  );
  console.log(`   Max DD:     ${dd}%`);
  console.log(`   Exits:      ${exits || "—"}`);
};

// ─── Главная функция ────────────────────────────────────────────────────
const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Mongo connected\n");

  // Загружаем 15m свечи
  const candles15m = (
    await Candle.find({ symbol: SYMBOL, interval: "15m" })
      .sort({ openTime: -1 })
      .limit(8000)
  ).reverse();

  // Загружаем 1h свечи
  const candles1h = (
    await Candle.find({ symbol: SYMBOL, interval: "1h" })
      .sort({ openTime: -1 })
      .limit(2000)
  ).reverse();

  console.log(`📊 15m candles: ${candles15m.length}`);
  console.log(`📊 1h candles:  ${candles1h.length}`);

  if (candles15m.length < 500) {
    console.log("\n❌ Недостаточно 15m свечей в базе!");
    console.log("   Нужно минимум 500, есть:", candles15m.length);
    console.log("\n   Запусти сначала накачку свечей:");
    console.log("   node fetch15m.mjs");
    await mongoose.disconnect();
    return;
  }

  if (candles1h.length < 300) {
    console.log("\n❌ Недостаточно 1h свечей в базе!");
    await mongoose.disconnect();
    return;
  }

  const from15m = new Date(candles15m[0].openTime).toISOString().slice(0, 10);
  const to15m = new Date(candles15m.at(-1).openTime).toISOString().slice(0, 10);
  console.log(`   ${from15m} → ${to15m}`);

  // ── Walk-Forward: разбиваем 15m на окна ───────────────────────────────
  const windows = [];
  for (let i = 0; i + WINDOW_SIZE <= candles15m.length; i += WINDOW_SIZE) {
    const w15m = candles15m.slice(i, i + WINDOW_SIZE);
    const startTime = w15m[0].openTime;
    const endTime = w15m.at(-1).openTime;

    // Находим 1h свечи для этого окна + 250 свечей контекста до начала
    const w1h = candles1h.filter((c) => c.openTime <= endTime);

    windows.push({
      index: windows.length + 1,
      candles15m: w15m,
      candles1h: w1h,
      from: new Date(startTime),
      to: new Date(endTime),
    });
  }

  console.log(
    `\n📐 ${windows.length} windows of ${WINDOW_SIZE} × 15m candles (~${Math.round((WINDOW_SIZE * 15) / 60 / 24)} days each)\n`,
  );

  if (windows.length === 0) {
    console.log("❌ Недостаточно данных для walk-forward");
    await mongoose.disconnect();
    return;
  }

  // ── Прогоняем каждое окно ─────────────────────────────────────────────
  const results = [];

  for (const w of windows) {
    console.log("═".repeat(80));
    const startP = w.candles15m[0].close;
    const endP = w.candles15m.at(-1).close;
    const change = (((endP - startP) / startP) * 100).toFixed(1);
    console.log(
      `WINDOW ${w.index}: ${w.from.toISOString().slice(0, 10)} → ${w.to.toISOString().slice(0, 10)} | BTC ${change}%`,
    );
    console.log("─".repeat(80));

    const r = backtestPullback(w.candles15m, w.candles1h);
    results.push(r);
    format("Pullback 15m", r);
    console.log();
  }

  // ── Сводка ────────────────────────────────────────────────────────────
  console.log("═".repeat(80));
  console.log("SUMMARY — Pullback 15m Walk-Forward");
  console.log("═".repeat(80));

  const pfs = results.map((r) =>
    Number.isFinite(r.profitFactor) ? r.profitFactor : 3,
  );
  const pnls = results.map((r) => r.finalBalance - 1000);
  const totalTrades = results.reduce((s, r) => s + r.totalTrades, 0);
  const profitable = results.filter((r) => r.finalBalance > 1000).length;

  const avgPF = (pfs.reduce((a, b) => a + b, 0) / pfs.length).toFixed(2);
  const minPF = Math.min(...pfs).toFixed(2);
  const maxPF = Math.max(...pfs).toFixed(2);
  const totalPnL = pnls.reduce((a, b) => a + b, 0).toFixed(1);

  const stab =
    profitable === windows.length
      ? "✅"
      : profitable >= windows.length / 2
        ? "🟡"
        : "🔴";

  console.log(`\n${stab} Pullback 15m`);
  console.log(`   PF:            avg ${avgPF}  (min ${minPF}, max ${maxPF})`);
  console.log(`   Profitable:    ${profitable}/${windows.length} windows`);
  console.log(`   Total PnL:     ${totalPnL}`);
  console.log(`   Total trades:  ${totalTrades}`);
  console.log("\n" + "═".repeat(80));

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
