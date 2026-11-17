import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

/** True if the request carries PIPELINE_SECRET (header or body). Constant-time compare. */
export function hasPipelineSecret(req: Request): boolean {
  const expected = process.env.PIPELINE_SECRET;
  if (!expected) return false;
  const provided = req.headers['x-pipeline-secret'] ?? req.body?.secret;
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
