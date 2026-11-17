import { describe, it, expect } from 'vitest';
import { runExclusive, isRunning } from '../src/lib/job-lock';

describe('runExclusive', () => {
  it('skips a second concurrent run with the same name', async () => {
    let release!: () => void;
    const first = runExclusive('job', () => new Promise<void>((r) => { release = r; }));
    expect(isRunning('job')).toBe(true);
    expect(await runExclusive('job', async () => {})).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(isRunning('job')).toBe(false);
  });

  it('releases the lock when the job throws', async () => {
    await expect(runExclusive('boom', async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(isRunning('boom')).toBe(false);
  });
});
