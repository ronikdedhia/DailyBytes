import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler';
import { logger } from '../utils/logger';
import { triggerNewsPipelineManually } from '../cron/news-pipeline.cron';
import { triggerNewsletterManually } from '../cron/newsletter.cron';
import { deleteCached } from '../lib/redis';
import { hasPipelineSecret } from '../lib/pipeline-secret';
import { SCHEDULED_JOBS } from '../cron/jobs';
import { runDailyJob, catchUpMissedJobs, dailyRunTime, DAILY_JOBS } from '../cron/daily-jobs';
import { checkBrevo, checkGroq } from '../services/health-check.service';
import { activeEmbeddingProvider, EMBEDDING_MODEL } from '../services/embedding.service';
import { callBot, botEnabled } from '../bot/telegram-api';
import { forwardUrl } from '../bot/router';

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
 * Read-only diagnostics: live commit, Brevo and Groq checks from this server,
 * bot webhook, embedding provider, schedule. Sends nothing.
 */
router.post('/diagnostics', asyncHandler(async (req, res) => {
  if (!hasPipelineSecret(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  const settle = <T>(p: Promise<T>) => p.catch((err: any) => ({ ok: false, detail: String(err.message ?? err) }));
  const [brevo, groq, webhook] = await Promise.all([
    settle(checkBrevo()),
    settle(checkGroq()),
    botEnabled() ? settle(callBot<{ url?: string; pending_update_count?: number; last_error_message?: string }>('getWebhookInfo')) : Promise.resolve(null),
  ]);
  return res.json({
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
    brevo,
    groq,
    telegram: { webhook, forwardsTo: forwardUrl() },
    embeddings: { provider: activeEmbeddingProvider(), model: EMBEDDING_MODEL },
    schedule: { utc: dailyRunTime(), jobs: DAILY_JOBS },
  });
}));

/**
 * Run today's daily slot (every job not yet done, in order) and wait. This is
 * what the GitHub Actions scheduler calls once a day.
 */
router.post('/cron/daily', asyncHandler(async (req, res) => {
  if (!hasPipelineSecret(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  logger.info('📡 API: daily run trigger');
  const results = await catchUpMissedJobs();
  const failed = results.filter((r) => r.outcome.status === 'failed');
  return res.status(failed.length ? 500 : 200).json({ success: failed.length === 0, ran: results });
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
  if (!Object.prototype.hasOwnProperty.call(SCHEDULED_JOBS, name)) {
    return res.status(404).json({ success: false, error: `Unknown job. Use one of: ${Object.keys(SCHEDULED_JOBS).join(', ')}` });
  }
  logger.info(`📡 API: scheduled job trigger → ${name}`);
  // Once per UTC day, like the other schedulers; ?force=1 runs it again anyway.
  const outcome = req.query.force === '1' ? await SCHEDULED_JOBS[name]() : await runDailyJob(name);
  return res.status(outcome.status === 'failed' ? 500 : 200).json({ success: outcome.status !== 'failed', job: name, ...outcome });
}));

export default router;
