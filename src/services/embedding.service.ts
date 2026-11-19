import path from 'path';
import axios from 'axios';
import { logger } from '../utils/logger';
import { EMBEDDING_DIM } from '../db/embedding-migration';

export { EMBEDDING_DIM };

/**
 * Article embeddings with BAAI/bge-small-en-v1.5 (384-dim, CLS pooling, normalised).
 *
 * - local (default): runs in-process with transformers.js (ONNX, 8-bit, ~34 MB
 *   model). No account, no API credits. The model is downloaded at build time
 *   (`npm run build`) into ./models, and loaded lazily on the first embedding.
 * - cloudflare (optional): the same model on Workers AI, used when
 *   CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set. Same model and
 *   pooling, so vectors from either provider are comparable.
 *
 * Hugging Face's hosted inference was dropped: it needs paid credits.
 */
export type EmbeddingProvider = 'local' | 'cloudflare';

export const EMBEDDING_MODEL = 'BAAI/bge-small-en-v1.5';
const LOCAL_MODEL = 'Xenova/bge-small-en-v1.5';
const CF_MODEL = '@cf/baai/bge-small-en-v1.5';
export const MODEL_CACHE_DIR = path.resolve(__dirname, '..', '..', 'models');
const MAX_CHARS = 2000; // the model reads 512 tokens; longer text is truncated anyway

export function activeEmbeddingProvider(): EmbeddingProvider | null {
  if (process.env.EMBEDDINGS_DISABLED === '1') return null;
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) return 'cloudflare';
  return 'local';
}

/** Identifies the model behind stored vectors (provider-independent). */
export function activeEmbeddingModel(): string | null {
  return activeEmbeddingProvider() ? EMBEDDING_MODEL : null;
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

type Extractor = (texts: string[], opts: { pooling: 'cls'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let extractor: Promise<Extractor> | null = null;

/** Load the local model once (lazy, so a wake-up that doesn't embed stays light). */
export function loadLocalModel(): Promise<Extractor> {
  if (!extractor) {
    extractor = (async () => {
      const started = Date.now();
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = MODEL_CACHE_DIR;
      const fe = await pipeline('feature-extraction', LOCAL_MODEL, { dtype: 'q8' });
      logger.info(`✅ Local embedding model loaded in ${Date.now() - started} ms`);
      return fe as unknown as Extractor;
    })().catch((err) => {
      extractor = null;
      throw err;
    });
  }
  return extractor;
}

async function embedLocal(texts: string[]): Promise<number[][]> {
  const fe = await loadLocalModel();
  const out = await fe(texts, { pooling: 'cls', normalize: true });
  return checkDims(out.tolist(), texts.length);
}

async function embedCloudflare(texts: string[]): Promise<number[][]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${CF_MODEL}`;
  const { data } = await axios.post(url, { text: texts, pooling: 'cls' }, {
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 30_000,
    validateStatus: () => true,
  });
  if (!data?.success) {
    const message = data?.errors?.map((e: any) => e.message).join('; ') || 'no response';
    throw new Error(`Cloudflare embeddings failed: ${message}`);
  }
  // Workers AI returns CLS vectors unnormalised; normalise to match the local model.
  const vectors = checkDims(data.result?.data, texts.length);
  return vectors.map((v) => {
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
}

/** Embed several texts in one call. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const clipped = texts.map((t) => (t || ' ').slice(0, MAX_CHARS));
  const provider = activeEmbeddingProvider();
  if (provider === 'cloudflare') return embedCloudflare(clipped);
  if (provider === 'local') return embedLocal(clipped);
  throw new Error('Embeddings are disabled (EMBEDDINGS_DISABLED=1)');
}

export async function embedText(text: string): Promise<number[]> {
  return (await embedTexts([text]))[0];
}

/** Kept for the boot sequence; the local model now loads on first use instead. */
export function warmupEmbedder(): void {
  logger.info(`ℹ  Embeddings: ${activeEmbeddingProvider() ?? 'disabled'} (${EMBEDDING_MODEL}, loaded on first use)`);
}
