import {
  calculateRSI,
  calculateEMA,
  calculateATR,
} from "../indicators/indicators.service.js";

const calculateBB = (closes, period = 20, multiplier = 2) => {
  const result = [];
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(
      slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period,
    );
    result.push({
      upper: mean + multiplier * std,
      middle: mean,
      lower: mean - multiplier * std,
    });
  }
  return result;
};

export const meanReversionStrategy = (candles) => {
  if (candles.length < 60) return { signal: "HOLD", reason: "Not enough data" };

  const closes = candles.map((c) => c.close);
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);

  if (!last || !prev) return { signal: "HOLD", reason: "No candles" };

  const price = last.close;
  const rsi = calculateRSI(closes);
  const ema50 = calculateEMA(closes, 50);
  const atr = calculateATR(candles);
  const bb = calculateBB(closes, 20);

  const lastRSI = rsi.at(-1);
  const prevRSI = rsi.at(-2);
  const lastATR = atr.at(-1);
  const lastBB = bb.at(-1);
  const lastEMA50 = ema50.at(-1);

  if (!lastRSI || !prevRSI || !lastATR || !lastBB || !lastEMA50)
    return { signal: "HOLD", reason: "Indicators not ready" };

  const atrPercent = (lastATR / price) * 100;
  if (atrPercent < 0.18) return { signal: "HOLD", reason: "Low volatility" };

  const bbWidth = (lastBB.upper - lastBB.lower) / lastBB.middle;
  if (bbWidth < 0.01) return { signal: "HOLD", reason: "BB too tight" };

  // Подтверждение разворота — 2 свечи
  const twoGreenBars = prev2
    ? last.close > last.open && prev.close > prev.open
    : last.close > last.open && last.close > prev.close;

  const twoRedBars = prev2
    ? last.close < last.open && prev.close < prev.open
    : last.close < last.open && last.close < prev.close;

  // RSI разворачивается вверх (минимум 2 бара роста)
  const rsiTurningUp = lastRSI > prevRSI;
  const rsiTurningDown = lastRSI < prevRSI;

  // ── BUY — перепродан, разворот вверх ────────────
  if (lastRSI < 32 && price < lastBB.lower && rsiTurningUp && twoGreenBars) {
    return {
      signal: "BUY",
      reason: `MeanRev BUY rsi:${lastRSI.toFixed(0)} below BB`,
      confidence: 0.78,
    };
  }

  // ── SELL — перекуплен, разворот вниз ────────────
  if (lastRSI > 68 && price > lastBB.upper && rsiTurningDown && twoRedBars) {
    return {
      signal: "SELL",
      reason: `MeanRev SELL rsi:${lastRSI.toFixed(0)} above BB`,
      confidence: 0.78,
    };
  }

  return {
    signal: "HOLD",
    reason: `No reversion (rsi:${lastRSI.toFixed(0)})`,
    confidence: 0,
  };
};
