import { executeNewsDataJob, executeAlphaVantageJob, executeCleanupJob, executeRssJob, JobOutcome } from './news-pipeline.cron';
import { botEnabled, botService } from '../bot';
import { executeScheduledNewsletterJob } from './newsletter.cron';

/**
 * Scheduled jobs that external schedulers (QStash, GitHub Actions) can trigger.
 * All of them are safe to call more than once: pipelines dedupe by URL, cleanup
 * and the newsletter check their last run in the database, and each job holds
 * an in-process lock while running.
 */
export const SCHEDULED_JOBS: Record<string, () => Promise<JobOutcome>> = {
  'news-data': () => executeNewsDataJob(),
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
  cleanup: () => executeCleanupJob(),
  newsletter: () => executeScheduledNewsletterJob(),
};
