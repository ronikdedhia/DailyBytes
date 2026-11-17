import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.mock('../src/cron/jobs', () => ({
  SCHEDULED_JOBS: {
    'news-data': vi.fn(async () => ({ status: 'completed', result: { saved: 3 } })),
    newsletter: vi.fn(async () => ({ status: 'failed', error: 'brevo down' })),
  },
}));
vi.mock('../src/cron/news-pipeline.cron', () => ({ triggerNewsPipelineManually: vi.fn() }));
vi.mock('../src/cron/newsletter.cron', () => ({ triggerNewsletterManually: vi.fn() }));
vi.mock('../src/lib/redis', () => ({ deleteCached: vi.fn() }));

import pipelineRouter from '../src/routes/pipeline.router';
import { SCHEDULED_JOBS } from '../src/cron/jobs';

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', pipelineRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => { process.env.PIPELINE_SECRET = 'correct-secret'; vi.mocked(SCHEDULED_JOBS['news-data']).mockClear(); });

const post = (path: string, secret?: string) =>
  fetch(base + path, { method: 'POST', headers: secret ? { 'x-pipeline-secret': secret } : {} });

describe('POST /api/cron/:job', () => {
  it('runs the job with the right secret and returns its outcome', async () => {
    const res = await post('/api/cron/news-data', 'correct-secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, job: 'news-data', status: 'completed', result: { saved: 3 } });
    expect(SCHEDULED_JOBS['news-data']).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing or wrong secret without running anything', async () => {
    expect((await post('/api/cron/news-data')).status).toBe(401);
    expect((await post('/api/cron/news-data', 'correct-secreT')).status).toBe(401);
    expect((await post('/api/cron/news-data', 'short')).status).toBe(401);
    expect(SCHEDULED_JOBS['news-data']).not.toHaveBeenCalled();
  });

  it('rejects everything when PIPELINE_SECRET is unset', async () => {
    delete process.env.PIPELINE_SECRET;
    expect((await post('/api/cron/news-data', '')).status).toBe(401);
  });

  it('404s on unknown or prototype job names', async () => {
    expect((await post('/api/cron/nope', 'correct-secret')).status).toBe(404);
    expect((await post('/api/cron/constructor', 'correct-secret')).status).toBe(404);
  });

  it('returns 500 when the job fails, so the scheduler run is marked failed', async () => {
    const res = await post('/api/cron/newsletter', 'correct-secret');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, error: 'brevo down' });
  });
});
