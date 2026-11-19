import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BotService, BotArticle, parseCommand } from '../src/bot/bot.service';
import { BotStore } from '../src/bot/bot-store';
import type { SendResult } from '../src/bot/telegram-api';

const NOW = new Date('2026-11-18T09:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const ARTICLES: BotArticle[] = [
  { title: 'Sensex closes higher', content: 'Markets rally', url: 'https://e.com/1', category: 'business', hashtags: '#Sensex', publishedAt: hoursAgo(1) },
  { title: 'Pant fit for Test', content: 'India squad news', url: 'https://e.com/2', category: 'sports', hashtags: '#IndiaCricket', publishedAt: hoursAgo(2) },
  { title: 'RBI keeps repo rate', content: 'Governor speaks', url: 'https://e.com/3', category: 'business', hashtags: '#RBI', publishedAt: hoursAgo(3) },
  { title: 'Old cricket story', content: 'Yesterday', url: 'https://e.com/4', category: 'sports', hashtags: '#Cricket', publishedAt: hoursAgo(30) },
];

let store: BotStore;
let sent: Array<{ chatId: string; html: string }>;
let sendResult: Record<string, SendResult>;
let bot: BotService;
let answerFn: (q: string, a: BotArticle[]) => Promise<string>;
const chat = (id: string) => ({ chatId: id, firstName: 'Ronik' });

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-test-'));
  store = new BotStore(createClient({ url: `file:${join(dir, 'bot.db')}` }));
  sent = [];
  sendResult = {};
  answerFn = async () => 'The RBI kept the repo rate unchanged [1].';
  bot = new BotService({
    store,
    recentArticles: async () => ARTICLES,
    searchArticles: async (keywords) => ARTICLES.filter((a) => keywords.some((k) => `${a.title} ${a.content}`.toLowerCase().includes(k))),
    answer: async (question, articles) => answerFn(question, articles),
    send: async (chatId, html) => { sent.push({ chatId, html }); return sendResult[chatId] ?? 'sent'; },
    now: () => NOW,
  });
});

describe('parseCommand', () => {
  it('handles bot-name suffix and args', () => {
    expect(parseCommand('/Topic@DailyBytesBot  Cricket ')).toEqual({ command: 'topic', arg: 'Cricket' });
    expect(parseCommand('hello')).toBeNull();
  });
});

describe('commands', () => {
  it('/start registers the chat and greets', async () => {
    expect(await bot.handleMessage(chat('1'), '/start')).toContain('Hi Ronik');
    expect(await store.getChat('1')).toMatchObject({ digestEnabled: true, blocked: false });
  });

  it('/topic adds, dedupes, lists and removes', async () => {
    expect(await bot.handleMessage(chat('1'), '/topic Cricket')).toContain('Following <b>cricket</b>');
    expect(await bot.handleMessage(chat('1'), '/topic cricket')).toContain('already have');
    expect(await bot.handleMessage(chat('1'), '/topics')).toContain('• cricket');
    expect(await bot.handleMessage(chat('1'), '/untopic cricket')).toContain('Removed');
    expect(await bot.handleMessage(chat('1'), '/topics')).toContain('No topics yet');
  });

  it('rejects bad terms and enforces the limit', async () => {
    expect(await bot.handleMessage(chat('1'), '/alert <b>')).toContain('2–40 letters');
    for (let i = 0; i < 10; i++) await bot.handleMessage(chat('1'), `/alert term${i}`);
    expect(await bot.handleMessage(chat('1'), '/alert one more')).toContain('up to 10 alerts');
  });

  it('/brief puts followed topics first; /brief <topic> filters', async () => {
    await bot.handleMessage(chat('1'), '/topic cricket');
    const brief = await bot.handleMessage(chat('1'), '/brief');
    expect(brief.indexOf('Pant fit')).toBeLessThan(brief.indexOf('Sensex'));
    const rbi = await bot.handleMessage(chat('1'), '/brief rbi');
    expect(rbi).toContain('RBI keeps repo rate');
    expect(rbi).not.toContain('Sensex');
    expect(await bot.handleMessage(chat('1'), '/brief tennis')).toContain('No recent stories');
  });

  it('/stop deletes everything', async () => {
    await bot.handleMessage(chat('1'), '/alert rbi');
    await bot.handleMessage(chat('1'), '/stop');
    expect(await store.getChat('1')).toBeNull();
    expect((await store.subscribersByChat('alert')).size).toBe(0);
  });
});

