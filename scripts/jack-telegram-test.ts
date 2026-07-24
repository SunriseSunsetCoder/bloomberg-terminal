/**
 * Live Telegram test — sends ONE message to the trade channel to confirm wiring.
 *   npx tsx scripts/jack-telegram-test.ts
 * Requires TELEGRAM_BOT_TOKEN + TELEGRAM_TRADE_CHAT_ID in the environment. Exits
 * non-zero if disabled or the send fails, so it can gate a deploy.
 */
import { sendTelegram, alertsEnabled } from "../lib/jack/telegram";

async function main() {
  if (!alertsEnabled()) {
    console.error("DISABLED: set TELEGRAM_BOT_TOKEN and TELEGRAM_TRADE_CHAT_ID first.");
    process.exit(1);
  }
  const etTime = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
  const host = process.env.COMPUTERNAME || process.env.HOSTNAME || "unknown-host";

  console.log("Sending test message to the trade channel …");
  const res = await sendTelegram(`✅ JACK Telegram wired — test from ${host} at ${etTime} ET`);
  console.log(res);
  if (!res.ok) {
    console.error("FAIL: message did not send.");
    process.exit(1);
  }
  console.log("OK: message delivered — check the channel.");
  process.exit(0);
}

main();
