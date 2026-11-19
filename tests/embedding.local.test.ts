import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'fs';
import { embedTexts, MODEL_CACHE_DIR } from '../src/services/embedding.service';

// Runs the real in-process model. Skipped when it hasn't been downloaded
// (`node scripts/prefetch-embedding-model.js`), so the suite stays offline-safe.
const hasModel = existsSync(`${MODEL_CACHE_DIR}/Xenova/bge-small-en-v1.5`);

describe.skipIf(!hasModel)('local embedding model (real)', () => {
  beforeAll(() => { delete process.env.CLOUDFLARE_ACCOUNT_ID; delete process.env.CLOUDFLARE_API_TOKEN; });

  it('returns normalised 384-dim vectors that rank the relevant story first', async () => {
    const [q, rbi, cricket] = await embedTexts([
      'what did the central bank decide on interest rates',
      'RBI keeps the repo rate unchanged at 6.5% as food inflation stays high',
      'India beat New Zealand by 5 wickets in the Wellington Test',
    ]);
    expect(q).toHaveLength(384);
    expect(Math.hypot(...q)).toBeCloseTo(1, 4);
    const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
    expect(dot(q, rbi)).toBeGreaterThan(dot(q, cricket));
  }, 60_000);
});
