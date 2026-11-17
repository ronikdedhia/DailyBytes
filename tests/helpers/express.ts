import { vi } from 'vitest';

export function mockReq(overrides: Record<string, any> = {}): any {
  return { headers: {}, ip: '203.0.113.10', originalUrl: '/', ...overrides };
}

export function mockRes(): any {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

/** Resolves once the middleware either calls next() or sends a response. */
export function runMiddleware(mw: (req: any, res: any, next: any) => unknown, req: any) {
  return new Promise<{ nextCalled: boolean; status?: number; body?: any }>((resolve) => {
    const res = mockRes();
    res.json = vi.fn((body: any) => {
      resolve({ nextCalled: false, status: res.status.mock.calls.at(-1)?.[0], body });
      return res;
    });
    mw(req, res, () => resolve({ nextCalled: true }));
  });
}
