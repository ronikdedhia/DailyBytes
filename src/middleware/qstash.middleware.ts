import { Receiver } from '@upstash/qstash';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * Verifies the Upstash-Signature header on QStash-triggered routes.
 *
 * There is no localhost bypass: node-cron calls the job functions directly,
 * not over HTTP, so nothing legitimate reaches these routes unsigned.
 * If signing keys are missing, requests are rejected in production and only
 * allowed (with a warning) when NODE_ENV is not "production".
 */
export function qstashVerify(req: Request, res: Response, next: NextFunction): void {
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey    = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentKey || !nextKey) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[qstash] signing keys not configured — rejecting request');
      res.status(503).json({ error: 'QStash verification not configured' });
      return;
    }
    logger.warn('[qstash] signing keys not configured — allowing unsigned request (non-production only)');
    next();
    return;
  }

  const sig = req.headers['upstash-signature'];
  if (typeof sig !== 'string' || !sig) {
    res.status(401).json({ error: 'Missing QStash signature' });
    return;
  }

  // When the public URL is known, also check the signed URL claim so a
  // signature for one endpoint can't be replayed against another.
  const backendUrl = process.env.BACKEND_PUBLIC_URL?.replace(/\/+$/, '');
  const url = backendUrl ? `${backendUrl}${req.originalUrl}` : undefined;

  const receiver = new Receiver({ currentSigningKey: currentKey, nextSigningKey: nextKey });
  const rawBody  = (req as Request & { rawBody?: string }).rawBody ?? '';

  receiver.verify({ signature: sig, body: rawBody, url })
    .then((valid) => {
      if (!valid) throw new Error('invalid signature');
      next();
    })
    .catch(() => {
      logger.warn('[qstash] signature verification failed');
      res.status(401).json({ error: 'Invalid QStash signature' });
    });
}
