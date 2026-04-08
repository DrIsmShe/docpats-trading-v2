import * as tf from "@tensorflow/tfjs-node";
import {
  calculateRSI,
  calculateEMA,
  calculateATR,
} from "../indicators/indicators.service.js";
import fs from "fs";
import path from "path";

const MODEL_PATH = "./model/btc_model";

export const extractFeatures = (candles) => {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const rsi = calculateRSI(closes);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const atr = calculateATR(candles);

  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);

  if (!last || !prev || !prev2) return null;

  const price = last.close;
  const lastRSI = rsi.at(-1) ?? 50;
  const lastEMA20 = ema20.at(-1) ?? price;
  const lastEMA50 = ema50.at(-1) ?? price;
  const lastEMA200 = ema200.at(-1) ?? price;
  const lastATR = atr.at(-1) ?? 1;

  const avgVol = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
  const volRatio = avgVol > 0 ? last.volume / avgVol : 1;

  return [
    lastRSI / 100,
    (price - lastEMA20) / lastEMA20,
    (price - lastEMA50) / lastEMA50,
    (price - lastEMA200) / lastEMA200,
    (lastEMA20 - lastEMA50) / lastEMA50,
    lastATR / price,
    (last.close - prev.close) / prev.close,
    (last.close - prev2.close) / prev2.close,
    Math.min(volRatio, 5) / 5,
    last.close > last.open ? 1 : 0,
    new Date(last.openTime).getUTCHours() / 24,
  ];
};

const createModel = () => {
  const model = tf.sequential();

  model.add(
    tf.layers.dense({
      inputShape: [11],
      units: 64,
      activation: "relu",
      kernelRegularizer: tf.regularizers.l2({ l2: 0.001 }),
    }),
  );
  model.add(tf.layers.dropout({ rate: 0.2 }));
  model.add(tf.layers.dense({ units: 32, activation: "relu" }));
  model.add(tf.layers.dropout({ rate: 0.1 }));
  model.add(tf.layers.dense({ units: 1, activation: "sigmoid" }));

  model.compile({
    optimizer: tf.train.adam(0.001),
    loss: "binaryCrossentropy",
    metrics: ["accuracy"],
  });

  return model;
};

const prepareTrainingData = (candles, lookahead = 3, threshold = 0.005) => {
  const X = [];
  const Y = [];

  for (let i = 200; i < candles.length - lookahead; i++) {
    const slice = candles.slice(0, i + 1);
    const features = extractFeatures(slice);
    if (!features) continue;

    const currentPrice = candles[i].close;
    const futurePrice = candles[i + lookahead].close;
    const change = (futurePrice - currentPrice) / currentPrice;

    X.push(features);
    Y.push(change > threshold ? 1 : 0);
  }

  return { X, Y };
};

export const trainModel = async (candles) => {
  console.log("🧠 ML: Начало обучения...");

  const { X, Y } = prepareTrainingData(candles);

  if (X.length < 100) {
    console.log("❌ ML: Недостаточно данных");
    return null;
  }

  const positives = Y.filter((y) => y === 1).length;
  const negatives = Y.filter((y) => y === 0).length;
  console.log(
    `📊 ML: рост: ${positives}, падение: ${negatives}, всего: ${X.length}`,
  );

  const xTensor = tf.tensor2d(X);
  const yTensor = tf.tensor2d(Y, [Y.length, 1]);
  const model = createModel();

  await model.fit(xTensor, yTensor, {
    epochs: 30,
    batchSize: 32,
    validationSplit: 0.2,
    shuffle: true,
    verbose: 0,
    callbacks: {
      onEpochEnd: (epoch, logs) => {
        if (epoch % 10 === 0) {
          console.log(
            `  Epoch ${epoch}: loss=${logs.loss.toFixed(4)} acc=${logs.acc?.toFixed(3) ?? "?"}`,
          );
        }
      },
    },
  });

  const modelDir = path.dirname(MODEL_PATH);
  if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });
  await model.save(`file://${MODEL_PATH}`);
  console.log("✅ ML: Модель сохранена");

  xTensor.dispose();
  yTensor.dispose();

  return model;
};

let cachedModel = null;
let lastTrainTime = null;
let isTraining = false;

export const loadOrTrainModel = async (candles) => {
  const now = Date.now();
  const RETRAIN_INTERVAL = 24 * 60 * 60 * 1000;

  // Если модель есть и свежая — возвращаем сразу
  if (cachedModel && lastTrainTime && now - lastTrainTime < RETRAIN_INTERVAL) {
    return cachedModel;
  }

  // Если уже обучается — возвращаем старую модель или null
  if (isTraining) {
    console.log("⏳ ML: обучение уже идёт — используем старую модель");
    return cachedModel;
  }

  // Пробуем загрузить с диска
  if (!cachedModel && fs.existsSync(`${MODEL_PATH}/model.json`)) {
    try {
      cachedModel = await tf.loadLayersModel(`file://${MODEL_PATH}/model.json`);
      lastTrainTime = now;
      console.log("✅ ML: Модель загружена с диска");

      // Запускаем переобучение в фоне
      isTraining = true;
      trainModel(candles)
        .then((m) => {
          if (m) {
            cachedModel = m;
            lastTrainTime = Date.now();
          }
          isTraining = false;
        })
        .catch(() => {
          isTraining = false;
        });

      return cachedModel;
    } catch (e) {
      console.log("⚠️ ML: файл модели не найден — обучаем...");
    }
  }

  // Первое обучение — делаем синхронно но только один раз
  if (!isTraining) {
    isTraining = true;
    cachedModel = await trainModel(candles);
    lastTrainTime = now;
    isTraining = false;
  }

  return cachedModel;
};

export const predictSignal = async (candles, model) => {
  if (!model) return { confidence: 0.5, skip: false };

  const features = extractFeatures(candles);
  if (!features) return { confidence: 0.5, skip: false };

  const input = tf.tensor2d([features]);
  const prediction = model.predict(input);
  const confidence = (await prediction.data())[0];

  input.dispose();
  prediction.dispose();

  console.log(`🤖 ML: вероятность роста = ${(confidence * 100).toFixed(1)}%`);

  return {
    confidence,
    skip: confidence < 0.45,
  };
};
