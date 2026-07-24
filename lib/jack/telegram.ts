// =============================================================================
// JACK Telegram alert sender. Reuses the existing bot (TELEGRAM_BOT_TOKEN) and posts
// to a dedicated trade channel (TELEGRAM_TRADE_CHAT_ID) via a plain HTTPS POST — NO
// npm dependency. Graceful disable: if either env is unset, warn ONCE and no-op so
// the rest of the pipeline (board refresh, outcomes) is unaffected. NEVER throws.
// =============================================================================

let warnedDisabled = false;

/** True only when BOTH env vars are present — callers skip alert work when false. */
export function alertsEnabled(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_TRADE_CHAT_ID;
}

export interface SendResult {
  ok: boolean;
  disabled?: boolean; // envs unset — not an error, just off
  error?: string;
}

/**
 * Send one message to the trade channel. HTML parse mode (our templates use only
 * plain text + a couple of symbols, no markup). Returns {ok:false} on any failure —
 * the caller decides whether to retry (it does NOT set the dedup marker on failure).
 */
export async function sendTelegram(text: string): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_TRADE_CHAT_ID;
  if (!token || !chatId) {
    if (!warnedDisabled) {
      console.warn(
        "JACK alerts disabled — TELEGRAM_BOT_TOKEN and/or TELEGRAM_TRADE_CHAT_ID unset (board still refreshes)."
      );
      warnedDisabled = true;
    }
    return { ok: false, disabled: true };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 150)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
