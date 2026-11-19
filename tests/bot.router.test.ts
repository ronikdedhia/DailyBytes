import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { routeMessage, forwardSecret, setDetectedForwardUrl } from '../src/bot/router';

const saved = { ...process.env };
beforeEach(() => {
  process.env.TELEGRAM_ACCESS_TOKEN = '123:shared';
  process.env.TELEGRAM_BOT_TOKEN = '999:other';
  process.env.TELEGRAM_CHAT_ID = '855';
  setDetectedForwardUrl('https://earningslens.example/api/telegram/webhook');
});
afterEach(() => { process.env = { ...saved }; setDetectedForwardUrl(null); });

describe('routeMessage', () => {
  it('keeps Daily Bytes commands and plain text here', () => {
    expect(routeMessage('855', '/brief cricket')).toEqual({ to: 'dailybytes' });
    expect(routeMessage('999', '/ask what did RBI decide?')).toEqual({ to: 'dailybytes' });
    expect(routeMessage('855', 'hello')).toEqual({ to: 'dailybytes' });
  });

  it('forwards EarningsLens commands from the owner, renaming clashing ones back', () => {
    expect(routeMessage('855', '/results IONEXCHANG')).toEqual({ to: 'forward', text: '/results IONEXCHANG' });
    expect(routeMessage('855', '/ebrief MOREPENLAB')).toEqual({ to: 'forward', text: '/brief MOREPENLAB' });
    expect(routeMessage('855', '/eask@NewsDailyRonikBot order book?')).toEqual({ to: 'forward', text: '/ask order book?' });
  });

  it('never forwards for other users, or without a forward target', () => {
    expect(routeMessage('999', '/results IONEXCHANG')).toEqual({ to: 'owner-only' });
    setDetectedForwardUrl(null);
    expect(routeMessage('855', '/results IONEXCHANG')).toEqual({ to: 'owner-only' });
  });
});

describe('forwardSecret', () => {
  it("matches the secret EarningsLens derives from the shared token", () => {
    expect(forwardSecret()).toBe(createHmac('sha256', '123:shared').update('earningslens-webhook').digest('hex').slice(0, 48));
  });
});
