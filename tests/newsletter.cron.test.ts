import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('../src/services/job-state.service', () => ({
  jobStateService: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  },
}));
vi.mock('../src/services/newsletter.service', () => ({
  newsletterService: { sendNewsletterToAll: vi.fn(async () => ({ sent: 3, failed: 0 })) },
}));

import {
  executeScheduledNewsletterJob, getNewsletterCronExpression, NEWSLETTER_STATE_KEY,
} from '../src/cron/newsletter.cron';
import { newsletterService } from '../src/services/newsletter.service';

const send = vi.mocked(newsletterService.sendNewsletterToAll);

describe('getNewsletterCronExpression', () => {
  it('converts HH:MM to a daily cron', () => {
    expect(getNewsletterCronExpression('06:30')).toBe('30 6 * * *');
  });
  it('falls back on bad input', () => {
    expect(getNewsletterCronExpression('nope')).toBe('0 8 * * *');
  });
});

describe('executeScheduledNewsletterJob', () => {
  beforeEach(() => { store.clear(); send.mockClear(); });

  it('sends once per UTC day across both schedulers', async () => {
    const now = new Date('2026-11-17T06:30:00Z');
    await executeScheduledNewsletterJob(now);
    await executeScheduledNewsletterJob(new Date('2026-11-17T06:31:00Z'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.get(NEWSLETTER_STATE_KEY)).toBe('2026-11-17');
  });

  it('does not double-send when triggers overlap', async () => {
    const now = new Date('2026-11-17T06:30:00Z');
    await Promise.all([executeScheduledNewsletterJob(now), executeScheduledNewsletterJob(now)]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends again the next day', async () => {
    store.set(NEWSLETTER_STATE_KEY, '2026-11-16');
    await executeScheduledNewsletterJob(new Date('2026-11-17T06:30:00Z'));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
