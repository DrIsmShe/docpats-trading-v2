import axios from "axios";
import Candle from "../../models/Candle.js";

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://localhost:3001";
const SYMBOL = "BTCUSDT";

// ─── Загрузка данных нужных для ML ────────────────────────────────────────
const loadMLData = async (candles1h) => {
  try {
    // 4h свечи из MongoDB
    const candles4h = await Candle.find({ symbol: SYMBOL, interval: "4h" })
      .sort({ openTime: 1 })
      .limit(300)
      .lean();

    // 1d свечи из MongoDB
    const candles1d = await Candle.find({ symbol: SYMBOL, interval: "1d" })
      .sort({ openTime: 1 })
      .limit(200)
      .lean();

    return { candles4h, candles1d };
  } catch (err) {
    console.log(`⚠️  Ошибка загрузки доп. данных: ${err.message}`);
    return { candles4h: [], candles1d: [] };
  }
};

// ─── Проверка доступности ML сервиса ──────────────────────────────────────
export const checkMLService = async () => {
  try {
    const response = await axios.get(`${ML_SERVICE_URL}/health`, {
      timeout: 3000,
    });
    return response.data.ok === true && response.data.model === true;
  } catch {
    return false;
  }
};

// ─── Запрос предсказания ───────────────────────────────────────────────────
// Отправляет ВСЕ нужные данные: 1h + 4h + 1d
// ML сервис строит последовательность [SEQ_LEN × 45] для LSTM
export const getMLClientPrediction = async (candles1h) => {
  try {
    const mlReady = await checkMLService();

    if (!mlReady) {
      console.log("⚠️  ML Client недоступен");
      return { confidence: 0.5, skip: false, available: false, signal: "HOLD" };
    }

    // Загружаем 4h и 1d данные
    const { candles4h, candles1d } = await loadMLData(candles1h);

    const payload = {
      candles1h: candles1h.slice(-300), // последние 300 часовых
      candles4h: candles4h.slice(-150), // последние 150 четырёхчасовых
      candles1d: candles1d.slice(-100), // последние 100 дневных
      // funding, OI, L/S — ML сервис использует свои сохранённые данные
      // если хочешь передавать — добавь здесь
    };

    const response = await axios.post(`${ML_SERVICE_URL}/predict`, payload, {
      timeout: 15000,
    });

    const { signal, confidence, buy, hold, sell } = response.data;

    console.log(
      `🧠 ML-2 (LSTM): BUY=${(buy * 100).toFixed(1)}% ` +
        `HOLD=${(hold * 100).toFixed(1)}% ` +
        `SELL=${(sell * 100).toFixed(1)}% ` +
        `→ ${signal} (conf: ${(confidence * 100).toFixed(1)}%)`,
    );

    // Проверяем согласованность сигнала стратегии и ML
    // skip=true если модель не уверена (confidence < порог)
    return {
      signal,
      confidence,
      buy,
      hold,
      sell,
      skip: confidence < 0.5, // порог снижен до 50% для LSTM
      available: true,
    };
  } catch (err) {
    console.log(`⚠️  ML Client ошибка: ${err.message}`);
    return { confidence: 0.5, skip: false, available: false, signal: "HOLD" };
  }
};

// ─── Получить статус ML сервиса ────────────────────────────────────────────
export const getMLServiceStatus = async () => {
  try {
    const response = await axios.get(`${ML_SERVICE_URL}/status`, {
      timeout: 3000,
    });
    return response.data;
  } catch {
    return null;
  }
};
