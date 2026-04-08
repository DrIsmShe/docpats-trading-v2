import "dotenv/config";
import mongoose from "mongoose";
import Candle from "./src/models/Candle.js";
import { backtest } from "./src/services/backtest/backtest.service.js";
import { momentumStrategy } from "./src/services/strategies/momentum.strategy.js";
import { meanReversionStrategy } from "./src/services/strategies/meanReversion.strategy.js";
import { breakoutStrategy } from "./src/services/strategies/breakout.strategy.js";

const SYMBOL = "BTCUSDT";
const LIMIT = 2000;
const WINDOW_SIZE = 500;

const STRATEGIES = [
  { name: "Momentum", fn: momentumStrategy },
  { name: "Mean Reversion", fn: meanReversionStrategy },
  { name: "Breakout", fn: breakoutStrategy },
];

const formatShort = (r) => {
  const pf = Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞";
  const wr = r.winRate.toFixed(0);
  const pnl = (r.finalBalance - 1000).toFixed(1);
  const emoji =
    r.profitFactor >= 1.2 ? "✅" : r.profitFactor >= 1.0 ? "🟡" : "🔴";
  return `${emoji} PF ${pf.padStart(5)} | WR ${wr.padStart(2)}% | Trades ${String(r.totalTrades).padStart(3)} | PnL ${pnl.padStart(7)}`;
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Mongo connected\n");

  const candles = (
    await Candle.find({ symbol: SYMBOL, interval: "1h" })
      .sort({ openTime: -1 })
      .limit(LIMIT)
  ).reverse();

  console.log(`📊 Loaded ${candles.length} candles`);
  console.log(
    `   ${new Date(candles[0].openTime).toISOString()} → ${new Date(candles.at(-1).openTime).toISOString()}`,
  );

  // Разбиваем на окна
  const windows = [];
  for (let i = 0; i + WINDOW_SIZE <= candles.length; i += WINDOW_SIZE) {
    windows.push({
      index: windows.length + 1,
      candles: candles.slice(i, i + WINDOW_SIZE),
      from: new Date(candles[i].openTime),
      to: new Date(candles[i + WINDOW_SIZE - 1].openTime),
    });
  }

  console.log(
    `\n📐 Split into ${windows.length} windows of ${WINDOW_SIZE} candles (~${Math.round(WINDOW_SIZE / 24)} days each)\n`,
  );

  // Прогоняем каждую стратегию на каждом окне
  const results = {};
  for (const strat of STRATEGIES) {
    results[strat.name] = [];
  }

  for (const w of windows) {
    console.log("═".repeat(80));
    console.log(
      `WINDOW ${w.index}: ${w.from.toISOString().slice(0, 10)} → ${w.to.toISOString().slice(0, 10)}`,
    );

    // Считаем движение цены в окне
    const startPrice = w.candles[0].close;
    const endPrice = w.candles.at(-1).close;
    const priceChange = (((endPrice - startPrice) / startPrice) * 100).toFixed(
      1,
    );
    const high = Math.max(...w.candles.map((c) => c.high));
    const low = Math.min(...w.candles.map((c) => c.low));
    const range = (((high - low) / startPrice) * 100).toFixed(1);
    console.log(
      `  Market: ${startPrice.toFixed(0)} → ${endPrice.toFixed(0)} (${priceChange}%), range ${range}%`,
    );
    console.log("─".repeat(80));

    for (const strat of STRATEGIES) {
      const r = backtest(w.candles, strat.fn);
      results[strat.name].push(r);
      console.log(`  ${strat.name.padEnd(18)} ${formatShort(r)}`);
    }
    console.log();
  }

  // Сводная таблица — стабильность по окнам
  console.log("═".repeat(80));
  console.log("SUMMARY — stability across windows");
  console.log("═".repeat(80));

  for (const strat of STRATEGIES) {
    const rs = results[strat.name];
    const pfs = rs.map((r) =>
      Number.isFinite(r.profitFactor) ? r.profitFactor : 3,
    );
    const pnls = rs.map((r) => r.finalBalance - 1000);
    const trades = rs.map((r) => r.totalTrades);

    const avgPF = (pfs.reduce((a, b) => a + b, 0) / pfs.length).toFixed(2);
    const minPF = Math.min(...pfs).toFixed(2);
    const maxPF = Math.max(...pfs).toFixed(2);
    const totalPnL = pnls.reduce((a, b) => a + b, 0).toFixed(1);
    const totalTrades = trades.reduce((a, b) => a + b, 0);
    const profitableWindows = rs.filter((r) => r.finalBalance > 1000).length;

    const stability =
      profitableWindows === windows.length
        ? "✅"
        : profitableWindows >= windows.length / 2
          ? "🟡"
          : "🔴";

    console.log(`\n${stability} ${strat.name}`);
    console.log(`   PF:            avg ${avgPF}  (min ${minPF}, max ${maxPF})`);
    console.log(
      `   Profitable:    ${profitableWindows}/${windows.length} windows`,
    );
    console.log(`   Total PnL:     ${totalPnL}`);
    console.log(`   Total trades:  ${totalTrades}`);
  }

  console.log("\n" + "═".repeat(80));
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
