import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '../utils/logger';
import { BotStore, SubscriptionKind } from './bot-store';
import { formatArticleList, escapeHtml, BriefArticle } from './format';
import { matchesAny, matchesTerm, normalizeTerm, MAX_TERMS_PER_KIND, MatchableArticle } from './matching';
import { botEnabled, botToken, callBot, sendHtml, SendResult } from './telegram-api';
import { questionKeywords } from './keywords';
import { EARNINGSLENS_COMMANDS, forwardUrl, ownerChats, setDetectedForwardUrl, FORWARD_URL_KEY } from './router';
import { jobStateService } from '../services/job-state.service';

export type BotArticle = BriefArticle & MatchableArticle & {
  publishedAt?: string | Date | null;
  upvoteCount?: number | null;
  bookmarkCount?: number | null;
};

export interface BotDeps {
  store: BotStore;
  /** Articles from the last 7 days, newest first. */
  recentArticles: (limit?: number) => Promise<BotArticle[]>;
  /** Keyword search over stored articles, best match first (for /ask). */
  searchArticles: (keywords: string[]) => Promise<BotArticle[]>;
  /** Answer a question from the given numbered articles, citing them as [n]. */
  answer: (question: string, articles: BotArticle[]) => Promise<string>;
  send: (chatId: string, html: string) => Promise<SendResult>;
  now?: () => Date;
}

const BRIEF_SIZE = 5;
const ALERT_BATCH = 5;
const SEND_GAP_MS = 50; // Telegram allows ~30 messages/second overall
const ASK_SOURCES = 5;
const ASK_LIMIT_PER_HOUR = 10;
const WEEKLY_POOL = 500;

export const COMMANDS = [
  { command: 'brief', description: 'Top stories now (or /brief cricket)' },
  { command: 'ask', description: 'Ask about recent news: /ask what did RBI decide?' },
  { command: 'topic', description: 'Follow a topic for your daily digest: /topic cricket' },
  { command: 'topics', description: 'List the topics you follow' },
  { command: 'untopic', description: 'Stop following a topic' },
  { command: 'alert', description: 'Instant message when a story mentions it: /alert RBI' },
  { command: 'alerts', description: 'List your alerts' },
  { command: 'unalert', description: 'Remove an alert' },
  { command: 'digest', description: 'Daily digest on or off: /digest off' },
  { command: 'stop', description: 'Delete your data and stop all messages' },
  { command: 'help', description: 'How this bot works' },
];

const HELP = [
  '<b>Daily Bytes bot</b>',
  'AI-summarised Indian news, picked for you.',
  '',
  '/brief: top stories now (<code>/brief cricket</code> for one topic)',
  '/topic cricket: follow a topic; your daily digest (around 2:15 PM IST) shows these first',
  '/ask what did RBI decide?: an answer from recent stories, with links',
  '/alert RBI: get a message as soon as a new story mentions it',
  '/topics, /alerts: what you follow; /untopic, /unalert to remove',
  '/digest on | off: the daily digest (and the Sunday weekly wrap)',
  '/stop: delete your data',
  '',
  `Topics can be a category (${['sports', 'technology', 'business', 'politics', 'entertainment'].join(', ')}) or any word or name.`,
].join('\n');

