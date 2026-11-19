import { Router, Request, Response } from 'express';
import { qstashVerify } from '../middleware/qstash.middleware';
import { logger } from '../utils/logger';
import { runDailyJob } from '../cron/daily-jobs';

const router = Router();

/**
 * Acknowledge QStash right away and run the job in the background.
 * Waiting for a multi-minute pipeline (plus a Render cold start) risks a
 * QStash timeout, which triggers retries and duplicate runs.
 */
function startInBackground(name: string) {
  return (_req: Request, res: Response) => {
    res.status(202).json({ status: 'accepted', job: name });
    runDailyJob(name).catch((error: any) => logger.error(`❌ [qstash] ${name} failed: ${error.message}`));
  };
}

router.post('/qstash/news-data', qstashVerify, startInBackground('news-data'));
router.post('/qstash/markets', qstashVerify, startInBackground('markets'));
// Older schedules registered this path; it now runs the free market feeds.
router.post('/qstash/alpha-vantage', qstashVerify, startInBackground('markets'));
router.post('/qstash/cleanup', qstashVerify, startInBackground('cleanup'));
// Older schedules registered these two paths; both now run the single cleanup job.
router.post('/qstash/cleanup-newsdata', qstashVerify, startInBackground('cleanup'));
router.post('/qstash/cleanup-alphavantage', qstashVerify, startInBackground('cleanup'));
router.post('/qstash/newsletter', qstashVerify, startInBackground('newsletter'));

export default router;
