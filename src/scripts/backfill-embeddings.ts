import 'dotenv/config';
import { rawClient } from '../db/client';
import { activeEmbeddingModel } from '../services/embedding.service';
import { backfillEmbeddings } from '../services/embedding-sync.service';
import { logger } from '../utils/logger';

// Embeds every article without a vector, using the active provider
// (in-process bge-small model, or Cloudflare Workers AI if configured). If the provider
// changed since vectors were stored, the old ones are cleared first.
async function main() {
  const model = activeEmbeddingModel();
  if (!model) throw new Error('Embeddings are disabled (EMBEDDINGS_DISABLED=1)');
  logger.info(`🔍 Backfilling embeddings with ${model}`);
  let total = 0;
  for (;;) {
    const { embedded, remaining } = await backfillEmbeddings(rawClient, 500);
    total += embedded;
    if (embedded === 0 || remaining === 0) break;
  }
  logger.info(`✅ Backfill complete: ${total} articles embedded`);
}

main().then(() => process.exit(0)).catch((err) => {
  logger.error(`Backfill failed: ${err.message}`);
  process.exit(1);
});
