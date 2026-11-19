import type { Client } from '@libsql/client';
import { logger } from '../utils/logger';
import { activeEmbeddingModel, embedTexts } from './embedding.service';

export const EMBEDDING_MODEL_KEY = 'embedding:model';
const BATCH = 20;

async function getState(client: Client, key: string): Promise<string | null> {
  await client.execute('CREATE TABLE IF NOT EXISTS job_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const r = await client.execute({ sql: 'SELECT value FROM job_state WHERE key = ?', args: [key] });
  return r.rows[0] ? String(r.rows[0].value) : null;
}

async function setState(client: Client, key: string, value: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO job_state (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [key, value, new Date().toISOString()],
  });
}

/**
 * Stored vectors are only comparable with query vectors from the same model.
 * If the active model differs from the one recorded, clear every stored vector
 * so backfill re-embeds them. Returns how many were cleared.
 */
export async function syncEmbeddingModel(client: Client): Promise<number> {
  const model = activeEmbeddingModel();
  if (!model) return 0;
  const stored = await getState(client, EMBEDDING_MODEL_KEY);
  if (stored === model) return 0;
  const r = await client.execute('UPDATE articles SET embedding = NULL WHERE embedding IS NOT NULL');
  await setState(client, EMBEDDING_MODEL_KEY, model);
  logger.info(`🔁 Embedding model is now ${model} (was ${stored ?? 'unrecorded'}); cleared ${r.rowsAffected} old vectors`);
  return r.rowsAffected;
}

/** Embed up to `limit` articles that have no vector yet, newest first, in batches. */
export async function backfillEmbeddings(client: Client, limit = 200): Promise<{ embedded: number; failed: number; remaining: number }> {
  if (!activeEmbeddingModel()) return { embedded: 0, failed: 0, remaining: 0 };
  await syncEmbeddingModel(client);
  const rows = (await client.execute({
    sql: 'SELECT id, title, content FROM articles WHERE embedding IS NULL ORDER BY published_at DESC LIMIT ?',
    args: [limit],
  })).rows;
  let embedded = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    try {
      const vectors = await embedTexts(batch.map((r) => `${r.title} ${r.content ?? ''}`));
      await client.batch(batch.map((row, j) => ({
        sql: 'UPDATE articles SET embedding = vector(?) WHERE id = ?',
        args: [`[${vectors[j].join(',')}]`, String(row.id)],
      })), 'write');
      embedded += batch.length;
    } catch (err: any) {
      failed += batch.length;
      logger.warn(`⚠ [embed-backfill] batch failed: ${err.message}`);
      if (/No embedding provider|credits|401|403/i.test(err.message)) break;
    }
  }
  const remaining = Number((await client.execute('SELECT count(*) AS n FROM articles WHERE embedding IS NULL')).rows[0].n);
  logger.info(`🧮 [embed-backfill] embedded ${embedded}, failed ${failed}, ${remaining} still without a vector`);
  return { embedded, failed, remaining };
}
