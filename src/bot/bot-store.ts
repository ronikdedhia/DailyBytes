import { randomUUID } from 'crypto';
import type { Client } from '@libsql/client';
import { ensureTelegramTables } from '../db/telegram-tables';

export type SubscriptionKind = 'topic' | 'alert';

export interface ChatInfo {
  chatId: string;
  username?: string | null;
  firstName?: string | null;
}

export interface ChatRow {
  chatId: string;
  digestEnabled: boolean;
  blocked: boolean;
}

/** Telegram bot chats and their topic / alert subscriptions. */
export class BotStore {
  private ready: Promise<void> | null = null;

  constructor(private readonly client: Client) {}

  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = ensureTelegramTables(this.client).catch((err) => {
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  /** Create or refresh the chat. Writing to the bot again un-blocks it. */
  async upsertChat(chat: ChatInfo): Promise<void> {
    await this.ensure();
    const now = new Date().toISOString();
    await this.client.execute({
      sql: `INSERT INTO telegram_chats (chat_id, username, first_name, digest_enabled, blocked, created_at, updated_at)
            VALUES (?, ?, ?, 1, 0, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name,
              blocked = 0, updated_at = excluded.updated_at`,
      args: [chat.chatId, chat.username ?? null, chat.firstName ?? null, now, now],
    });
  }

  async getChat(chatId: string): Promise<ChatRow | null> {
    await this.ensure();
    const r = await this.client.execute({
      sql: 'SELECT chat_id, digest_enabled, blocked FROM telegram_chats WHERE chat_id = ?',
      args: [chatId],
    });
    const row = r.rows[0];
    return row ? { chatId: String(row.chat_id), digestEnabled: Number(row.digest_enabled) === 1, blocked: Number(row.blocked) === 1 } : null;
  }

  async setDigest(chatId: string, enabled: boolean): Promise<void> {
    await this.ensure();
    await this.client.execute({
      sql: 'UPDATE telegram_chats SET digest_enabled = ?, updated_at = ? WHERE chat_id = ?',
      args: [enabled ? 1 : 0, new Date().toISOString(), chatId],
    });
  }

  /** The user blocked the bot (Telegram 403): stop sending to them. */
  async markBlocked(chatId: string): Promise<void> {
    await this.ensure();
    await this.client.execute({
      sql: 'UPDATE telegram_chats SET blocked = 1, updated_at = ? WHERE chat_id = ?',
      args: [new Date().toISOString(), chatId],
    });
  }

  /** /stop: forget the chat and everything it subscribed to. */
  async deleteChat(chatId: string): Promise<void> {
    await this.ensure();
    await this.client.batch([
      { sql: 'DELETE FROM telegram_subscriptions WHERE chat_id = ?', args: [chatId] },
      { sql: 'DELETE FROM telegram_chats WHERE chat_id = ?', args: [chatId] },
    ], 'write');
  }

  async listTerms(chatId: string, kind: SubscriptionKind): Promise<string[]> {
    await this.ensure();
    const r = await this.client.execute({
      sql: 'SELECT term FROM telegram_subscriptions WHERE chat_id = ? AND kind = ? ORDER BY created_at, term',
      args: [chatId, kind],
    });
    return r.rows.map((row) => String(row.term));
  }

  /** Returns false if the chat already had the term. */
  async addTerm(chatId: string, kind: SubscriptionKind, term: string): Promise<boolean> {
    await this.ensure();
    const r = await this.client.execute({
      sql: `INSERT INTO telegram_subscriptions (id, chat_id, kind, term, created_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(chat_id, kind, term) DO NOTHING`,
      args: [randomUUID(), chatId, kind, term, new Date().toISOString()],
    });
    return r.rowsAffected > 0;
  }

  async removeTerm(chatId: string, kind: SubscriptionKind, term: string): Promise<boolean> {
    await this.ensure();
    const r = await this.client.execute({
      sql: 'DELETE FROM telegram_subscriptions WHERE chat_id = ? AND kind = ? AND term = ?',
      args: [chatId, kind, term],
    });
    return r.rowsAffected > 0;
  }

  /** {chatId: [terms]} for every chat that can receive messages. */
  async subscribersByChat(kind: SubscriptionKind): Promise<Map<string, string[]>> {
    await this.ensure();
    const r = await this.client.execute({
      sql: `SELECT s.chat_id, s.term FROM telegram_subscriptions s
            JOIN telegram_chats c ON c.chat_id = s.chat_id
            WHERE s.kind = ? AND c.blocked = 0`,
      args: [kind],
    });
    const out = new Map<string, string[]>();
    for (const row of r.rows) {
      const chatId = String(row.chat_id);
      out.set(chatId, [...(out.get(chatId) ?? []), String(row.term)]);
    }
    return out;
  }

  /** Chat ids with the daily digest on. */
  async digestChats(): Promise<string[]> {
    await this.ensure();
    const r = await this.client.execute('SELECT chat_id FROM telegram_chats WHERE digest_enabled = 1 AND blocked = 0');
    return r.rows.map((row) => String(row.chat_id));
  }
}
