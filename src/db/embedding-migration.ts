import type { Client } from '@libsql/client';

export const EMBEDDING_INDEX = 'articles_embedding_idx';
// mixedbread-ai/mxbai-embed-large-v1 output size.
export const EMBEDDING_DIM = 1024;

/**
 * Makes articles.embedding an F32_BLOB(dim) column with a vector index.
 *
 * SQLite can't change a column's type in place, so a column with the wrong
 * dimension is dropped and re-added. Its existing vectors are discarded: they
 * came from a different model and can't be compared with new query vectors.
 * Run `npm run embed:backfill` afterwards to re-embed articles.
 *
 * Returns what it did, so callers can log it.
 */
export async function ensureEmbeddingColumn(
  client: Client,
  dim: number,
): Promise<'unchanged' | 'added' | 'resized'> {
  const info = await client.execute('PRAGMA table_info(articles)');
  const column = info.rows.find((r) => r.name === 'embedding');
  const wanted = `F32_BLOB(${dim})`;

  if (column && String(column.type).toUpperCase() === wanted) {
    await client.execute(`CREATE INDEX IF NOT EXISTS ${EMBEDDING_INDEX} ON articles(libsql_vector_idx(embedding))`);
    return 'unchanged';
  }

  const steps = [
    `DROP INDEX IF EXISTS ${EMBEDDING_INDEX}`,
    ...(column ? ['ALTER TABLE articles DROP COLUMN embedding'] : []),
    `ALTER TABLE articles ADD COLUMN embedding ${wanted}`,
    `CREATE INDEX IF NOT EXISTS ${EMBEDDING_INDEX} ON articles(libsql_vector_idx(embedding))`,
  ];
  await client.batch(steps, 'write');
  return column ? 'resized' : 'added';
}
