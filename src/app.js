import "dotenv/config";
import { fetchAndStoreCandles } from "./services/market/market.service.js";
import Candle from "./models/Candle.js";
import { momentumStrategy } from "./services/strategies/momentum.strategy.js";
import { meanReversionStrategy } from "./services/strategies/meanReversion.strategy.js";
import { breakoutStrategy } from "./services/strategies/breakout.strategy.js";
import { backtest } from "./services/backtest/backtest.service.js";
import { detectMarketRegime } from "./services/market/marketRegime.js";
import { calculateATR } from "./services/indicators/indicators.service.js";
import Position from "./models/Position.model.js";
import { getHigherTimeframeTrend } from "./services/market/multiTimeframe.service.js";
import {
  openPosition,
  monitorPositions,
  getUSDTBalance,
  getFuturesBalance,
  getCurrentPrice,
} from "./services/execution/execution.service.js";
import {
  notifyStart,
  notifySignal,
  notifyOpenPosition,
  notifyNoEdge,
  notifyError,
  notifyLowBalance,
} from "./services/telegram/telegram.service.js";

const SYMBOL = "BTCUSDT";
const INTERVAL = "1h";
const LIMIT = 2000;

// ─── Пороги качества стратегий ────────────────────────────────────────────
const MIN_BALANCE = 10;
const MIN_PROFIT_FACTOR = 1.2;
const MIN_WIN_RATE = 42;
const MIN_TRADES_REQUIRED = 10;
const MAX_DRAWDOWN_ALLOWED = 20;
const RISK_PERCENT = 0.01;
const MIN_USDT_AMOUNT = 15;

// ─── ML режим ─────────────────────────────────────────────────────────────
// ВРЕМЕННО: ML-гейт отключён до починки модели.
// ML продолжает вызываться и логироваться для сбора статистики,
// но НЕ блокирует торговлю. Направление решает стратегия.
// Когда модель будет готова — поменять ML_ENABLED на true.
const ML_ENABLED = false;
const ML_LONG_THRESHOLD = 0.62;
const ML_SHORT_THRESHOLD = 0.62;

// ─── Состояние бота ───────────────────────────────────────────────────────
export const botState = {
  regime: "—",
  htfTrend: "—",
  volatility: 0,
  bestStrategy: "—",
  lastRun: null,
  mlConfidence: 0,
  mlSignal: "—",
  mlDirection: "—",
  spotBalance: 0,
  futuresBalance: 0,
  strategies: [],
};

// ─── Вспомогательные функции ──────────────────────────────────────────────
const printResult = (title, r) => {
  const pf = Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞";
  const pfEmoji =
    r.profitFactor >= 1.2 ? "✅" : r.profitFactor >= 0.9 ? "🟡" : "🔴";
  console.log(`\n📈 ${title}`);
  console.log(`  Balance:      ${r.finalBalance.toFixed(2)}`);
  console.log(`  Trades:       ${r.totalTrades}`);
  console.log(`  WinRate:      ${r.winRate.toFixed(1)}%`);
  console.log(`  ProfitFactor: ${pf} ${pfEmoji}`);
  console.log(`  MaxDrawdown:  ${r.maxDrawdown?.toFixed(1)}%`);
};

const getVolatility = (candles) => {
  const atr = calculateATR(candles);
  const lastATR = atr.at(-1);
  const price = candles.at(-1)?.close;
  return price && lastATR ? (lastATR / price) * 100 : 0;
};

const getVolumeRatio = (candles) => {
  const volumes = candles.slice(-20).map((c) => c.volume);
  const avgVolume =
    volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
  const lastVol = candles.at(-1)?.volume ?? 0;
  return avgVolume > 0 ? lastVol / avgVolume : 0;
};

