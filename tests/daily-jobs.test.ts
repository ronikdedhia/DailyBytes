import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('../src/services/job-state.service', () => ({
  jobStateService: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  },
}));
const calls: string[] = [];
const outcomes: Record<string, any> = {};
vi.mock('../src/cron/jobs', () => {
  const job = (name: string) => vi.fn(async () => { calls.push(name); return outcomes[name] ?? { status: 'completed' }; });
  return { SCHEDULED_JOBS: {
    newsletter: job('newsletter'), markets: job('markets'), 'news-data': job('news-data'),
    rss: job('rss'), 'telegram-digest': job('telegram-digest'), 'telegram-weekly': job('telegram-weekly'),
    'embed-backfill': job('embed-backfill'), cleanup: job('cleanup'), 'health-check': job('health-check'),
  } };
});
vi.mock('../src/cron/newsletter.cron', () => ({ getNewsletterCronExpression: () => '30 6 * * *' }));

import { runDailyJob, catchUpMissedJobs, dailyStateKey } from '../src/cron/daily-jobs';

const at = (iso: string) => new Date(iso);

describe('runDailyJob', () => {
  beforeEach(() => { store.clear(); calls.length = 0; for (const k of Object.keys(outcomes)) delete outcomes[k]; });

  it('runs once per UTC day', async () => {
    await runDailyJob('news-data', at('2026-11-18T08:30:00Z'));
    expect(await runDailyJob('news-data', at('2026-11-18T20:00:00Z'))).toEqual({ status: 'skipped' });
    await runDailyJob('news-data', at('2026-11-19T08:30:00Z'));
    expect(calls).toEqual(['news-data', 'news-data']);
  });

  it('does not mark a failed run, so the next trigger retries', async () => {
    outcomes['news-data'] = { status: 'failed', error: 'api down' };
    await runDailyJob('news-data', at('2026-11-18T08:30:00Z'));
    expect(store.has(dailyStateKey('news-data'))).toBe(false);
    delete outcomes['news-data'];
    await runDailyJob('news-data', at('2026-11-18T09:00:00Z'));
    expect(calls).toEqual(['news-data', 'news-data']);
    expect(store.get(dailyStateKey('news-data'))).toBe('2026-11-18');
  });
});

describe('catchUpMissedJobs (one daily slot)', () => {
  beforeEach(() => { store.clear(); calls.length = 0; delete process.env.DAILY_RUN_TIME; });
  const ALL = ['markets', 'news-data', 'rss', 'embed-backfill', 'newsletter', 'telegram-digest', 'telegram-weekly', 'cleanup', 'health-check'];

  it('runs nothing before the slot (a visitor waking the server early does no work)', async () => {
    expect(await catchUpMissedJobs(at('2026-11-18T08:29:00Z'))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('runs every job once, in order, on the first wake-up after the slot', async () => {
    const ran = await catchUpMissedJobs(at('2026-11-18T08:31:00Z'));
    expect(calls).toEqual(ALL);
    expect(ran.map((r) => r.job)).toEqual(ALL);
    calls.length = 0;
    await catchUpMissedJobs(at('2026-11-18T09:15:00Z'));
    expect(calls).toEqual([]);
  });

  it('retries only the jobs that failed', async () => {
    outcomes['rss'] = { status: 'failed', error: 'x' };
    await catchUpMissedJobs(at('2026-11-18T08:31:00Z'));
    delete outcomes['rss'];
    calls.length = 0;
    await catchUpMissedJobs(at('2026-11-18T08:46:00Z'));
    expect(calls).toEqual(['rss']);
  });

  it('does not overlap two triggers', async () => {
    await Promise.all([catchUpMissedJobs(at('2026-11-18T08:31:00Z')), catchUpMissedJobs(at('2026-11-18T08:31:00Z'))]);
    expect(calls).toEqual(ALL);
  });

  it('honours DAILY_RUN_TIME', async () => {
    process.env.DAILY_RUN_TIME = '13:00';
    expect(await catchUpMissedJobs(at('2026-11-18T12:00:00Z'))).toEqual([]);
  });
});
