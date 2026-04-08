import crypto from "crypto";
import axios from "axios";
import Position from "../../models/Position.model.js";

const FUTURES_URLS = ["https://fapi.binance.com"];
const TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const LEVERAGE = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const binanceRequest = async (method, endpoint, params = {}, headers = {}) => {
  let lastError;
  for (const baseUrl of FUTURES_URLS) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const url = `${baseUrl}${endpoint}`;
        const config = { method, url, timeout: TIMEOUT_MS, headers };
        if (method === "GET") config.params = params;
        else config.url = `${url}?${params}`;

        const res = await axios(config);
        return res.data;
      } catch (err) {
        lastError = err;
        console.warn(
          `⚠️  [${baseUrl}] попытка ${attempt}/${MAX_RETRIES}: ${err.message}`,
        );
        if (err.response?.status === 400 || err.response?.status === 401)
          throw err;
        if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
};

const sign = (q) =>
  crypto
    .createHmac("sha256", process.env.BINANCE_FUTURES_SECRET_KEY)
    .update(q)
    .digest("hex");

const privatePost = async (endpoint, params = {}) => {
  const timestamp = Date.now();
  const query = new URLSearchParams({ ...params, timestamp }).toString();
  const signature = sign(query);
  return binanceRequest("POST", endpoint, `${query}&signature=${signature}`, {
    "X-MBX-APIKEY": process.env.BINANCE_FUTURES_API_KEY,
  });
};

const privateGet = async (endpoint, params = {}) => {
  const timestamp = Date.now();
  const query = new URLSearchParams({ ...params, timestamp }).toString();
  const signature = sign(query);
  return binanceRequest(
    "GET",
    endpoint,
    Object.fromEntries(new URLSearchParams(`${query}&signature=${signature}`)),
    { "X-MBX-APIKEY": process.env.BINANCE_FUTURES_API_KEY },
  );
};

// ─── Текущая цена ─────────────────────────────────────────────────────────
export const getCurrentPrice = async (symbol) => {
  const data = await binanceRequest("GET", "/fapi/v1/ticker/price", { symbol });
  return parseFloat(data.price);
};

// ─── Балансы ──────────────────────────────────────────────────────────────
export const getUSDTBalance = async () => {
  const account = await privateGet("/fapi/v2/account");
  const usdt = account.assets.find((a) => a.asset === "USDT");
  return parseFloat(usdt?.availableBalance ?? "0");
};

export const getFuturesBalance = async () => getUSDTBalance();

// ─── LOT SIZE ─────────────────────────────────────────────────────────────
const getSymbolInfo = async (symbol) => {
  const data = await binanceRequest("GET", "/fapi/v1/exchangeInfo");
  return data.symbols.find((s) => s.symbol === symbol);
};

const roundToStepSize = (quantity, stepSize) => {
  const precision = Math.round(-Math.log10(parseFloat(stepSize)));
  return parseFloat(quantity.toFixed(precision));
};

// ─── Открыть позицию ──────────────────────────────────────────────────────
// ДОБАВЛЕНО: принимаем strategy, mlSignal, mlConfidence — сохраняем в DB
export const openPosition = async ({
  symbol,
  side,
  usdtAmount,
  stopLoss,
  takeProfit,
  strategy = "Unknown",
  mlSignal = "HOLD",
  mlConfidence = 0,
}) => {
  try {
    const existing = await Position.findOne({ symbol, status: "OPEN" });
    if (existing) {
      console.log(`⚠️ Позиция уже открыта для ${symbol}`);
      return null;
    }

    const price = await getCurrentPrice(symbol);
    const symbolInfo = await getSymbolInfo(symbol);
    const lotFilter = symbolInfo.filters.find(
      (f) => f.filterType === "LOT_SIZE",
    );
    const stepSize = lotFilter?.stepSize ?? "0.001";

    const rawQty = (usdtAmount * LEVERAGE) / price;
    const quantity = roundToStepSize(rawQty, stepSize);
    const notional = quantity * price;

    if (notional < 5) {
      console.error(`❌ Notional too small: ${notional.toFixed(2)} < 5`);
      return null;
    }

    const direction = side === "BUY" ? "LONG" : "SHORT";
    console.log(`\n🚀 ${direction} ${symbol} (FUTURES x${LEVERAGE})`);
    console.log(`   Цена: ${price} | Qty: ${quantity} | USDT: ${usdtAmount}`);
    console.log(
      `   SL: ${stopLoss?.toFixed(2)} | TP: ${takeProfit?.toFixed(2)}`,
    );
    console.log(
      `   Стратегия: ${strategy} | ML: ${mlSignal} (${(mlConfidence * 100).toFixed(0)}%)`,
    );

    await privatePost("/fapi/v1/leverage", { symbol, leverage: LEVERAGE });

    const order = await privatePost("/fapi/v1/order", {
      symbol,
      side,
      type: "MARKET",
      quantity,
    });

    const filledPrice = parseFloat(order.avgPrice) || price;
    const filledQty = parseFloat(order.executedQty) || quantity;

    console.log(`✅ Ордер исполнен: ${filledPrice} x ${filledQty}`);

    const position = await Position.create({
      symbol,
      side,
      entryPrice: filledPrice,
      quantity: filledQty,
      usdtAmount,
      stopLoss,
      takeProfit,
      orderId: order.orderId,
      status: "OPEN",
      openedAt: new Date(),
      // НОВЫЕ ПОЛЯ для фидбека в ML:
      strategy,
      mlSignal,
      mlConfidence,
    });

    console.log(`💾 Позиция сохранена: ${position._id}`);
    return position;
  } catch (err) {
    console.error(
      "❌ Ошибка открытия позиции:",
      err.response?.data || err.message,
    );
    return null;
  }
};

