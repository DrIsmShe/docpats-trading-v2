import {
  calculateEMA,
  calculateRSI,
  calculateATR,
} from "../indicators/indicators.service.js";

/**
 * Pullback Strategy — Multi-Timeframe + Impulse Filter
 *
 * Логика:
 *   1. Тренд на 1h (EMA50 vs EMA200)
 *   2. Проверка импульса: было ли недавнее сильное движение (ROC)
 *   3. Проверка что импульс НЕ выдохся (acceleration)
 *   4. Вход на 15m при откате к EMA20 + подтверждение разворотной свечой
 *
 * Принимает ДВА массива свечей: candles15m и candles1h
 */

// ── Вспомогательные функции ─────────────────────────────────────────────
const calcROC = (closes, period) => {
  if (closes.length < period + 1) return 0;
  const current = closes.at(-1);
  const past = closes.at(-(period + 1));
  return past > 0 ? (current - past) / past : 0;
};

const calcAcceleration = (closes, period) => {
  if (closes.length < period + 2) return 0;
  const rocNow =
    (closes.at(-1) - closes.at(-(period + 1))) /
    (closes.at(-(period + 1)) || 1);
  const rocPrev =
    (closes.at(-2) - closes.at(-(period + 2))) /
    (closes.at(-(period + 2)) || 1);
  return rocNow - rocPrev;
};

