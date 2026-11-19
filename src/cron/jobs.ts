import { executeNewsDataJob, executeAlphaVantageJob, executeCleanupJob, executeRssJob, executeMarketsJob, JobOutcome } from './news-pipeline.cron';
import { botEnabled, botService } from '../bot';
import { rawClient } from '../db/client';
import { backfillEmbeddings } from '../services/embedding-sync.service';
import { healthCheckService } from '../services/health-check.service';

const wrap = async (run: () => Promise<unknown>): Promise<JobOutcome> => {
  try {
    return { status: 'completed', result: await run() };
  } catch (error: any) {
    return { status: 'failed', error: error.message };
  }
};
import { executeScheduledNewsletterJob } from './newsletter.cron';

/**
 * Scheduled jobs that external schedulers (QStash, GitHub Actions) can trigger.
 * All of them are safe to call more than once: pipelines dedupe by URL, cleanup
 * and the newsletter check their last run in the database, and each job holds
 * an in-process lock while running.
 */
export const SCHEDULED_JOBS: Record<string, () => Promise<JobOutcome>> = {
  'news-data': () => executeNewsDataJob(),
  markets: () => executeMarketsJob(),
  // Not scheduled: NEWS_SENTIMENT needs a premium Alpha Vantage key. Run by hand if you have one.
  'alpha-vantage': () => executeAlphaVantageJob(),
  rss: () => executeRssJob(),
  'telegram-digest': async () => {
    if (!botEnabled()) return { status: 'completed', result: { skipped: 'TELEGRAM_BOT_TOKEN not set' } };
    try {
      return { status: 'completed', result: await botService.sendDailyDigests() };
    } catch (error: any) {
      return { status: 'failed', error: error.message };
    }
  },
  // Scheduled daily; only sends on Sundays (UTC), so the daily mark doesn't block it.
  'telegram-weekly': () => wrap(async () => {
    if (new Date().getUTCDay() !== 0) return { skipped: 'not Sunday' };
    if (!botEnabled()) return { skipped: 'TELEGRAM_BOT_TOKEN not set' };
    return botService.sendWeeklyWraps();
  }),
  'embed-backfill': () => wrap(() => backfillEmbeddings(rawClient, 300)),
  'health-check': () => wrap(() => healthCheckService.run()),
  cleanup: () => executeCleanupJob(),
  newsletter: () => executeScheduledNewsletterJob(),
};
