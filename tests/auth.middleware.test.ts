import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { verifyClerkToken, optionalAuth } from '../src/middleware/auth.middleware';
import { generateRsaKeyPair, signRs256, unsignedToken } from './helpers/jwt';
import { mockReq, runMiddleware } from './helpers/express';

const trusted = generateRsaKeyPair();
const attacker = generateRsaKeyPair();
const now = () => Math.floor(Date.now() / 1000);
const claims = (extra: Record<string, unknown> = {}) => ({
  sub: 'user_victim', iat: now() - 10, nbf: now() - 10, exp: now() + 300,
  azp: 'https://app.example.com', ...extra,
});
const bearer = (t: string) => mockReq({ headers: { authorization: `Bearer ${t}` } });

describe('verifyClerkToken', () => {
  const saved = { ...process.env };
  beforeAll(() => { delete process.env.CLERK_SECRET_KEY; });
  beforeEach(() => {
    process.env.CLERK_JWT_KEY = trusted.publicPem;
    process.env.ALLOWED_ORIGIN = 'https://app.example.com';
  });
  afterEach(() => { process.env = { ...saved }; delete process.env.CLERK_SECRET_KEY; });

  it('accepts a correctly signed token and sets req.user', async () => {
    const req = bearer(signRs256(claims({ email: 'a@example.com', given_name: 'Ada' }), trusted.privateKey));
    const out = await runMiddleware(verifyClerkToken, req);
    expect(out.nextCalled).toBe(true);
    expect(req.user).toEqual({ id: 'user_victim', email: 'a@example.com', firstName: 'Ada', lastName: undefined });
  });

  it('rejects a forged, unsigned token (the old vulnerability)', async () => {
    const req = bearer(unsignedToken(claims()));
    const out = await runMiddleware(verifyClerkToken, req);
    expect(out.nextCalled).toBe(false);
    expect(out.status).toBe(401);
    expect(req.user).toBeUndefined();
  });

  it('rejects a token signed by a different key', async () => {
    const out = await runMiddleware(verifyClerkToken, bearer(signRs256(claims(), attacker.privateKey)));
    expect(out.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const t = signRs256(claims({ iat: now() - 600, nbf: now() - 600, exp: now() - 300 }), trusted.privateKey);
    expect((await runMiddleware(verifyClerkToken, bearer(t))).status).toBe(401);
  });

  it('rejects a token issued for another origin', async () => {
    const t = signRs256(claims({ azp: 'https://evil.example.com' }), trusted.privateKey);
    expect((await runMiddleware(verifyClerkToken, bearer(t))).status).toBe(401);
  });

  it('rejects a payload whose sub was swapped after signing', async () => {
    const [h, , s] = signRs256(claims({ sub: 'user_attacker' }), trusted.privateKey).split('.');
    const tampered = `${h}.${Buffer.from(JSON.stringify(claims())).toString('base64url')}.${s}`;
    expect((await runMiddleware(verifyClerkToken, bearer(tampered))).status).toBe(401);
  });

  it('rejects requests without a bearer token', async () => {
    expect((await runMiddleware(verifyClerkToken, mockReq())).status).toBe(401);
    expect((await runMiddleware(verifyClerkToken, mockReq({ headers: { authorization: 'Basic abc' } }))).status).toBe(401);
  });

  it('rejects everything when no verification key is configured', async () => {
    delete process.env.CLERK_JWT_KEY;
    const out = await runMiddleware(verifyClerkToken, bearer(signRs256(claims(), trusted.privateKey)));
    expect(out.status).toBe(401);
  });
});

describe('optionalAuth', () => {
  beforeEach(() => {
    process.env.CLERK_JWT_KEY = trusted.publicPem;
    process.env.ALLOWED_ORIGIN = 'https://app.example.com';
  });

  it('continues anonymously with no token', async () => {
    const req = mockReq();
    expect((await runMiddleware(optionalAuth, req)).nextCalled).toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('sets req.user for a valid token', async () => {
    const req = bearer(signRs256(claims(), trusted.privateKey));
    await runMiddleware(optionalAuth, req);
    expect(req.user?.id).toBe('user_victim');
  });

  it('treats a forged token as anonymous instead of trusting it', async () => {
    const req = bearer(unsignedToken(claims()));
    expect((await runMiddleware(optionalAuth, req)).nextCalled).toBe(true);
    expect(req.user).toBeUndefined();
  });
});
