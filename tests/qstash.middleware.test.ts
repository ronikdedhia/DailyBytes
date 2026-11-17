import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { qstashVerify } from '../src/middleware/qstash.middleware';
import { signQStash } from './helpers/jwt';
import { mockReq, runMiddleware } from './helpers/express';

const CURRENT = 'sig_current_test_key';
const NEXT = 'sig_next_test_key';
const BASE = 'https://backend.example.com';
const PATH = '/api/qstash/news-data';

const signedReq = (sig: string, overrides: Record<string, any> = {}) =>
  mockReq({ headers: { 'upstash-signature': sig }, originalUrl: PATH, rawBody: '', ...overrides });

describe('qstashVerify', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = CURRENT;
    process.env.QSTASH_NEXT_SIGNING_KEY = NEXT;
    process.env.BACKEND_PUBLIC_URL = BASE;
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('accepts a valid signature for this URL', async () => {
    expect((await runMiddleware(qstashVerify, signedReq(signQStash(CURRENT, BASE + PATH, '')))).nextCalled).toBe(true);
  });

  it('accepts a signature made with the next (rotated) key', async () => {
    expect((await runMiddleware(qstashVerify, signedReq(signQStash(NEXT, BASE + PATH, '')))).nextCalled).toBe(true);
  });

  it('no longer trusts localhost without a signature', async () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const out = await runMiddleware(qstashVerify, mockReq({ ip, originalUrl: PATH }));
      expect(out.status).toBe(401);
    }
  });

  it('rejects a bad signature', async () => {
    expect((await runMiddleware(qstashVerify, signedReq(signQStash('wrong-key', BASE + PATH, '')))).status).toBe(401);
  });

  it('rejects a signature replayed against a different endpoint', async () => {
    const sig = signQStash(CURRENT, `${BASE}/api/qstash/newsletter`, '');
    expect((await runMiddleware(qstashVerify, signedReq(sig))).status).toBe(401);
  });

  it('rejects a body that does not match the signed hash', async () => {
    const sig = signQStash(CURRENT, BASE + PATH, '');
    expect((await runMiddleware(qstashVerify, signedReq(sig, { rawBody: '{"x":1}' }))).status).toBe(401);
  });

  it('fails closed in production when signing keys are missing', async () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    const out = await runMiddleware(qstashVerify, mockReq({ originalUrl: PATH }));
    expect(out.nextCalled).toBe(false);
    expect(out.status).toBe(503);
  });

  it('allows unsigned requests outside production when keys are missing', async () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    delete process.env.QSTASH_NEXT_SIGNING_KEY;
    process.env.NODE_ENV = 'development';
    expect((await runMiddleware(qstashVerify, mockReq({ originalUrl: PATH }))).nextCalled).toBe(true);
  });
});
