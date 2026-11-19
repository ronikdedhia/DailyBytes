import { createHmac } from 'crypto';
import axios from 'axios';
import { parseCommand } from './bot.service';

/**
 * One Telegram bot serves two apps. Daily Bytes owns the webhook and handles
 * its commands; the owner's EarningsLens commands are forwarded to the
 * EarningsLens webhook unchanged. EarningsLens commands whose names clash with
 * Daily Bytes ones are used with an "e" prefix (/ebrief, /eask) and renamed
 * back when forwarded.
 */
export const EARNINGSLENS_COMMANDS = [
  { command: 'ebrief', description: 'EarningsLens: results-day brief for a company' },
  { command: 'results', description: 'EarningsLens: latest quarter with QoQ/YoY' },
  { command: 'val', description: 'EarningsLens: valuation vs 2-year range' },
  { command: 'holdings', description: 'EarningsLens: shareholding changes' },
  { command: 'orders', description: 'EarningsLens: order wins' },
  { command: 'fda', description: 'EarningsLens: US FDA events' },
  { command: 'signals', description: 'EarningsLens: insider trades and deals' },
  { command: 'eask', description: 'EarningsLens: ask the transcripts' },
  { command: 'watchlist', description: 'EarningsLens: tracked companies' },
  { command: 'ehelp', description: 'EarningsLens: all commands' },
];
const RENAMED: Record<string, string> = { ebrief: 'brief', eask: 'ask', ehelp: 'help' };
const FORWARDED = new Set(EARNINGSLENS_COMMANDS.map((c) => c.command));

export type Route = { to: 'dailybytes' } | { to: 'forward'; text: string } | { to: 'owner-only' };

/** Owner chats: the only ones whose EarningsLens commands are forwarded. */
export function ownerChats(): Set<string> {
  return new Set([process.env.TELEGRAM_ADMIN_CHAT_ID, process.env.TELEGRAM_CHAT_ID, ...(process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '').split(',')]
    .map((s) => (s ?? '').trim()).filter(Boolean));
}

let detectedForwardUrl: string | null = null;
/** Set when Daily Bytes takes over a webhook that pointed at the other app (persisted in job_state). */
export function setDetectedForwardUrl(url: string | null): void {
  detectedForwardUrl = url;
}
export const FORWARD_URL_KEY = 'telegram:forward_url';

export function forwardUrl(): string | null {
  return process.env.TELEGRAM_FORWARD_URL?.trim() || detectedForwardUrl;
}

/** Where a message goes. Only commands, from owner chats, with a forward URL set, leave Daily Bytes. */
export function routeMessage(chatId: string, text: string): Route {
  const cmd = parseCommand(text);
  if (!cmd || !FORWARDED.has(cmd.command)) return { to: 'dailybytes' };
  if (!forwardUrl() || !ownerChats().has(chatId)) return { to: 'owner-only' };
  const name = RENAMED[cmd.command] ?? cmd.command;
  return { to: 'forward', text: `/${name}${cmd.arg ? ` ${cmd.arg}` : ''}` };
}

/** EarningsLens checks this header; it derives it from the shared bot token unless TELEGRAM_WEBHOOK_SECRET is set there. */
export function forwardSecret(): string {
  return process.env.TELEGRAM_FORWARD_SECRET
    || createHmac('sha256', process.env.TELEGRAM_ACCESS_TOKEN ?? '').update('earningslens-webhook').digest('hex').slice(0, 48);
}

/** POST the (rewritten) update to EarningsLens. Allows for a Render cold start. */
export async function forwardUpdate(update: any, text: string): Promise<void> {
  const url = forwardUrl();
  if (!url) throw new Error('TELEGRAM_FORWARD_URL is not set');
  const body = { ...update, message: { ...update.message, text } };
  const res = await axios.post(url, body, {
    headers: { 'x-telegram-bot-api-secret-token': forwardSecret(), 'Content-Type': 'application/json' },
    timeout: 90_000,
    validateStatus: () => true,
  });
  if (res.status >= 300) throw new Error(`EarningsLens answered HTTP ${res.status}`);
}
