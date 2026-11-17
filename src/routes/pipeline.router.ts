import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler';
import { logger } from '../utils/logger';
import { triggerNewsPipelineManually } from '../cron/news-pipeline.cron';
import { triggerNewsletterManually } from '../cron/newsletter.cron';
import { deleteCached } from '../lib/redis';
import { hasPipelineSecret } from '../lib/pipeline-secret';
import { SCHEDULED_JOBS } from '../cron/jobs';

const router = Router();

router.post('/trigger-pipeline', asyncHandler(async (req, res) => {
  if (!hasPipelineSecret(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  logger.info('📡 API: Manual pipeline trigger');
  await triggerNewsPipelineManually();
  await deleteCached(
    'cache:articles:free',
    'cache:trending',
    'cache:hashtags',
    'cache:trending:articles:10:0',
    'cache:metrics',
  );
  return res.json({ success: true, message: 'Pipeline triggered successfully' });
}));

router.post('/trigger-newsletter', asyncHandler(async (req, res) => {
  if (!hasPipelineSecret(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  logger.info('📡 API: Manual newsletter trigger');
  await triggerNewsletterManually();
  return res.json({ success: true, message: 'Newsletter triggered successfully' });
}));

/**
 * Run a scheduled job and wait for it to finish. Used by the GitHub Actions
 * scheduler (.github/workflows/scheduled-jobs.yml): the open request keeps a
 * sleeping Render instance awake until the job is done.
 * Unlike /trigger-newsletter, the newsletter job here sends at most once a day.
 */
router.post('/cron/:job', asyncHandler(async (req, res) => {
  if (!hasPipelineSecret(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  const name = String(req.params.job);
  const job = Object.prototype.hasOwnProperty.call(SCHEDULED_JOBS, name) ? SCHEDULED_JOBS[name] : undefined;
  if (!job) {
    return res.status(404).json({ success: false, error: `Unknown job. Use one of: ${Object.keys(SCHEDULED_JOBS).join(', ')}` });
  }
  logger.info(`📡 API: scheduled job trigger → ${name}`);
  const outcome = await job();
  return res.status(outcome.status === 'failed' ? 500 : 200).json({ success: outcome.status !== 'failed', job: name, ...outcome });
}));

export default router;