const getRiskProfile = (strategyName) => {
  if (strategyName === "Momentum") return { sl: 1.5, tp: 3.5 };
  if (strategyName === "Breakout") return { sl: 1.5, tp: 3.5 };
  if (strategyName === "Mean Reversion") return { sl: 1.5, tp: 3.5 };
  return { sl: 1.5, tp: 3.5 };
};

const calcSLTP = (side, price, atr, strategyName) => {
  const profile = getRiskProfile(strategyName);
  return side === "BUY"
    ? {
        stopLoss: price - atr * profile.sl,
        takeProfit: price + atr * profile.tp,
      }
    : {
        stopLoss: price + atr * profile.sl,
        takeProfit: price - atr * profile.tp,
      };
};

const isQualityOk = (r) => {
  if (!r) return false;
  return (
    r.totalTrades >= MIN_TRADES_REQUIRED &&
    r.profitFactor >= MIN_PROFIT_FACTOR &&
    r.winRate >= MIN_WIN_RATE &&
    (r.maxDrawdown ?? 100) <= MAX_DRAWDOWN_ALLOWED
  );
};

const filterValid = (strategies, regime, htfTrend, direction) =>
  strategies.filter((x) => {
    const r = x.result;

    if (!isQualityOk(r)) {
      console.log(
        `  ❌ ${x.name}: PF=${r?.profitFactor?.toFixed(2)} ` +
          `WR=${r?.winRate?.toFixed(1)}% trades=${r?.totalTrades} ` +
          `DD=${r?.maxDrawdown?.toFixed(1)}% → не прошёл фильтр качества`,
      );
      return false;
    }

    if (direction === "LONG") {
      if (x.name === "Momentum") {
        const ok =
          regime === "UPTREND" ||
          (regime === "RANGE" && htfTrend === "UPTREND");
        if (!ok)
          console.log(
            `  ⚠️  ${x.name}: режим ${regime}/${htfTrend} не подходит для LONG`,
          );
        return ok;
      }
      if (x.name === "Breakout") {
        const ok = regime === "UPTREND" && htfTrend !== "DOWNTREND";
        if (!ok)
          console.log(
            `  ⚠️  ${x.name}: режим ${regime}/${htfTrend} не подходит для LONG`,
          );
        return ok;
      }
      if (x.name === "Mean Reversion") {
        const ok = regime === "RANGE";
        if (!ok)
          console.log(
            `  ⚠️  ${x.name}: режим ${regime} не подходит для Mean Reversion`,
          );
        return ok;
      }
    }

    if (direction === "SHORT") {
      if (x.name === "Momentum") {
        const ok =
          regime === "DOWNTREND" ||
          (regime === "RANGE" && htfTrend === "DOWNTREND");
        if (!ok)
          console.log(
            `  ⚠️  ${x.name}: режим ${regime}/${htfTrend} не подходит для SHORT`,
          );
        return ok;
      }
      if (x.name === "Breakout") {
        const ok = regime === "DOWNTREND" && htfTrend !== "UPTREND";
        if (!ok)
          console.log(
            `  ⚠️  ${x.name}: режим ${regime}/${htfTrend} не подходит для SHORT`,
          );
        return ok;
      }
      if (x.name === "Mean Reversion") {
        const ok = regime === "RANGE";
        if (!ok)
          console.log(
            `  ⚠️  ${x.name}: режим ${regime} не подходит для Mean Reversion`,
          );
        return ok;
      }
    }

    return false;
  });

const getStrategyScore = (result) => {
  const pf = Number.isFinite(result.profitFactor) ? result.profitFactor : 3;
  const wr = result.winRate ?? 0;
  const dd = result.maxDrawdown ?? 100;
  const trades = result.totalTrades ?? 0;
  return pf * 40 + wr * 0.8 + trades * 1.5 - dd * 1.2;
};

const sortBest = (strategies) =>
  [...strategies].sort(
    (a, b) => getStrategyScore(b.result) - getStrategyScore(a.result),
  );