describe('alerts', () => {
  it('messages only chats whose alerts match, once per chat', async () => {
    await bot.handleMessage(chat('1'), '/alert rbi');
    await bot.handleMessage(chat('1'), '/alert sensex');
    await bot.handleMessage(chat('2'), '/alert tennis');
    const out = await bot.notifyAlerts(ARTICLES.slice(0, 3));
    expect(out).toEqual({ chats: 1, sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe('1');
    expect(sent[0].html).toContain('New on sensex, rbi');
  });

  it('marks a chat blocked on 403 and skips it afterwards', async () => {
    await bot.handleMessage(chat('1'), '/alert rbi');
    sendResult['1'] = 'blocked';
    await bot.notifyAlerts(ARTICLES);
    expect((await store.getChat('1'))?.blocked).toBe(true);
    sent.length = 0;
    await bot.notifyAlerts(ARTICLES);
    expect(sent).toHaveLength(0);
  });
});

describe('daily digest', () => {
  it('sends last-24h stories with topics first, skipping chats with digest off', async () => {
    await bot.handleMessage(chat('1'), '/topic cricket');
    await bot.handleMessage(chat('2'), '/start');
    await bot.handleMessage(chat('3'), '/digest off');
    const out = await bot.sendDailyDigests();
    expect(out).toEqual({ chats: 2, sent: 2, failed: 0 });
    const one = sent.find((s) => s.chatId === '1')!.html;
    expect(one.indexOf('Pant fit')).toBeLessThan(one.indexOf('Sensex'));
    expect(one).not.toContain('Old cricket story');
    expect(sent.some((s) => s.chatId === '3')).toBe(false);
  });

  it('says so when nothing matched the topics', async () => {
    await bot.handleMessage(chat('1'), '/topic tennis');
    await bot.sendDailyDigests();
    expect(sent[0].html).toContain('nothing new on tennis today');
  });
});

describe('/ask', () => {
  it('answers from matching stories and lists only the cited sources', async () => {
    const seen: BotArticle[][] = [];
    answerFn = async (_q, a) => { seen.push(a); return 'The RBI kept the repo rate unchanged [1].'; };
    const reply = await bot.handleMessage(chat('1'), '/ask what did RBI decide on the repo rate?');
    expect(seen[0].map((a) => a.url)).toEqual(['https://e.com/3']);
    expect(reply).toContain('The RBI kept the repo rate unchanged [1].');
    expect(reply).toContain('[1] <a href="https://e.com/3">RBI keeps repo rate</a>');
  });

  it('escapes the model answer', async () => {
    answerFn = async () => 'RBI <b>held</b> [1]';
    expect(await bot.handleMessage(chat('1'), '/ask rbi repo')).toContain('RBI &lt;b&gt;held&lt;/b&gt; [1]');
  });

  it('says so when nothing matches, without calling the model', async () => {
    let called = false;
    answerFn = async () => { called = true; return ''; };
    expect(await bot.handleMessage(chat('1'), '/ask what about tennis?')).toContain("couldn't find recent stories about <b>tennis</b>");
    expect(called).toBe(false);
  });

  it('needs a question and limits each chat to 10 an hour', async () => {
    expect(await bot.handleMessage(chat('1'), '/ask')).toContain('Ask a question');
    for (let i = 0; i < 10; i++) await bot.handleMessage(chat('2'), '/ask rbi repo rate');
    expect(await bot.handleMessage(chat('2'), '/ask rbi repo rate')).toContain('10 questions an hour');
  });
});

describe('weekly wrap', () => {
  const WEEK: BotArticle[] = [
    { title: 'Big cricket win', content: 'x', url: 'https://e.com/w1', hashtags: '#Cricket', publishedAt: hoursAgo(50), upvoteCount: 9 },
    { title: 'Small cricket note', content: 'x', url: 'https://e.com/w2', hashtags: '#Cricket', publishedAt: hoursAgo(5), upvoteCount: 1 },
    { title: 'Budget explained', content: 'x', url: 'https://e.com/w3', category: 'business', publishedAt: hoursAgo(30), upvoteCount: 20, bookmarkCount: 5 },
    { title: 'Too old', content: 'cricket', url: 'https://e.com/w4', hashtags: '#Cricket', publishedAt: hoursAgo(24 * 8), upvoteCount: 99 },
  ];
  beforeEach(() => {
    bot = new BotService({
      store, recentArticles: async () => WEEK, searchArticles: async () => [], answer: async () => '',
      send: async (chatId, html) => { sent.push({ chatId, html }); return 'sent'; }, now: () => NOW,
    });
  });

  it('leads with topic stories ranked by engagement, then the rest; drops older than 7 days', async () => {
    await bot.handleMessage(chat('1'), '/topic cricket');
    await bot.handleMessage(chat('2'), '/start');
    expect(await bot.sendWeeklyWraps()).toEqual({ chats: 2, sent: 2, failed: 0 });
    const one = sent.find((s) => s.chatId === '1')!.html;
    expect(one).toContain('Your week in cricket');
    expect(one.indexOf('Big cricket win')).toBeLessThan(one.indexOf('Small cricket note'));
    expect(one.indexOf('Small cricket note')).toBeLessThan(one.indexOf('Budget explained'));
    expect(one).not.toContain('Too old');
    const two = sent.find((s) => s.chatId === '2')!.html;
    expect(two).toContain('The week in news');
    expect(two.indexOf('Budget explained')).toBeLessThan(two.indexOf('Big cricket win'));
  });
});
