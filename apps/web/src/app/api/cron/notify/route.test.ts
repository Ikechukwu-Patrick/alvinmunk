// @vitest-environment node
//
// Route module imports next/server, which needs Node's fetch primitives
// (Response/Headers) — run in the node environment, not jsdom.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────
// Every collaborator of the route is mocked, so the test drives the handler
// through auth, dedup, subscription lookup, and push delivery without any RPC
// or real network calls.
const {
  fetchTipEventsSinceMock,
  getSubscriptionsForWalletMock,
  removeSubscriptionMock,
  getCursorMock,
  setCursorMock,
  isEventSeenMock,
  markEventSeenMock,
  reverseHandlesMock,
  sendNotificationMock,
  setVapidDetailsMock,
} = vi.hoisted(() => ({
  fetchTipEventsSinceMock: vi.fn(),
  getSubscriptionsForWalletMock: vi.fn(),
  removeSubscriptionMock: vi.fn(async () => undefined),
  getCursorMock: vi.fn(async () => null),
  setCursorMock: vi.fn(async () => undefined),
  isEventSeenMock: vi.fn(async () => false),
  markEventSeenMock: vi.fn(async () => undefined),
  reverseHandlesMock: vi.fn(async () => ({})),
  sendNotificationMock: vi.fn(async () => undefined),
  setVapidDetailsMock: vi.fn(),
}));

vi.mock('@/lib/events', () => ({
  fetchTipEventsSince: fetchTipEventsSinceMock,
}));

vi.mock('@/lib/push-store', () => ({
  getSubscriptionsForWallet: getSubscriptionsForWalletMock,
  removeSubscription: removeSubscriptionMock,
  getCursor: getCursorMock,
  setCursor: setCursorMock,
  isEventSeen: isEventSeenMock,
  markEventSeen: markEventSeenMock,
}));

vi.mock('@/lib/registry', () => ({
  reverseHandles: reverseHandlesMock,
}));

vi.mock('web-push', () => ({
  default: { setVapidDetails: setVapidDetailsMock, sendNotification: sendNotificationMock },
  setVapidDetails: setVapidDetailsMock,
  sendNotification: sendNotificationMock,
}));

import { GET } from './route';

// ── Helpers ────────────────────────────────────────────────────────────────
const FROM = 'G'.padEnd(56, 'F');
const TO = 'G'.padEnd(56, 'T');

/** Minimal NextRequest stand-in — the handler only reads headers. */
function makeReq(auth?: string): Parameters<typeof GET>[0] {
  return {
    headers: { get: (name: string) => (name === 'authorization' ? auth ?? null : null) },
  } as unknown as Parameters<typeof GET>[0];
}

/** One decoded `tipped` event, shaped as fetchTipEventsSince returns it. */
function tipEvent(id: string, from: string, to: string, amount: bigint, ledger = 100) {
  return { id, topics: ['tipped', from, to], data: amount, ledger };
}

/** A StoredSubscription-shaped record, as the store would return it. */
function sub(endpoint: string, wallet: string) {
  return {
    endpoint,
    subscription: { endpoint } as PushSubscriptionJSON,
    walletAddress: wallet,
    vouchIds: [],
    updatedAt: 0,
  };
}

const CRON_AUTH = 'Bearer test-secret';

// ── Test environment setup ────────────────────────────────────────────────
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('CRON_SECRET', 'test-secret');
  vi.stubEnv('VAPID_SUBJECT', 'mailto:test@test');
  vi.stubEnv('VAPID_PUBLIC_KEY', 'pub');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'priv');

  fetchTipEventsSinceMock.mockReset();
  getSubscriptionsForWalletMock.mockReset();
  removeSubscriptionMock.mockReset().mockResolvedValue(undefined);
  getCursorMock.mockReset().mockResolvedValue(null);
  setCursorMock.mockReset().mockResolvedValue(undefined);
  isEventSeenMock.mockReset().mockResolvedValue(false);
  markEventSeenMock.mockReset().mockResolvedValue(undefined);
  reverseHandlesMock.mockReset().mockResolvedValue({});
  sendNotificationMock.mockReset().mockResolvedValue(undefined);
  setVapidDetailsMock.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────