// ─── Отправка фидбека в ML при закрытии позиции ───────────────────────────
export const sendFeedbackToML = async (
  position,
  candles1h,
  candles4h,
  candles1d,
) => {
  try {
    const body = {
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: position.exitPrice,
      pnlUSDT: position.pnlUSDT,
      strategy: position.strategy ?? "Unknown",
      mlSignal: position.mlSignal ?? "HOLD",
      mlConfidence: position.mlConfidence ?? 0,
      closeReason: position.closeReason,
      candles1h: candles1h.slice(-300),
      candles4h: candles4h.slice(-100),
      candles1d: candles1d.slice(-60),
      fundingRate: [],
      openInterest: [],
      longShortRatio: [],
    };

    const resp = await fetch(`${process.env.ML_SERVICE_URL}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await resp.json();
    console.log(
      `📤 Фидбек отправлен в ML | label: ${result.label} | ` +
        `всего фидбеков: ${result.feedbackCount}`,
    );
  } catch (err) {
    console.warn(`⚠️ Не удалось отправить фидбек в ML: ${err.message}`);
  }
};

// ─── Основная функция бота ────────────────────────────────────────────────
export const start = async () => {
  try {
    console.log(
      `\n🤖 [${new Date().toLocaleTimeString()}] Trading system...\n`,
    );

    await fetchAndStoreCandles(SYMBOL, INTERVAL);
    await fetchAndStoreCandles(SYMBOL, "4h");
    await fetchAndStoreCandles(SYMBOL, "1d");

    const candles1h = (
      await Candle.find({ symbol: SYMBOL, interval: "1h" })
        .sort({ openTime: -1 })
        .limit(LIMIT)
    ).reverse();
    const candles4h = (
      await Candle.find({ symbol: SYMBOL, interval: "4h" })
        .sort({ openTime: -1 })
        .limit(500)
    ).reverse();
    const candles1d = (
      await Candle.find({ symbol: SYMBOL, interval: "1d" })
        .sort({ openTime: -1 })
        .limit(200)
    ).reverse();

    await monitorPositions(candles1h, candles4h, candles1d);

    const spotBalance = await getUSDTBalance();
    const futuresBalance = await getFuturesBalance();

    console.log(`💰 Спот баланс:     ${spotBalance.toFixed(2)} USDT`);
    console.log(`💰 Фьючерс баланс:  ${futuresBalance.toFixed(2)} USDT`);

    if (spotBalance < MIN_BALANCE && futuresBalance < MIN_BALANCE) {
      await notifyLowBalance({ balance: spotBalance, required: MIN_BALANCE });
      return;
    }

    const candles = candles1h;

    if (!candles || candles.length < 300) {
      console.log("❌ Недостаточно свечей");
      return;
    }

    const splitIndex = Math.floor(candles.length * 0.8);
    const backtestCandles = candles.slice(0, splitIndex);
    const liveCandles = candles.slice(0);

    // Бэктестим только Breakout (Momentum и MeanReversion закомментированы)
    const breakoutResult = backtest(backtestCandles, breakoutStrategy);
    // const momentumResult = backtest(backtestCandles, momentumStrategy);
    // const meanResult = backtest(backtestCandles, meanReversionStrategy);

    const regime = detectMarketRegime(candles);
    const volatility = getVolatility(candles);
    const htfTrend = await getHigherTimeframeTrend(SYMBOL);
    const volRatio = getVolumeRatio(candles);

    console.log(`🧠 1h Regime: ${regime}  |  4h Trend: ${htfTrend}`);
    console.log(`📊 Volatility (ATR): ${volatility.toFixed(2)}%`);
    console.log(`📊 Volume ratio: ${volRatio.toFixed(2)}x`);

    printResult("Breakout", breakoutResult);

    Object.assign(botState, {
      regime,
      htfTrend,
      volatility,
      lastRun: new Date().toISOString(),
      spotBalance,
      futuresBalance,
      strategies: [{ name: "Breakout", ...breakoutResult }],
    });

    await notifyStart({
      symbol: SYMBOL,
      interval: INTERVAL,
      balance: spotBalance,
      regime,
      volatility,
    });

    if (volatility < 0.18) {
      console.log("🧊 Flat / low volatility → skip");
      return;
    }

    // ── ML предсказание (только логирование, НЕ блокирует торговлю) ──────
    let confidence = 0.5;
    let mlSignal = "HOLD";

    try {
      const mlResponse = await fetch(`${process.env.ML_SERVICE_URL}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candles1h: liveCandles,
          candles4h: candles4h,
          candles1d: candles1d,
          fundingRate: [],
          openInterest: [],
          longShortRatio: [],
        }),
      });

      const mlResult = await mlResponse.json();
      confidence = mlResult.confidence ?? 0.5;
      mlSignal = mlResult.signal ?? "HOLD";

      console.log(
        `\n🧠 ML-Service: ${mlSignal} | ` +
          `BUY=${(mlResult.buy * 100).toFixed(1)}% ` +
          `HOLD=${(mlResult.hold * 100).toFixed(1)}% ` +
          `SELL=${(mlResult.sell * 100).toFixed(1)}% ` +
          `(conf: ${(confidence * 100).toFixed(1)}%)`,
      );

      if (!ML_ENABLED) {
        console.log(
          `ℹ️ ML_ENABLED=false → ML только логируется, решает стратегия`,
        );
      }
    } catch (e) {
      console.log(`⚠️ ML-Service недоступен: ${e.message} — продолжаем без ML`);
    }

    botState.mlConfidence = confidence;
    botState.mlSignal = mlSignal;

    // ── Определение направления ──────────────────────────────────────────
    // Если ML включён — используем его как раньше.
    // Если выключен — получаем сигнал от Breakout напрямую, направление из него.
    let direction = null;

    if (ML_ENABLED) {
      if (mlSignal === "BUY" && confidence >= ML_LONG_THRESHOLD) {
        direction = "LONG";
        console.log(`✅ ML → LONG (BUY ${(confidence * 100).toFixed(1)}%)`);
      } else if (mlSignal === "SELL" && confidence >= ML_SHORT_THRESHOLD) {
        direction = "SHORT";
        console.log(`✅ ML → SHORT (SELL ${(confidence * 100).toFixed(1)}%)`);
      } else {
        console.log(
          `⏸️ ML → HOLD (${mlSignal} ${(confidence * 100).toFixed(1)}%) — не торгуем`,
        );
        return;
      }
    } else {
      // ML отключён — сигнал от стратегии напрямую
      const preliminarySignal = breakoutStrategy(liveCandles);
      if (preliminarySignal.signal === "BUY") {
        direction = "LONG";
      } else if (preliminarySignal.signal === "SELL") {
        direction = "SHORT";
      } else {
        console.log(`⏸️ Breakout → HOLD (${preliminarySignal.reason})`);
        return;
      }
      console.log(`✅ Strategy → ${direction} (${preliminarySignal.reason})`);
    }

    botState.mlDirection = direction;

    // ── Фильтрация стратегий (только Breakout) ───────────────────────────
    const allStrategies = [
      { name: "Breakout", fn: breakoutStrategy, result: breakoutResult },
      // { name: "Momentum", fn: momentumStrategy, result: momentumResult },
      // { name: "Mean Reversion", fn: meanReversionStrategy, result: meanResult },
    ];

    console.log(
      `\n🔍 Фильтрация стратегий для ${direction} (режим: ${regime}, HTF: ${htfTrend}):`,
    );
    const valid = filterValid(allStrategies, regime, htfTrend, direction);
    botState.bestStrategy = valid.length ? sortBest(valid)[0].name : "None";

    if (!valid.length) {
      console.log(
        `\n⚠️ Нет стратегий с достаточным качеством для ${direction}`,
      );
      console.log(
        `   Требования: PF≥${MIN_PROFIT_FACTOR}, WR≥${MIN_WIN_RATE}%, trades≥${MIN_TRADES_REQUIRED}, DD≤${MAX_DRAWDOWN_ALLOWED}%`,
      );
      await notifyNoEdge({ symbol: SYMBOL, regime });
      return;
    }

    const best = sortBest(valid)[0];
    const liveSignal = best.fn(liveCandles);

    console.log(`\n🏆 Strategy: ${best.name}`);
    console.log(
      `   PF: ${best.result.profitFactor.toFixed(2)} | WR: ${best.result.winRate.toFixed(1)}% | Trades: ${best.result.totalTrades}`,
    );
    console.log(`📡 Signal: ${liveSignal.signal} — ${liveSignal.reason}`);
    console.log(`🔍 4h Trend: ${htfTrend} | Volume: ${volRatio.toFixed(2)}x`);

    // Проверка что сигнал соответствует выбранному направлению
    const expectedSignal = direction === "LONG" ? "BUY" : "SELL";
    if (liveSignal.signal !== expectedSignal) {
      console.log(
        `⏸️ Стратегия (${liveSignal.signal}) ≠ направление (${direction}) → пропускаем`,
      );
      return;
    }

    // Объёмные фильтры
    if (best.name === "Breakout" && volRatio < 1.3) {
      console.log("⛔ Breakout rejected: слабый объём");
      await notifyNoEdge({ symbol: SYMBOL, regime });
      return;
    }
    if (best.name === "Momentum" && volRatio < 0.9) {
      console.log("⛔ Momentum rejected: слабый объём");
      await notifyNoEdge({ symbol: SYMBOL, regime });
      return;
    }

    await notifySignal({
      strategy: best.name,
      signal: liveSignal.signal,
      reason: `[${direction}] ${liveSignal.reason}`,
      symbol: SYMBOL,
    });

    const currentPrice = await getCurrentPrice(SYMBOL);
    const lastATR = calculateATR(candles).at(-1);
    if (!lastATR) return;

    const side = direction === "LONG" ? "BUY" : "SELL";
    const { stopLoss, takeProfit } = calcSLTP(
      side,
      currentPrice,
      lastATR,
      best.name,
    );

    // Фиксированный риск — ML-scaling убран пока модель бесполезна
    const balance = futuresBalance;
    const usdtAmount = Math.max(balance * RISK_PERCENT, MIN_USDT_AMOUNT);

    console.log(
      `\n💸 ${side} | ${usdtAmount.toFixed(2)} USDT | ` +
        `SL: ${stopLoss.toFixed(2)} | TP: ${takeProfit.toFixed(2)}`,
    );

    // Cooldown 30 минут после последней закрытой сделки
    const lastClosed = await Position.findOne({
      symbol: SYMBOL,
      status: "CLOSED",
    }).sort({ closedAt: -1 });

    if (lastClosed?.closedAt) {
      const minutesSinceClose =
        (Date.now() - new Date(lastClosed.closedAt).getTime()) / 60000;
      if (minutesSinceClose < 30) {
        console.log(`⏳ Cooldown: ${minutesSinceClose.toFixed(1)} мин`);
        return;
      }
    }

    const position = await openPosition({
      symbol: SYMBOL,
      side,
      usdtAmount,
      stopLoss,
      takeProfit,
      strategy: best.name,
      mlSignal,
      mlConfidence: confidence,
    });

    if (position) {
      await notifyOpenPosition({
        symbol: SYMBOL,
        side,
        entryPrice: position.entryPrice,
        quantity: position.quantity,
        stopLoss,
        takeProfit,
        usdtAmount,
      });
      console.log(`✅ ${direction} позиция открыта!`);
    }
  } catch (err) {
    console.error("❌ ERROR:", err.message);
    await notifyError(err.message);
  }
};
