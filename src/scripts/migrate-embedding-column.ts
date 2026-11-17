import 'dotenv/config';
import { createClient } from '@libsql/client';
import { ensureEmbeddingColumn, EMBEDDING_DIM } from '../db/embedding-migration';
import { logger } from '../utils/logger';

// Targeted version of the embedding step in db/migrate.ts, so it can be run
// on its own against an existing database.
async function main() {
  const url = process.env.DATABASE_URL;
  const authToken = process.env.DATABASE_AUTH_TOKEN;
  if (!url || !authToken) throw new Error('DATABASE_URL and DATABASE_AUTH_TOKEN are required');
  const client = createClient({ url, authToken });
  const result = await ensureEmbeddingColumn(client, EMBEDDING_DIM);
  logger.info(`✅ articles.embedding is F32_BLOB(${EMBEDDING_DIM}) (${result})`);
  if (result === 'resized') logger.warn('Old embeddings discarded — run `npm run embed:backfill`');
}

main().catch((err) => {
  logger.error(`❌ Embedding column migration failed: ${err.message}`);
  process.exit(1);
});