// ── Главная функция ─────────────────────────────────────────────────────
export const pullbackStrategy = (candles15m, candles1h) => {
  // ── Минимальные требования ────────────────────────────────────────────
  if (!candles15m || candles15m.length < 100)
    return { signal: "HOLD", reason: "Not enough 15m candles" };
  if (!candles1h || candles1h.length < 250)
    return { signal: "HOLD", reason: "Not enough 1h candles" };

  // ═════════════════════════════════════════════════════════════════════════
  // ЭТАП 1: Тренд на 1h
  // ═════════════════════════════════════════════════════════════════════════
  const closes1h = candles1h.map((c) => c.close);
  const ema50_1h = calculateEMA(closes1h, 50);
  const ema200_1h = calculateEMA(closes1h, 200);

  const lastEMA50_1h = ema50_1h.at(-1);
  const lastEMA200_1h = ema200_1h.at(-1);
  const lastClose1h = closes1h.at(-1);

  if (!lastEMA50_1h || !lastEMA200_1h)
    return { signal: "HOLD", reason: "1h EMA not ready" };

  const isUptrend1h =
    lastEMA50_1h > lastEMA200_1h && lastClose1h > lastEMA50_1h;
  const isDowntrend1h =
    lastEMA50_1h < lastEMA200_1h && lastClose1h < lastEMA50_1h;

  if (!isUptrend1h && !isDowntrend1h) {
    return { signal: "HOLD", reason: "1h: нет чёткого тренда" };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // ЭТАП 2: Фильтр импульса на 15m
  // ═════════════════════════════════════════════════════════════════════════
  const closes15m = candles15m.map((c) => c.close);

  // ROC за 24 свечи (6 часов на 15m) — было ли недавнее движение?
  const roc24 = calcROC(closes15m, 24);
  const absRoc24 = Math.abs(roc24);

  // Должно быть движение, но не слишком большое (иначе уже отработано)
  // Минимум 0.3% движение за 6 часов — иначе нет импульса, нечего ловить
  if (absRoc24 < 0.003) {
    return {
      signal: "HOLD",
      reason: `Нет импульса (ROC24: ${(roc24 * 100).toFixed(2)}%)`,
    };
  }

  // Максимум 3% движение за 6 часов — иначе импульс уже отработан
  if (absRoc24 > 0.03) {
    return {
      signal: "HOLD",
      reason: `Импульс отработан (ROC24: ${(roc24 * 100).toFixed(2)}%)`,
    };
  }

  // Направление ROC должно совпадать с трендом на 1h
  if (isUptrend1h && roc24 < 0) {
    return {
      signal: "HOLD",
      reason: "1h UP, но 15m ROC отрицательный — откат слишком глубокий",
    };
  }
  if (isDowntrend1h && roc24 > 0) {
    return {
      signal: "HOLD",
      reason: "1h DOWN, но 15m ROC положительный — откат слишком глубокий",
    };
  }

  // Ускорение — импульс должен замедляться (= начинается откат, скоро разворот)
  // Если ускорение сильно положительное — импульс ещё бежит, рано входить
  const acceleration = calcAcceleration(closes15m, 12);

  if (isUptrend1h && acceleration > 0.002) {
    return {
      signal: "HOLD",
      reason: `Импульс ещё ускоряется (acc: ${(acceleration * 100).toFixed(3)}%) — ждём откат`,
    };
  }
  if (isDowntrend1h && acceleration < -0.002) {
    return {
      signal: "HOLD",
      reason: `Импульс ещё ускоряется (acc: ${(acceleration * 100).toFixed(3)}%) — ждём откат`,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // ЭТАП 3: Индикаторы 15m
  // ═════════════════════════════════════════════════════════════════════════
  const ema20_15m = calculateEMA(closes15m, 20);
  const rsi15m = calculateRSI(closes15m);
  const atr15m = calculateATR(candles15m);

  const lastEMA20 = ema20_15m.at(-1);
  const prevEMA20 = ema20_15m.at(-2);
  const lastRSI = rsi15m.at(-1);
  const lastATR = atr15m.at(-1);

  if (!lastEMA20 || !prevEMA20 || !lastRSI || !lastATR)
    return { signal: "HOLD", reason: "15m indicators not ready" };

  const last = candles15m.at(-1);
  const prev = candles15m.at(-2);
  if (!last || !prev) return { signal: "HOLD", reason: "No 15m candles" };

  const price = last.close;
  const atrPercent = (lastATR / price) * 100;

  if (atrPercent < 0.1)
    return {
      signal: "HOLD",
      reason: `Low 15m volatility (${atrPercent.toFixed(2)}%)`,
    };

  // ═════════════════════════════════════════════════════════════════════════
  // ЭТАП 4: Объём и свечные характеристики
  // ═════════════════════════════════════════════════════════════════════════
  const volumes15m = candles15m.slice(-10).map((c) => c.volume);
  const avgVol =
    volumes15m.slice(0, -1).reduce((a, b) => a + b, 0) /
    (volumes15m.length - 1);
  const volRatio = avgVol > 0 ? last.volume / avgVol : 0;

  const range = last.high - last.low || 1;
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;
  const isBullish = last.close > last.open;
  const isBearish = last.close < last.open;

  // ═════════════════════════════════════════════════════════════════════════
  // ЭТАП 5: Сигналы
  // ═════════════════════════════════════════════════════════════════════════

  // 🟢 ЛОНГ
  if (isUptrend1h) {
    const wasPullback = prev.low <= prevEMA20;
    const isReversal = isBullish && last.close > lastEMA20 && bodyRatio > 0.4;
    const rsiOk = lastRSI > 40 && lastRSI < 70;
    const volOk = volRatio > 1.0;

    if (wasPullback && isReversal && rsiOk && volOk) {
      return {
        signal: "BUY",
        reason: `1h UP + 15m pullback | rsi:${lastRSI.toFixed(0)} vol:${volRatio.toFixed(1)}x roc:${(roc24 * 100).toFixed(1)}% acc:${(acceleration * 100).toFixed(2)}%`,
        confidence: 0.7,
      };
    }
  }

  // 🔴 ШОРТ
  if (isDowntrend1h) {
    const wasPullback = prev.high >= prevEMA20;
    const isReversal = isBearish && last.close < lastEMA20 && bodyRatio > 0.4;
    const rsiOk = lastRSI < 60 && lastRSI > 30;
    const volOk = volRatio > 1.0;

    if (wasPullback && isReversal && rsiOk && volOk) {
      return {
        signal: "SELL",
        reason: `1h DOWN + 15m pullback | rsi:${lastRSI.toFixed(0)} vol:${volRatio.toFixed(1)}x roc:${(roc24 * 100).toFixed(1)}% acc:${(acceleration * 100).toFixed(2)}%`,
        confidence: 0.7,
      };
    }
  }

  const trendName = isUptrend1h ? "UP" : "DOWN";
  return {
    signal: "HOLD",
    reason: `1h ${trendName}, но нет сетапа на 15m`,
  };
};
