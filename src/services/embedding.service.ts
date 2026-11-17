import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { EMBEDDING_DIM } from '../db/embedding-migration';

// sentence-transformers/all-MiniLM-L6-v2 dropped feature-extraction on the new HF router.
// mxbai-embed-large-v1 is the replacement — verified feature-extraction, 1024-dim.
const HF_MODEL_URL =
  process.env.HF_INFERENCE_URL ||
  'https://router.huggingface.co/hf-inference/models/mixedbread-ai/mxbai-embed-large-v1';

export { EMBEDDING_DIM };

export async function embedText(text: string): Promise<number[]> {
  const response = await axios.post<number[][]>(
    HF_MODEL_URL,
    { inputs: text.slice(0, 512) },
    {
      headers: {
        Authorization: `Bearer ${config.huggingface.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
  const embedding = response.data[0];
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding has ${Array.isArray(embedding) ? embedding.length : 'no'} dimensions, expected ${EMBEDDING_DIM}`);
  }
  return embedding;
}

export function warmupEmbedder(retries = 3, delayMs = 5000): void {
  const attempt = (remaining: number) => {
    embedText('warmup')
      .then(() => logger.info('✅ Embedding service warmed up'))
      .catch((err: Error) => {
        if (remaining > 0) {
          logger.warn(`Embedding warmup failed, retrying in ${delayMs / 1000}s (${remaining} left): ${err.message}`);
          setTimeout(() => attempt(remaining - 1), delayMs);
        } else {
          logger.warn(`Embedding warmup failed after all retries: ${err.message}`);
        }
      });
  };
  attempt(retries);
}
