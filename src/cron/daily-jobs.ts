import cron from 'node-cron';
import { logger } from '../utils/logger';
import { jobStateService } from '../services/job-state.service';
import { runExclusive } from '../lib/job-lock';
import { SCHEDULED_JOBS } from './jobs';
import type { JobOutcome } from './news-pipeline.cron';
import { getNewsletterCronExpression } from './newsletter.cron';

/**
 * Render's free tier sleeps when idle, so everything runs in ONE daily slot:
 * a single wake-up (GitHub Actions, with Vercel Cron as backup) runs every job
 * in this order, then the server goes back to sleep. Order matters: content
 * first, then what's built from it.
 */
export const DAILY_JOBS = [
  'markets',          // market news feeds
  'news-data',        // NewsData.io
  'rss',              // outlet RSS feeds
  'embed-backfill',   // vectors for anything not embedded yet
  'newsletter',       // email digest, now with today's articles
  'telegram-digest',  // personal bot digests
  'telegram-weekly',  // Sundays only
  'cleanup',          // every 15 days
  'health-check',     // last: sees every run of the day
] as const;

/** UTC time of the daily slot. Default 08:30 UTC = 2:00 PM IST. */
export function dailyRunTime(): string {
  const t = (process.env.DAILY_RUN_TIME || '08:30').trim();
  return /^\d{1,2}:\d{2}$/.test(t) ? t : '08:30';
}

/** Kept for callers that list the schedule: every job is due at the daily slot. */
export function dailySchedule(): Array<{ job: string; utc: string }> {
  return DAILY_JOBS.map((job) => ({ job, utc: dailyRunTime() }));
}

export const dailyStateKey = (job: string) => `daily:${job}:last_run_date`;
const utcDate = (d: Date) => d.toISOString().slice(0, 10);

function slotStart(now: Date): Date {
  const [h, m] = dailyRunTime().split(':').map(Number);
  const at = new Date(now);
  at.setUTCHours(h, m, 0, 0);
  return at;
}

/**
 * Run a scheduled job at most once per UTC day. A run only counts once it
 * completes, so a failed run is retried by the next trigger the same day.
 */
export async function runDailyJob(job: string, now: Date = new Date()): Promise<JobOutcome> {
  const run = SCHEDULED_JOBS[job];
  if (!run) throw new Error(`Unknown job: ${job}`);
  const today = utcDate(now);
  if ((await jobStateService.get(dailyStateKey(job))) === today) {
    logger.info(`⏭ ${job} already ran today (${today})`);
    return { status: 'skipped' };
  }
  const outcome = await run();
  if (outcome.status === 'completed') {
    await jobStateService.set(dailyStateKey(job), today);
  }
  return outcome;
}

export interface DailyRunResult {
  job: string;
  outcome: JobOutcome;
}

/**
 * If today's slot has started, run every job that hasn't completed today, in
 * DAILY_JOBS order. Runs on boot (a wake-up after the slot), from node-cron at
 * the slot, from POST /api/cron/daily, and every 15 minutes while awake. Only
 * one run at a time; jobs that already ran are skipped cheaply.
 */
export async function catchUpMissedJobs(now: Date = new Date()): Promise<DailyRunResult[]> {
  const results: DailyRunResult[] = [];
  if (now < slotStart(now)) return results;
  await runExclusive('daily-run', async () => {
    for (const job of DAILY_JOBS) {
      try {
        if ((await jobStateService.get(dailyStateKey(job))) === utcDate(now)) continue;
        logger.info(`⏰ Daily run: ${job}`);
        results.push({ job, outcome: await runDailyJob(job, now) });
      } catch (error: any) {
        logger.error(`❌ Daily run: ${job} failed: ${error.message}`);
        results.push({ job, outcome: { status: 'failed', error: error.message } });
      }
    }
  });
  return results;
}

/** Catch up now and every 15 minutes. The timer does not keep Render awake; only HTTP traffic does. */
export function startCatchUpLoop(intervalMs = 15 * 60 * 1000): NodeJS.Timeout {
  const tick = () => void catchUpMissedJobs().catch((err) => logger.error(`❌ catch-up failed: ${err.message}`));
  tick();
  return setInterval(tick, intervalMs);
}

/** In-process trigger at the slot (only fires if the server happens to be awake). */
export function initializeDailyCron() {
  const time = dailyRunTime();
  cron.schedule(getNewsletterCronExpression(time), () => {
    logger.info(`⏰ Cron triggered: daily run (${time} UTC)`);
    void catchUpMissedJobs().catch((err) => logger.error(`❌ daily run failed: ${err.message}`));
  }, { timezone: 'Etc/UTC' });
  logger.info(`📅 Daily run at ${time} UTC: ${DAILY_JOBS.join(' → ')}`);
}
