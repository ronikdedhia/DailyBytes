import { createHash, createHmac, createSign, generateKeyPairSync, KeyObject } from 'crypto';

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

export function generateRsaKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

// Header `cat` Clerk puts on session tokens (as opposed to JWT templates / M2M tokens).
const CLERK_SESSION_TOKEN_CATEGORY = 'cl_B7d4PD111AAA';

/** Sign a Clerk-style RS256 session token. */
export function signRs256(payload: Record<string, unknown>, privateKey: KeyObject, kid = 'ins_test'): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid, cat: CLERK_SESSION_TOKEN_CATEGORY }));
  const body = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${b64url(signer.sign(privateKey))}`;
}

/** An unsigned token in the shape the old middleware accepted. */
export function unsignedToken(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.`;
}

/** Sign an Upstash-Signature header the way QStash does (HS256 JWT). */
export function signQStash(signingKey: string, url: string, body: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: 'Upstash',
    sub: url,
    exp: nowSec + 300,
    nbf: nowSec - 5,
    iat: nowSec,
    jti: `jwt_${nowSec}`,
    body: createHash('sha256').update(body).digest('base64url'),
  }));
  const sig = createHmac('sha256', signingKey).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}
