import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const post = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { post } }));

import { embedTexts, activeEmbeddingModel } from '../src/services/embedding.service';
import { syncEmbeddingModel, backfillEmbeddings } from '../src/services/embedding-sync.service';
import { ensureEmbeddingColumn } from '../src/db/embedding-migration';

const vec = (seed: number) => Array.from({ length: 1024 }, (_, i) => ((i + seed) % 10) / 10);
const saved = { ...process.env };

beforeEach(() => {
  post.mockReset();
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct';
  process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
});
afterEach(() => { process.env = { ...saved }; });

describe('Cloudflare embeddings', () => {
  it('is preferred when configured and batches texts in one request', async () => {
    post.mockResolvedValue({ data: { success: true, result: { shape: [2, 1024], data: [vec(1), vec(2)] } } });
    expect(activeEmbeddingModel()).toBe('cloudflare:@cf/baai/bge-m3');
    const out = await embedTexts(['a', 'b']);
    expect(out).toHaveLength(2);
    const [url, body, opts] = post.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/baai/bge-m3');
    expect(body).toEqual({ text: ['a', 'b'] });
    expect(opts.headers.Authorization).toBe('Bearer cf-token');
  });

  it('rejects wrong dimensions and API errors', async () => {
    post.mockResolvedValueOnce({ data: { success: true, result: { data: [[1, 2, 3]] } } });
    await expect(embedTexts(['a'])).rejects.toThrow('expected 1024');
    post.mockResolvedValueOnce({ data: { success: false, errors: [{ message: 'Authentication error' }] } });
    await expect(embedTexts(['a'])).rejects.toThrow('Authentication error');
  });
});

describe('model switch and backfill (real libSQL)', () => {
  it('clears vectors from another model, then re-embeds every article', async () => {
    const c = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), 'emb-')), 'e.db')}` });
    await c.execute('CREATE TABLE articles (id TEXT PRIMARY KEY, title TEXT, content TEXT, published_at TEXT)');
    await ensureEmbeddingColumn(c, 1024);
    for (let i = 0; i < 3; i++) {
      await c.execute({ sql: 'INSERT INTO articles VALUES (?, ?, ?, ?, vector(?))', args: [`a${i}`, `T${i}`, 'c', `2026-11-1${i}`, `[${vec(i).join(',')}]`] });
    }
    await c.execute(`CREATE TABLE job_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    await c.execute({ sql: 'INSERT INTO job_state VALUES (?, ?, ?)', args: ['embedding:model', 'huggingface:old', 'x'] });

    expect(await syncEmbeddingModel(c)).toBe(3);
    expect(await syncEmbeddingModel(c)).toBe(0);

    post.mockImplementation(async (_u: string, body: any) => ({ data: { success: true, result: { data: body.text.map((_: string, i: number) => vec(i)) } } }));
    expect(await backfillEmbeddings(c)).toEqual({ embedded: 3, failed: 0, remaining: 0 });
    const hits = await c.execute({ sql: `SELECT a.id FROM vector_top_k('articles_embedding_idx', vector(?), 1) v JOIN articles a ON a.rowid = v.id`, args: [`[${vec(0).join(',')}]`] });
    expect(hits.rows).toHaveLength(1);
  });
});
