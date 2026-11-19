import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { EMBEDDING_DIM } from '../db/embedding-migration';

export { EMBEDDING_DIM };

/**
 * Embedding providers, both 1024-dim to match articles.embedding:
 * - Cloudflare Workers AI `@cf/baai/bge-m3` (free daily allowance, multilingual),
 *   used when CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set
 * - Hugging Face `mxbai-embed-large-v1` (needs inference credits) otherwise
 * Vectors from different models can't be compared, so embedding-sync.service
 * clears stored vectors when the active model changes.
 */
export type EmbeddingProvider = 'cloudflare' | 'huggingface';

const CF_MODEL = process.env.CLOUDFLARE_EMBEDDING_MODEL || '@cf/baai/bge-m3';
const HF_MODEL_URL =
  process.env.HF_INFERENCE_URL ||
  'https://router.huggingface.co/hf-inference/models/mixedbread-ai/mxbai-embed-large-v1';
const MAX_CHARS = 2000;

export function activeEmbeddingProvider(): EmbeddingProvider | null {
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) return 'cloudflare';
  if (config.huggingface.apiKey) return 'huggingface';
  return null;
}

/** Identifies which model produced the stored vectors. */
export function activeEmbeddingModel(): string | null {
  const provider = activeEmbeddingProvider();
  if (provider === 'cloudflare') return `cloudflare:${CF_MODEL}`;
  if (provider === 'huggingface') return `huggingface:${HF_MODEL_URL.split('/models/')[1] ?? HF_MODEL_URL}`;
  return null;
}

function checkDims(vectors: unknown, count: number): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count) {
    throw new Error(`Embedding response has ${Array.isArray(vectors) ? vectors.length : 'no'} vectors, expected ${count}`);
  }
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) {
      throw new Error(`Embedding has ${Array.isArray(v) ? v.length : 'no'} dimensions, expected ${EMBEDDING_DIM}`);
    }
  }
  return vectors as number[][];
}

async function embedCloudflare(texts: string[]): Promise<number[][]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${CF_MODEL}`;
  const { data } = await axios.post(url, { text: texts }, {
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 30_000,
    validateStatus: () => true,
  });
  if (!data?.success) {
    const message = data?.errors?.map((e: any) => e.message).join('; ') || 'no response';
    throw new Error(`Cloudflare embeddings failed: ${message}`);
  }
  // bge-large returns result.data; bge-m3 has also been documented as result.response.
  return checkDims(data.result?.data ?? data.result?.response, texts.length);
}

async function embedHuggingFace(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (const text of texts) {
    const response = await axios.post(HF_MODEL_URL, { inputs: text }, {
      headers: { Authorization: `Bearer ${config.huggingface.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15_000,
    });
    const out = response.data;
    vectors.push(Array.isArray(out?.[0]) ? out[0] : out);
  }
  return checkDims(vectors, texts.length);
}

/** Embed several texts in one request where the provider supports it. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const clipped = texts.map((t) => (t || ' ').slice(0, MAX_CHARS));
  const provider = activeEmbeddingProvider();
  if (provider === 'cloudflare') return embedCloudflare(clipped);
  if (provider === 'huggingface') return embedHuggingFace(clipped.map((t) => t.slice(0, 512)));
  throw new Error('No embedding provider configured (set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN)');
}

export async function embedText(text: string): Promise<number[]> {
  return (await embedTexts([text]))[0];
}

export function warmupEmbedder(retries = 3, delayMs = 5000): void {
  if (!activeEmbeddingProvider()) {
    logger.info('ℹ  No embedding provider configured — semantic search uses keyword fallback');
    return;
  }
  const attempt = (remaining: number) => {
    embedText('warmup')
      .then(() => logger.info(`✅ Embedding service warmed up (${activeEmbeddingModel()})`))
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
