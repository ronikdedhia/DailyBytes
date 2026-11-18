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
    newsletter: job('newsletter'), 'alpha-vantage': job('alpha-vantage'),
    'news-data': job('news-data'), cleanup: job('cleanup'),
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

describe('catchUpMissedJobs', () => {
  beforeEach(() => { store.clear(); calls.length = 0; });

  it('after waking at 09:00 UTC, runs the three jobs that were due, in schedule order', async () => {
    const ran = await catchUpMissedJobs(at('2026-11-18T09:00:00Z'));
    expect(calls).toEqual(['newsletter', 'alpha-vantage', 'news-data']);
    expect(ran).toEqual(calls);
  });

  it('runs nothing before the first job is due', async () => {
    await catchUpMissedJobs(at('2026-11-18T05:00:00Z'));
    expect(calls).toEqual([]);
  });

  it('skips jobs that already ran today', async () => {
    store.set(dailyStateKey('newsletter'), '2026-11-18');
    store.set(dailyStateKey('alpha-vantage'), '2026-11-18');
    await catchUpMissedJobs(at('2026-11-18T13:00:00Z'));
    expect(calls).toEqual(['news-data', 'cleanup']);
    calls.length = 0;
    await catchUpMissedJobs(at('2026-11-18T13:15:00Z'));
    expect(calls).toEqual([]);
  });

  it("ignores yesterday's run", async () => {
    store.set(dailyStateKey('news-data'), '2026-11-17');
    await catchUpMissedJobs(at('2026-11-18T08:45:00Z'));
    expect(calls).toContain('news-data');
  });
});
