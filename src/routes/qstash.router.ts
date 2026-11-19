import { Router, Request, Response } from 'express';
import { qstashVerify } from '../middleware/qstash.middleware';
import { logger } from '../utils/logger';
import { catchUpMissedJobs } from '../cron/daily-jobs';

const router = Router();

/**
 * QStash trigger for the daily slot. Acknowledges at once (QStash retries slow
 * endpoints) and runs the jobs in the background.
 */
router.post('/qstash/daily', qstashVerify, (_req: Request, res: Response) => {
  res.status(202).json({ status: 'accepted', job: 'daily' });
  catchUpMissedJobs().catch((error: any) => logger.error(`❌ [qstash] daily run failed: ${error.message}`));
});

export default router;