describe('GET /api/cron/notify — auth', () => {
  it('503 when CRON_SECRET is not configured', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('VAPID_SUBJECT', 'mailto:t');
    vi.stubEnv('VAPID_PUBLIC_KEY', 'p');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'k');
    const res = await GET(makeReq(CRON_AUTH));
    expect(res.status).toBe(503);
  });

  it('401 when the Authorization header is missing', async () => {
    const res = await GET(makeReq(undefined));
    expect(res.status).toBe(401);
  });

  it('401 when the Authorization header is wrong', async () => {
    const res = await GET(makeReq('Bearer wrong'));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/cron/notify — VAPID missing', () => {
  it('returns { ok: true, skipped: true } and does not call RPC', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('CRON_SECRET', 'test-secret');
    // VAPID vars deliberately unset.
    const res = await GET(makeReq(CRON_AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: 0, skipped: true });
    expect(fetchTipEventsSinceMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/notify — happy path', () => {
  it('sends one push per tipped event to the recipient’s subscriptions', async () => {
    fetchTipEventsSinceMock.mockResolvedValueOnce({
      events: [tipEvent('e1', FROM, TO, 2_0000000n)],
      cursor: 'cur1',
    });
    getSubscriptionsForWalletMock.mockResolvedValueOnce([sub('https://push.example/a', TO)]);
    reverseHandlesMock.mockResolvedValueOnce({ [FROM]: 'alice' });

    const res = await GET(makeReq(CRON_AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processed: 1, sent: 1 });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);

    // Payload carries the url and a decoded USDC amount.
    const payload = JSON.parse((sendNotificationMock.mock.calls[0] as unknown[])[1] as string);
    expect(payload.url).toBe('/app');
    expect(payload.body).toContain('@alice');
    expect(payload.body).toContain('2 USDC');

    // Cursor advanced, seen-marked.
    expect(markEventSeenMock).toHaveBeenCalledWith('e1');
    expect(setCursorMock).toHaveBeenCalledWith('cur1');
  });

  it('counts but does not send when the recipient has no subscriptions', async () => {
    fetchTipEventsSinceMock.mockResolvedValueOnce({
      events: [tipEvent('e1', FROM, TO, 1_0000000n)],
      cursor: 'cur1',
    });
    getSubscriptionsForWalletMock.mockResolvedValueOnce([]);

    const res = await GET(makeReq(CRON_AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processed: 1, sent: 0 });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('skips an event already seen and does not double-send', async () => {
    fetchTipEventsSinceMock.mockResolvedValueOnce({
      events: [tipEvent('e1', FROM, TO, 1_0000000n)],
      cursor: 'cur1',
    });
    isEventSeenMock.mockResolvedValueOnce(true);

    const res = await GET(makeReq(CRON_AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processed: 1, sent: 0 });
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(getSubscriptionsForWalletMock).not.toHaveBeenCalled();
  });

  it('skips a malformed event without throwing', async () => {
    fetchTipEventsSinceMock.mockResolvedValueOnce({
      // topics wrong shape, data not bigint
      events: [{ id: 'bad', topics: ['tipped'], data: 'nope', ledger: 1 }],
      cursor: 'cur1',
    });

    const res = await GET(makeReq(CRON_AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processed: 1, sent: 0 });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('prunes a 410 subscription and does not fail the whole event', async () => {
    fetchTipEventsSinceMock.mockResolvedValueOnce({
      events: [tipEvent('e1', FROM, TO, 1_0000000n)],
      cursor: 'cur1',
    });
    getSubscriptionsForWalletMock.mockResolvedValueOnce([sub('https://push.example/dead', TO)]);
    sendNotificationMock.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));

    const res = await GET(makeReq(CRON_AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processed: 1, sent: 0 });
    expect(removeSubscriptionMock).toHaveBeenCalledWith('https://push.example/dead');
  });

  it('stops and does not advance the cursor on a hard send failure', async () => {
    fetchTipEventsSinceMock.mockResolvedValueOnce({
      events: [tipEvent('e1', FROM, TO, 1_0000000n)],
      cursor: 'cur1',
    });
    getSubscriptionsForWalletMock.mockResolvedValueOnce([sub('https://push.example/x', TO)]);
    sendNotificationMock.mockRejectedValueOnce(new Error('boom'));

    const res = await GET(makeReq(CRON_AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('send failed');
    expect(markEventSeenMock).not.toHaveBeenCalled();
    expect(setCursorMock).not.toHaveBeenCalledWith('cur1');
  });

  it('returns zero-work shape when no events came back', async () => {
    fetchTipEventsSinceMock.mockResolvedValueOnce({ events: [], cursor: 'cur1' });

    const res = await GET(makeReq(CRON_AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processed: 0, sent: 0 });
    // Cursor still advances even on an empty batch.
    expect(setCursorMock).toHaveBeenCalledWith('cur1');
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});