// ─── Закрыть позицию ──────────────────────────────────────────────────────
export const closePosition = async (positionId, reason = "MANUAL") => {
  try {
    const position = await Position.findById(positionId);
    if (!position || position.status !== "OPEN") return null;

    const price = await getCurrentPrice(position.symbol);
    const closeSide = position.side === "BUY" ? "SELL" : "BUY";

    console.log(
      `\n🔒 Закрываем ${position.side} ${position.symbol} (${reason})`,
    );
    console.log(`   Вход: ${position.entryPrice} | Текущая: ${price}`);

    const order = await privatePost("/fapi/v1/order", {
      symbol: position.symbol,
      side: closeSide,
      type: "MARKET",
      quantity: position.quantity,
    });

    const exitPrice = parseFloat(order.avgPrice) || price;
    const pnlPercent =
      position.side === "BUY"
        ? (exitPrice - position.entryPrice) / position.entryPrice
        : (position.entryPrice - exitPrice) / position.entryPrice;

    const pnlUSDT = position.usdtAmount * pnlPercent * LEVERAGE;
    const feeUSDT = position.usdtAmount * 0.0004 * 2;
    const netPnL = pnlUSDT - feeUSDT;

    position.status = "CLOSED";
    position.exitPrice = exitPrice;
    position.pnlPercent = pnlPercent * 100;
    position.pnlUSDT = netPnL;
    position.closeReason = reason;
    position.closedAt = new Date();
    await position.save();

    const emoji = netPnL > 0 ? "✅" : "❌";
    console.log(
      `${emoji} Позиция закрыта | PnL: ${netPnL.toFixed(4)} USDT | Причина: ${reason}`,
    );

    return position;
  } catch (err) {
    console.error("❌ Ошибка закрытия:", err.response?.data || err.message);
    return null;
  }
};

// ─── Монитор SL/TP ────────────────────────────────────────────────────────
// ИСПРАВЛЕНО: принимает свечи для отправки фидбека в ML после закрытия
export const monitorPositions = async (
  candles1h = [],
  candles4h = [],
  candles1d = [],
) => {
  try {
    const { sendFeedbackToML } = await import("../../app.js");
    const openPositions = await Position.find({ status: "OPEN" });

    for (const pos of openPositions) {
      const price = await getCurrentPrice(pos.symbol);
      let closed = null;

      if (pos.stopLoss) {
        const slHit =
          pos.side === "BUY" ? price <= pos.stopLoss : price >= pos.stopLoss;
        if (slHit) {
          console.log(`🛑 SL сработал ${pos.symbol} @ ${price}`);
          closed = await closePosition(pos._id, "SL");
        }
      }

      if (!closed && pos.takeProfit) {
        const tpHit =
          pos.side === "BUY"
            ? price >= pos.takeProfit
            : price <= pos.takeProfit;
        if (tpHit) {
          console.log(`🎯 TP сработал ${pos.symbol} @ ${price}`);
          closed = await closePosition(pos._id, "TP");
        }
      }

      if (!closed) {
        const hoursOpen = (Date.now() - pos.openedAt.getTime()) / 3600000;
        if (hoursOpen > 48) {
          console.log(`⏱️ Таймаут ${pos.symbol}`);
          closed = await closePosition(pos._id, "TIMEOUT");
        }
      }

      // НОВОЕ: отправляем фидбек в ML после закрытия
      if (closed && candles1h.length >= 250) {
        await sendFeedbackToML(closed, candles1h, candles4h, candles1d);
      }
    }
  } catch (err) {
    console.error("❌ Ошибка монитора:", err.message);
  }
};
