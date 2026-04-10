import "dotenv/config";
import mongoose from "mongoose";
import { fetchAndStoreCandles } from "./src/services/market/market.service.js";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Mongo connected");
  console.log("📥 Fetching 15m candles (8000 = ~83 days)...\n");

  await fetchAndStoreCandles("BTCUSDT", "15m", 8000);

  console.log("\n✅ Done!");
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
