import 'dotenv/config';
import { rawClient } from '../db/client';
import { activeEmbeddingModel } from '../services/embedding.service';
import { backfillEmbeddings } from '../services/embedding-sync.service';
import { logger } from '../utils/logger';

// Embeds every article without a vector, using the active provider
// (Cloudflare Workers AI if configured, else Hugging Face). If the provider
// changed since vectors were stored, the old ones are cleared first.
async function main() {
  const model = activeEmbeddingModel();
  if (!model) throw new Error('No embedding provider configured (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN, or HUGGING_FACE_API_KEY)');
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
