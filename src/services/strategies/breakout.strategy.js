import {
  calculateEMA,
  calculateATR,
  calculateRSI,
} from "../indicators/indicators.service.js";

export const breakoutStrategy = (candles) => {
  if (candles.length < 60) return { signal: "HOLD", reason: "Not enough data" };

  const closes = candles.map((c) => c.close);
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);

  if (!last || !prev || !prev2) return { signal: "HOLD", reason: "No candles" };

  const price = last.close;

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const atr = calculateATR(candles);
  const rsi = calculateRSI(closes);

  const lastEMA20 = ema20.at(-1);
  const lastEMA50 = ema50.at(-1);
  const lastATR = atr.at(-1);
  const lastRSI = rsi.at(-1);

  if (!lastEMA20 || !lastEMA50 || !lastATR || !lastRSI)
    return { signal: "HOLD", reason: "Indicators not ready" };

  const atrPercent = (lastATR / price) * 100;
  if (atrPercent < 0.18) return { signal: "HOLD", reason: "Low volatility" };

  // Уровни без текущей свечи (нет lookahead)
  const lookback = closes.slice(-21, -1);
  const high20 = Math.max(...lookback);
  const low20 = Math.min(...lookback);

  // Объём — требуем реального подтверждения
  const volumes = candles.slice(-20).map((c) => c.volume);
  const avgVol =
    volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
  const volRatio = last.volume / avgVol;

  // Свеча — тело должно быть сильным
  const range = last.high - last.low || 1;
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;
  const bullish = last.close > last.open && bodyRatio > 0.5; // было 0.35
  const bearish = last.close < last.open && bodyRatio > 0.5; // было 0.35

  // Импульс — 2 свечи подтверждают направление
  const upMom = last.close > prev.close && prev.close > prev2.close;
  const downMom = last.close < prev.close && prev.close < prev2.close;

  const uptrend = lastEMA20 > lastEMA50;
  const downtrend = lastEMA20 < lastEMA50;

  // ======================
  // 🟢 BREAKOUT UP — только сильный пробой с объёмом
  // ======================
  if (
    price > high20 &&
    uptrend &&
    bullish &&
    lastRSI > 52 &&
    lastRSI < 75 &&
    volRatio > 1.3 && // было 1.0 — требуем объём
    upMom
  ) {
    return {
      signal: "BUY",
      reason: `Breakout up vol:${volRatio.toFixed(2)}x rsi:${lastRSI.toFixed(0)}`,
      confidence: 0.72,
    };
  }

  // ======================
  // 🔴 BREAKOUT DOWN — только сильный пробой с объёмом
  // ======================
  if (
    price < low20 &&
    downtrend &&
    bearish &&
    lastRSI < 48 &&
    lastRSI > 25 &&
    volRatio > 1.3 && // было 1.0 — требуем объём
    downMom
  ) {
    return {
      signal: "SELL",
      reason: `Breakout down vol:${volRatio.toFixed(2)}x rsi:${lastRSI.toFixed(0)}`,
      confidence: 0.72,
    };
  }

  return { signal: "HOLD", reason: "No breakout" };
};
