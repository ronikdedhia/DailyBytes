import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const handled: any[] = [];
const sentMsgs: any[] = [];
vi.mock('../src/bot', () => ({
  botService: { handleMessage: vi.fn(async (chat: any, text: string) => { handled.push({ chat, text }); return `reply:${text}`; }) },
}));
vi.mock('../src/bot/telegram-api', async (orig) => ({
  ...(await orig<any>()),
  sendHtml: vi.fn(async (chatId: string, html: string) => { sentMsgs.push({ chatId, html }); return 'sent'; }),
}));

import router from '../src/routes/telegram.router';
import { webhookSecret } from '../src/bot/bot.service';

let server: Server;
let base = '';
beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); delete process.env.TELEGRAM_BOT_TOKEN; });
beforeEach(() => { handled.length = 0; sentMsgs.length = 0; });

const post = (body: any, secret?: string) => fetch(`${base}/api/telegram/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
  body: JSON.stringify(body),
});
const msg = (text: string, type = 'private') => ({ update_id: 1, message: { chat: { id: 42, type, first_name: 'R' }, text } });
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('POST /api/telegram/webhook', () => {
  it('rejects a missing or wrong secret', async () => {
    expect((await post(msg('/brief'))).status).toBe(401);
    expect((await post(msg('/brief'), 'nope')).status).toBe(401);
    await settle();
    expect(handled).toHaveLength(0);
  });

  it('handles a private message and replies', async () => {
    expect((await post(msg('/brief'), webhookSecret())).status).toBe(200);
    await settle();
    expect(handled[0]).toMatchObject({ chat: { chatId: '42', firstName: 'R' }, text: '/brief' });
    expect(sentMsgs[0]).toEqual({ chatId: '42', html: 'reply:/brief' });
  });

  it('ignores group messages and non-text updates', async () => {
    await post(msg('/brief', 'group'), webhookSecret());
    await post({ update_id: 2, message: { chat: { id: 1, type: 'private' }, sticker: {} } }, webhookSecret());
    await settle();
    expect(handled).toHaveLength(0);
  });
});