const LABEL: Record<SubscriptionKind, { one: string; many: string; add: string; remove: string }> = {
  topic: { one: 'topic', many: 'topics', add: '/topic', remove: '/untopic' },
  alert: { one: 'alert', many: 'alerts', add: '/alert', remove: '/unalert' },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "/topic@DailyBytesBot  Cricket " -> { command: "topic", arg: "Cricket" } */
export function parseCommand(text: string): { command: string; arg: string } | null {
  const m = text.trim().match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  return m ? { command: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
}

const publishedMs = (a: BotArticle) => (a.publishedAt ? new Date(a.publishedAt).getTime() : NaN);

export class BotService {
  private readonly now: () => Date;
  private readonly askLog = new Map<string, number[]>();

  constructor(private readonly deps: BotDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ------------------------------------------------------------ commands

  /** Reply (Telegram HTML) to a message from a private chat. */
  async handleMessage(chat: { chatId: string; username?: string; firstName?: string }, text: string): Promise<string> {
    const { store } = this.deps;
    const parsed = parseCommand(text);
    if (parsed?.command === 'stop') {
      await store.deleteChat(chat.chatId);
      return 'Done. Your topics, alerts and digest are deleted. Send /start any time to come back.';
    }
    await store.upsertChat(chat);
    if (!parsed) return `Send a command, for example <code>/brief</code> or <code>/topic cricket</code>.\n\n${HELP}`;

    const { command, arg } = parsed;
    switch (command) {
      case 'start':
        return `Hi${chat.firstName ? ` ${escapeHtml(chat.firstName)}` : ''}! ${HELP}`;
      case 'help':
        return ownerChats().has(chat.chatId) && forwardUrl()
          ? `${HELP}\n\n<b>EarningsLens (only you see these)</b>\n${EARNINGSLENS_COMMANDS.map((c) => `/${c.command}: ${escapeHtml(c.description.replace('EarningsLens: ', ''))}`).join('\n')}`
          : HELP;
      case 'brief':
        return this.brief(chat.chatId, arg);
      case 'ask':
        return this.ask(chat.chatId, arg);
      case 'topic':
        return arg ? this.add(chat.chatId, 'topic', arg) : this.list(chat.chatId, 'topic');
      case 'topics':
        return this.list(chat.chatId, 'topic');
      case 'untopic':
        return this.remove(chat.chatId, 'topic', arg);
      case 'alert':
        return arg ? this.add(chat.chatId, 'alert', arg) : this.list(chat.chatId, 'alert');
      case 'alerts':
        return this.list(chat.chatId, 'alert');
      case 'unalert':
        return this.remove(chat.chatId, 'alert', arg);
      case 'digest':
        return this.digestSetting(chat.chatId, arg);
      default:
        return `I don't know /${escapeHtml(command)}.\n\n${HELP}`;
    }
  }

  private async add(chatId: string, kind: SubscriptionKind, raw: string): Promise<string> {
    const label = LABEL[kind];
    const term = normalizeTerm(raw);
    if (!term) return `Please use 2–40 letters or numbers, for example <code>${label.add} ${kind === 'topic' ? 'cricket' : 'RBI'}</code>.`;
    const existing = await this.deps.store.listTerms(chatId, kind);
    if (existing.includes(term)) return `You already have the ${label.one} <b>${escapeHtml(term)}</b>.`;
    if (existing.length >= MAX_TERMS_PER_KIND) {
      return `You can have up to ${MAX_TERMS_PER_KIND} ${label.many}. Remove one with <code>${label.remove} ${escapeHtml(existing[0])}</code>.`;
    }
    await this.deps.store.addTerm(chatId, kind, term);
    return kind === 'topic'
      ? `Following <b>${escapeHtml(term)}</b>. Your daily digest will lead with it; try <code>/brief ${escapeHtml(term)}</code> now.`
      : `Alert set for <b>${escapeHtml(term)}</b>. I'll message you when a new story mentions it.`;
  }

  private async remove(chatId: string, kind: SubscriptionKind, raw: string): Promise<string> {
    const label = LABEL[kind];
    const term = normalizeTerm(raw);
    if (!term) return `Which ${label.one}? For example <code>${label.remove} ${kind === 'topic' ? 'cricket' : 'RBI'}</code>.`;
    const removed = await this.deps.store.removeTerm(chatId, kind, term);
    return removed ? `Removed the ${label.one} <b>${escapeHtml(term)}</b>.` : `You don't have the ${label.one} <b>${escapeHtml(term)}</b>.`;
  }

  private async list(chatId: string, kind: SubscriptionKind): Promise<string> {
    const label = LABEL[kind];
    const terms = await this.deps.store.listTerms(chatId, kind);
    if (terms.length === 0) return `No ${label.many} yet. Add one with <code>${label.add} ${kind === 'topic' ? 'cricket' : 'RBI'}</code>.`;
    return `Your ${label.many}:\n${terms.map((t) => `• ${escapeHtml(t)}`).join('\n')}\n\nRemove with <code>${label.remove} ${escapeHtml(terms[0])}</code>.`;
  }

  private async digestSetting(chatId: string, arg: string): Promise<string> {
    const value = arg.toLowerCase();
    if (value !== 'on' && value !== 'off') {
      const chat = await this.deps.store.getChat(chatId);
      return `Your daily digest is <b>${chat?.digestEnabled === false ? 'off' : 'on'}</b>. Use <code>/digest on</code> or <code>/digest off</code>.`;
    }
    await this.deps.store.setDigest(chatId, value === 'on');
    return value === 'on' ? 'Daily digest is on.' : 'Daily digest is off. /brief still works any time.';
  }

  private async brief(chatId: string, arg: string): Promise<string> {
    const articles = await this.deps.recentArticles();
    if (arg) {
      const term = normalizeTerm(arg);
      if (!term) return 'Please use 2–40 letters or numbers, for example <code>/brief cricket</code>.';
      const hits = articles.filter((a) => matchesTerm(a, term)).slice(0, BRIEF_SIZE);
      return hits.length
        ? formatArticleList(`Latest on ${term}`, hits)
        : `No recent stories on <b>${escapeHtml(term)}</b>. Follow it with <code>/topic ${escapeHtml(term)}</code> to catch the next ones.`;
    }
    const topics = await this.deps.store.listTerms(chatId, 'topic');
    const picked = this.pick(articles, topics, BRIEF_SIZE);
    if (picked.length === 0) return 'No stories in the last few days. Please try again later.';
    return formatArticleList(topics.length ? 'Your brief' : 'Top stories', picked);
  }

  private async ask(chatId: string, question: string): Promise<string> {
    if (question.length < 5) return 'Ask a question after the command, for example <code>/ask what did RBI decide?</code>';
    const nowMs = this.now().getTime();
    const recent = (this.askLog.get(chatId) ?? []).filter((t) => nowMs - t < 3_600_000);
    if (recent.length >= ASK_LIMIT_PER_HOUR) return `You can ask ${ASK_LIMIT_PER_HOUR} questions an hour. Please try again later.`;
    this.askLog.set(chatId, [...recent, nowMs]);

    const keywords = questionKeywords(question);
    if (keywords.length === 0) return 'Please include a name or topic, for example <code>/ask what did RBI decide?</code>';
    const sources = (await this.deps.searchArticles(keywords)).slice(0, ASK_SOURCES);
    if (sources.length === 0) {
      return `I couldn't find recent stories about <b>${escapeHtml(keywords.join(' '))}</b>. Try <code>/alert ${escapeHtml(keywords[0])}</code> to hear about the next one.`;
    }
    const answer = await this.deps.answer(question, sources);
    const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= sources.length));
    const shown = cited.size ? [...cited].sort((a, b) => a - b) : sources.map((_, i) => i + 1);
    const links = shown.map((n) => `[${n}] <a href="${escapeHtml(sources[n - 1].url).replace(/"/g, '&quot;')}">${escapeHtml(sources[n - 1].title.slice(0, 90))}</a>`);
    return `${escapeHtml(answer)}\n\n<b>Sources</b>\n${links.join('\n')}\n\n<i>Answered from Daily Bytes summaries; check the source before relying on it.</i>`;
  }

  /** Articles matching the topics first, then the newest others, up to `size`. */
  private pick(articles: BotArticle[], topics: string[], size: number): BotArticle[] {
    const onTopic = topics.length ? articles.filter((a) => matchesAny(a, topics).length > 0) : [];
    const rest = articles.filter((a) => !onTopic.includes(a));
    return [...onTopic, ...rest].slice(0, size);
  }

  // ------------------------------------------------------------ pushes

  private async deliver(chatId: string, html: string): Promise<SendResult> {
    const result = await this.deps.send(chatId, html);
    if (result === 'blocked') await this.deps.store.markBlocked(chatId).catch(() => {});
    await sleep(SEND_GAP_MS);
    return result;
  }

  /** After a pipeline run: one message per chat listing new articles that match its alerts. */
  async notifyAlerts(newArticles: BotArticle[]): Promise<{ chats: number; sent: number }> {
    if (newArticles.length === 0) return { chats: 0, sent: 0 };
    const byChat = await this.deps.store.subscribersByChat('alert');
    let sent = 0;
    let chats = 0;
    for (const [chatId, terms] of byChat) {
      const hits = newArticles
        .map((a) => ({ article: a, terms: matchesAny(a, terms) }))
        .filter((h) => h.terms.length > 0)
        .slice(0, ALERT_BATCH);
      if (hits.length === 0) continue;
      chats++;
      const matched = [...new Set(hits.flatMap((h) => h.terms))].join(', ');
      if ((await this.deliver(chatId, formatArticleList(`🔔 New on ${matched}`, hits.map((h) => h.article)))) === 'sent') sent++;
    }
    if (chats) logger.info(`🔔 [bot] alerts: ${sent}/${chats} chats messaged`);
    return { chats, sent };
  }

  /** Daily digest: each subscribed chat's topics first, from the last 24 hours. */
  async sendDailyDigests(): Promise<{ chats: number; sent: number; failed: number }> {
    const chatIds = await this.deps.store.digestChats();
    if (chatIds.length === 0) return { chats: 0, sent: 0, failed: 0 };
    const cutoff = this.now().getTime() - 24 * 3_600_000;
    const today = (await this.deps.recentArticles()).filter((a) => publishedMs(a) >= cutoff);
    const topicsByChat = await this.deps.store.subscribersByChat('topic');
    let sent = 0;
    let failed = 0;
    for (const chatId of chatIds) {
      if (today.length === 0) break;
      const topics = topicsByChat.get(chatId) ?? [];
      const picked = this.pick(today, topics, BRIEF_SIZE);
      const onTopic = topics.length && picked.some((a) => matchesAny(a, topics).length > 0);
      const heading = topics.length && !onTopic ? `Your daily digest (nothing new on ${topics.join(', ')} today)` : 'Your daily digest';
      const result = await this.deliver(chatId, `${formatArticleList(heading, picked)}\n\n<i>/digest off to stop</i>`);
      result === 'sent' ? sent++ : failed++;
    }
    logger.info(`📬 [bot] daily digest: ${sent} sent, ${failed} failed, ${chatIds.length} subscribed, ${today.length} articles`);
    return { chats: chatIds.length, sent, failed };
  }

  /**
   * Weekly wrap (Sundays): the week's top 5 stories on each chat's topics,
   * ranked by reader engagement then recency; the week's most engaged stories
   * when a chat follows nothing or nothing matched.
   */
  async sendWeeklyWraps(): Promise<{ chats: number; sent: number; failed: number }> {
    const chatIds = await this.deps.store.digestChats();
    if (chatIds.length === 0) return { chats: 0, sent: 0, failed: 0 };
    const cutoff = this.now().getTime() - 7 * 24 * 3_600_000;
    const week = (await this.deps.recentArticles(WEEKLY_POOL)).filter((a) => publishedMs(a) >= cutoff);
    if (week.length === 0) return { chats: chatIds.length, sent: 0, failed: 0 };
    const ranked = [...week].sort((a, b) => engagement(b) - engagement(a) || publishedMs(b) - publishedMs(a));
    const topicsByChat = await this.deps.store.subscribersByChat('topic');
    let sent = 0;
    let failed = 0;
    for (const chatId of chatIds) {
      const topics = topicsByChat.get(chatId) ?? [];
      const onTopic = topics.length ? ranked.filter((a) => matchesAny(a, topics).length > 0) : [];
      const picked = (onTopic.length ? [...onTopic, ...ranked.filter((a) => !onTopic.includes(a))] : ranked).slice(0, BRIEF_SIZE);
      const heading = onTopic.length ? `Your week in ${topics.join(', ')}` : 'The week in news';
      const result = await this.deliver(chatId, `🗓 ${formatArticleList(heading, picked)}\n\n<i>/digest off to stop</i>`);
      result === 'sent' ? sent++ : failed++;
    }
    logger.info(`🗓 [bot] weekly wrap: ${sent} sent, ${failed} failed, ${week.length} articles this week`);
    return { chats: chatIds.length, sent, failed };
  }
}

/** Upvotes + bookmarks, for ranking the weekly wrap. */
const engagement = (a: BotArticle) => (a.upvoteCount ?? 0) + (a.bookmarkCount ?? 0);

// ------------------------------------------------------------ webhook

export function webhookSecret(): string {
  return createHmac('sha256', botToken()).update('dailybytes-webhook').digest('hex').slice(0, 48);
}

export function validWebhookSecret(header: string | undefined): boolean {
  if (!botEnabled() || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(webhookSecret());
  return a.length === b.length && timingSafeEqual(a, b);
}

export function publicBackendUrl(): string | null {
  const url = process.env.BACKEND_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  return url ? url.replace(/\/+$/, '') : null;
}

/**
 * Point the bot's webhook at this backend and publish the command menus: the
 * Daily Bytes commands for everyone, plus the forwarded EarningsLens commands
 * in the owner's chat. Another app's webhook is only replaced when its
 * commands are forwarded (TELEGRAM_FORWARD_URL on that host) or with
 * TELEGRAM_BOT_TAKEOVER=1, so nothing is silently cut off.
 */
export async function registerWebhook(): Promise<string> {
  if (!botEnabled()) return 'skipped: no bot token';
  const base = publicBackendUrl();
  if (!base) return 'skipped: BACKEND_PUBLIC_URL / RENDER_EXTERNAL_URL not set';
  const url = `${base}/api/telegram/webhook`;
  const info = await callBot<{ url?: string }>('getWebhookInfo');
  const currentHost = info.url ? new URL(info.url).host : null;
  if (!process.env.TELEGRAM_FORWARD_URL) {
    const stored = await jobStateService.get(FORWARD_URL_KEY).catch(() => null);
    if (stored) setDetectedForwardUrl(stored);
    // First takeover: the webhook belongs to the other app (EarningsLens). Keep
    // its URL and forward its commands there, so both apps share the bot.
    if (!stored && info.url && currentHost !== new URL(url).host && process.env.TELEGRAM_BOT_TAKEOVER !== '0') {
      setDetectedForwardUrl(info.url);
      await jobStateService.set(FORWARD_URL_KEY, info.url);
    }
  }
  const forwardHost = forwardUrl() ? new URL(forwardUrl()!).host : null;
  if (currentHost && currentHost !== new URL(url).host && currentHost !== forwardHost && process.env.TELEGRAM_BOT_TAKEOVER !== '1') {
    throw new Error(`bot webhook points at ${currentHost}, which is not the forward target ${forwardHost}; set TELEGRAM_FORWARD_URL or TELEGRAM_BOT_TAKEOVER=1`);
  }
  await callBot('setWebhook', { url, secret_token: webhookSecret(), allowed_updates: ['message'] });
  await callBot('setMyCommands', { commands: COMMANDS });
  if (forwardHost) {
    for (const chatId of ownerChats()) {
      await callBot('setMyCommands', { commands: [...COMMANDS, ...EARNINGSLENS_COMMANDS].slice(0, 100), scope: { type: 'chat', chat_id: chatId } })
        .catch(() => {});
    }
  }
  return `registered → ${url}${forwardHost ? ` (forwarding EarningsLens commands to ${forwardHost})` : ''}`;
}
