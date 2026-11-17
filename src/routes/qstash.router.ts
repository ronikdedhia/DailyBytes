import { Router, Request, Response } from 'express';
import { qstashVerify } from '../middleware/qstash.middleware';
import { logger } from '../utils/logger';
import { SCHEDULED_JOBS } from '../cron/jobs';

const router = Router();

/**
 * Acknowledge QStash right away and run the job in the background.
 * Waiting for a multi-minute pipeline (plus a Render cold start) risks a
 * QStash timeout, which triggers retries and duplicate runs.
 */
function startInBackground(name: string) {
  const job = SCHEDULED_JOBS[name];
  return (_req: Request, res: Response) => {
    res.status(202).json({ status: 'accepted', job: name });
    job().catch((error: any) => logger.error(`❌ [qstash] ${name} failed: ${error.message}`));
  };
}

router.post('/qstash/news-data', qstashVerify, startInBackground('news-data'));
router.post('/qstash/alpha-vantage', qstashVerify, startInBackground('alpha-vantage'));
router.post('/qstash/cleanup', qstashVerify, startInBackground('cleanup'));
// Older schedules registered these two paths; both now run the single cleanup job.
router.post('/qstash/cleanup-newsdata', qstashVerify, startInBackground('cleanup'));
router.post('/qstash/cleanup-alphavantage', qstashVerify, startInBackground('cleanup'));
router.post('/qstash/newsletter', qstashVerify, startInBackground('newsletter'));

export default router;
