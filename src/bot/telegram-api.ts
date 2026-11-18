import axios from 'axios';

/**
 * Bot API client for the two-way Daily Bytes bot. It uses TELEGRAM_BOT_TOKEN,
 * not TELEGRAM_ACCESS_TOKEN: that token is the channel broadcaster, and its
 * webhook belongs to another app, which a second webhook would replace.
 */
export const botToken = () => process.env.TELEGRAM_BOT_TOKEN || '';
export const botEnabled = () => botToken().length > 0;

export type SendResult = 'sent' | 'blocked' | 'failed';

export async function callBot<T = any>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  const token = botToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const { data } = await axios.post(`https://api.telegram.org/bot${token}/${method}`, payload, {
    timeout: 15_000,
    validateStatus: () => true,
  });
  if (!data?.ok) {
    const err = new Error(`Telegram ${method} failed: ${data?.description ?? 'no response'}`) as Error & { code?: number };
    err.code = data?.error_code;
    throw err;
  }
  return data.result as T;
}

/** Send an HTML message. 403 means the user blocked the bot or deleted the chat. */
export async function sendHtml(chatId: string, html: string): Promise<SendResult> {
  try {
    await callBot('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    return 'sent';
  } catch (err: any) {
    if (err.code === 403) return 'blocked';
    if (err.code === 429) {
      await new Promise((r) => setTimeout(r, 2_000));
      try {
        await callBot('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        return 'sent';
      } catch {
        return 'failed';
      }
    }
    return 'failed';
  }
}
