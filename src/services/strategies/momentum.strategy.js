import {
  calculateRSI,
  calculateEMA,
  calculateATR,
} from "../indicators/indicators.service.js";

const calculateMACD = (closes) => {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const minLen = Math.min(ema12.length, ema26.length);
  const macdLine = [];
  for (let i = 0; i < minLen; i++) {
    macdLine.push(
      ema12[ema12.length - minLen + i] - ema26[ema26.length - minLen + i],
    );
  }
  const signal = calculateEMA(macdLine, 9);
  const histogram = macdLine.slice(-signal.length).map((v, i) => v - signal[i]);
  return { macdLine, signal, histogram };
};

export const momentumStrategy = (candles) => {
  if (candles.length < 100)
    return { signal: "HOLD", reason: "Not enough data" };

  const closes = candles.map((c) => c.close);
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);

  if (!last || !prev) return { signal: "HOLD", reason: "No candles" };

  const rsi = calculateRSI(closes);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const atr = calculateATR(candles);
  const macd = calculateMACD(closes);

  const lastRSI = rsi.at(-1);
  const lastEMA20 = ema20.at(-1);
  const lastEMA50 = ema50.at(-1);
  const lastEMA200 = ema200.at(-1);
  const lastATR = atr.at(-1);
  const lastMACD = macd.histogram.at(-1);
  const prevMACD = macd.histogram.at(-2);

  if (!lastRSI || !lastEMA20 || !lastEMA50 || !lastATR || !lastMACD)
    return { signal: "HOLD", reason: "Indicators not ready" };

  const price = last.close;
  const atrPercent = (lastATR / price) * 100;
  if (atrPercent < 0.15) return { signal: "HOLD", reason: "Low volatility" };

  const uptrend = price > lastEMA20 && lastEMA20 > lastEMA50;
  const downtrend = price < lastEMA20 && lastEMA20 < lastEMA50;
  const longUp = lastEMA200 ? lastEMA50 > lastEMA200 : true;
  const longDown = lastEMA200 ? lastEMA50 < lastEMA200 : true;

  // Два бара подряд в направлении сигнала — подтверждение импульса
  const twoGreenBars = prev2
    ? last.close > last.open && prev.close > prev.open
    : last.close > last.open;

  const twoRedBars = prev2
    ? last.close < last.open && prev.close < prev.open
    : last.close < last.open;

  // ── BUY: тренд + MACD растёт + RSI в золотой зоне + 2 зелёных бара ──
  if (
    uptrend &&
    longUp &&
    lastRSI > 50 &&
    lastRSI < 65 &&
    lastMACD > 0 &&
    lastMACD > prevMACD &&
    twoGreenBars
  ) {
    return {
      signal: "BUY",
      reason: `Momentum BUY rsi:${lastRSI.toFixed(0)} macd:${lastMACD.toFixed(2)}`,
      confidence: 0.75,
    };
  }

  // ── SELL: даунтренд + MACD падает + RSI в зоне + 2 красных бара ──
  if (
    downtrend &&
    longDown &&
    lastRSI < 50 &&
    lastRSI > 35 &&
    lastMACD < 0 &&
    lastMACD < prevMACD &&
    twoRedBars
  ) {
    return {
      signal: "SELL",
      reason: `Momentum SELL rsi:${lastRSI.toFixed(0)} macd:${lastMACD.toFixed(2)}`,
      confidence: 0.75,
    };
  }

  return {
    signal: "HOLD",
    reason: `No momentum (rsi:${lastRSI.toFixed(0)})`,
    confidence: 0,
  };
};
