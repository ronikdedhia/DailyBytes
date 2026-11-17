import { describe, it, expect, beforeEach } from 'vitest';
import { createClient, Client } from '@libsql/client';
import { ensureEmbeddingColumn } from '../src/db/embedding-migration';

const colType = async (c: Client) =>
  (await c.execute('PRAGMA table_info(articles)')).rows.find((r) => r.name === 'embedding')?.type;
const vec = (n: number) => `[${Array.from({ length: n }, (_, i) => (i % 7) / 7).join(',')}]`;

describe('ensureEmbeddingColumn (real libSQL)', () => {
  let c: Client;
  beforeEach(async () => {
    c = createClient({ url: ':memory:' });
    await c.execute('CREATE TABLE articles (id TEXT PRIMARY KEY, title TEXT NOT NULL, embedding F32_BLOB(384))');
    await c.execute('CREATE INDEX articles_embedding_idx ON articles(libsql_vector_idx(embedding))');
    await c.execute({ sql: 'INSERT INTO articles VALUES (?, ?, vector(?))', args: ['a1', 'Old', vec(384)] });
  });

  it('reproduces the bug: a 1024-dim vector cannot be stored in the 384 column', async () => {
    await expect(c.execute({ sql: 'UPDATE articles SET embedding = vector(?) WHERE id = ?', args: [vec(1024), 'a1'] }))
      .rejects.toThrow();
  });

  it('resizes the column, keeps the rows, and makes 1024-dim search work', async () => {
    expect(await ensureEmbeddingColumn(c, 1024)).toBe('resized');
    expect(await colType(c)).toBe('F32_BLOB(1024)');

    const rows = await c.execute('SELECT id, title, embedding FROM articles');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].title).toBe('Old');
    expect(rows.rows[0].embedding).toBeNull();

    await c.execute({ sql: 'UPDATE articles SET embedding = vector(?) WHERE id = ?', args: [vec(1024), 'a1'] });
    const hits = await c.execute({
      sql: `SELECT a.id FROM vector_top_k('articles_embedding_idx', vector(?), 5) v JOIN articles a ON a.rowid = v.id`,
      args: [vec(1024)],
    });
    expect(hits.rows.map((r) => r.id)).toEqual(['a1']);
  });

  it('is a no-op when the column already has the right size', async () => {
    await ensureEmbeddingColumn(c, 1024);
    await c.execute({ sql: 'UPDATE articles SET embedding = vector(?) WHERE id = ?', args: [vec(1024), 'a1'] });
    expect(await ensureEmbeddingColumn(c, 1024)).toBe('unchanged');
    const row = await c.execute('SELECT embedding IS NOT NULL AS has FROM articles');
    expect(row.rows[0].has).toBe(1);
  });

  it('adds the column when it is missing', async () => {
    const fresh = createClient({ url: ':memory:' });
    await fresh.execute('CREATE TABLE articles (id TEXT PRIMARY KEY)');
    expect(await ensureEmbeddingColumn(fresh, 1024)).toBe('added');
    expect(await colType(fresh)).toBe('F32_BLOB(1024)');
  });
});
