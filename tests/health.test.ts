import { describe, it, expect } from 'vitest';
import { updateFeedHealth } from '../src/services/feed-health.service';
import { assessHealth } from '../src/services/health-check.service';
import { questionKeywords } from '../src/bot/keywords';

const feed = (ok: boolean) => [{ outlet: 'ET', url: 'https://et/feed', ok, items: ok ? 5 : 0, error: ok ? undefined : 'Status code 403' }];
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 9));

describe('updateFeedHealth', () => {
  it('counts a failing day once, and resets on success', () => {
    let m = updateFeedHealth({}, feed(false), day(18));
    m = updateFeedHealth(m, feed(false), day(18));
    expect(m['https://et/feed'].failDays).toBe(1);
    m = updateFeedHealth(m, feed(false), day(19));
    m = updateFeedHealth(m, feed(false), day(20));
    expect(m['https://et/feed']).toMatchObject({ failDays: 3, lastError: 'Status code 403' });
    m = updateFeedHealth(m, feed(true), day(21));
    expect(m['https://et/feed']).toMatchObject({ failDays: 0, lastOkDate: '2026-11-21' });
  });
});

describe('assessHealth', () => {
  const run = (saved: number, status = 'success', source = 'rss') => ({ source, status, saved, errors: 0, startedAt: '' });
  it('is OK when articles were saved and feeds are fine', () => {
    expect(assessHealth([run(10), run(0, 'success', 'markets')], {}).ok).toBe(true);
  });
  it('flags no runs, zero saved, failed runs and feeds failing 3+ days', () => {
    expect(assessHealth([], {}).problems[0]).toContain('No pipeline ran');
    const r = assessHealth([run(0, 'failed', 'newsdata'), run(0)], {
      a: { outlet: 'ET', failDays: 3, lastFailDate: null, lastOkDate: null, lastError: '403' },
      b: { outlet: 'Mint', failDays: 2, lastFailDate: null, lastOkDate: null, lastError: '500' },
    });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      '2 pipeline run(s) in the last 24 hours saved 0 articles.',
      'newsdata: 1 failed run(s) in the last 24 hours.',
      'Feed ET has failed 3 days in a row (403): a',
    ]);
  });
});

describe('questionKeywords', () => {
  it('keeps names and topics, drops question words', () => {
    expect(questionKeywords('What did the RBI decide about the repo rate?')).toEqual(['rbi', 'decide', 'repo', 'rate']);
    expect(questionKeywords('Who won IPL 2026?')).toEqual(['won', 'ipl', '2026']);
  });
});

import { vi } from 'vitest';
const get = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get, post: vi.fn() } }));
import { checkBrevo } from '../src/services/health-check.service';

describe('checkBrevo', () => {
  it('reports the IP allow-list block', async () => {
    process.env.BREVO_API_KEY = 'k';
    process.env.BREVO_FROM_EMAIL = 'me@example.com';
    get.mockResolvedValueOnce({ status: 401, data: { message: 'We have detected you are using an unrecognised IP address' } });
    const r = await checkBrevo();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('unrecognised IP');
  });

  it('flags an unverified sender and passes a healthy account', async () => {
    get.mockResolvedValueOnce({ status: 200, data: { email: 'me@example.com', plan: [{ type: 'free', creditsType: 'sendLimit', credits: 300 }] } })
       .mockResolvedValueOnce({ status: 200, data: { senders: [{ email: 'Me@Example.com', active: false }] } });
    expect((await checkBrevo()).detail).toContain('not verified');
    get.mockResolvedValueOnce({ status: 200, data: { email: 'me@example.com', plan: [{ type: 'free', creditsType: 'sendLimit', credits: 300 }] } })
       .mockResolvedValueOnce({ status: 200, data: { senders: [{ email: 'me@example.com', active: true }] } });
    expect(await checkBrevo()).toMatchObject({ ok: true, detail: expect.stringContaining('300 email credits') });
  });
});
