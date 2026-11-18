import type { Client } from '@libsql/client';

/** DDL for the Telegram bot tables. Idempotent; used by migrate.ts and lazily by the bot. */
export const TELEGRAM_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS telegram_chats (
    chat_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    digest_enabled INTEGER NOT NULL DEFAULT 1,
    blocked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS telegram_subscriptions (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES telegram_chats(chat_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('topic', 'alert')),
    term TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (chat_id, kind, term)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_telegram_subscriptions_kind ON telegram_subscriptions(kind)`,
];

export async function ensureTelegramTables(client: Client): Promise<void> {
  await client.batch(TELEGRAM_TABLES_SQL, 'write');
}
